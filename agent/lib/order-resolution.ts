import { randomUUID } from "node:crypto";
import { reconcileExecution, type BrokerGet } from "./reconcile-execution.ts";
import { sleep } from "./http-backoff.ts";
import type { Env } from "./memory.ts";
import type { ExecutionLease, ExecutionStore } from "./execution-store.ts";
import type { ReconciliationStore } from "./reconciliation-store.ts";
import type { InventoryStore } from "./inventory-store.ts";

export interface ResolutionStores { coordination: ExecutionStore; reconciliation: ReconciliationStore; inventory: InventoryStore }
export interface ResolveOrderArgs {
  env: Env; account: string; stores: ResolutionStores; get: BrokerGet; signal?: AbortSignal;
  /** Present when the sending owner still holds its lease; omitted when recovering an older fence. */
  handoff?: ExecutionLease;
  /** Only the call that sent the order (which returns it to trade bookkeeping) or an operator who has
   * fixed that bookkeeping may release a filled order. Anyone else may release only a zero-fill end. */
  acceptFilled: boolean;
  attempts?: number; delayMs?: number; wait?: (ms: number) => Promise<void>;
}

/** Reads the broker until a fenced order is provably terminal, books the sealed fills into the
 * isolated ledger, then releases the fence. Anything short of that leaves the account fenced. */
export async function resolveFencedOrder(args: ResolveOrderArgs): Promise<{ classification: "filled" | "rejected"; filledQuantity: number }> {
  const { env, account, stores } = args;
  const attempts = args.attempts ?? 4, delayMs = args.delayMs ?? 6_000, wait = args.wait ?? sleep;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // The order and portfolio endpoints allow roughly one read per five seconds, and the caller
    // usually read both just before sending.
    if (args.handoff || attempt) await wait(delayMs);
    args.signal?.throwIfAborted();
    const evidence = await reconcileExecution({ identity: { env, account, owner: `reconcile/${randomUUID()}` },
      store: stores.reconciliation, get: args.get, signal: args.signal,
      ...(attempt === 0 && args.handoff ? { handoff: { owner: args.handoff.owner, generation: args.handoff.generation } } : {}) });
    if (evidence.reason === "matched-history" && evidence.historyComplete &&
        (evidence.classification === "filled" || evidence.classification === "rejected")) {
      if (evidence.classification === "filled" && !args.acceptFilled)
        throw new Error("Filled order never reached trade bookkeeping; account stays fenced for manual audit");
      await stores.inventory.apply({ env, account, evidenceId: evidence.receiptId });
      return stores.coordination.resolve({ env, account, evidenceId: evidence.receiptId });
    }
    const settling = evidence.classification === "pending" ||
      (evidence.classification === "unknown" && (evidence.reason === "not-found" || evidence.reason === "history-incomplete"));
    if (!settling) break;
  }
  throw new Error("Broker order not reconciled; account stays fenced and automatic orders are blocked");
}
