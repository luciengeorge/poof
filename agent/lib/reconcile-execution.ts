import { classifyOrderEvidence, nextHistoryCursor } from "./order-evidence.ts";
import { retryDelayMs, sleep } from "./http-backoff.ts";
import type { ExecutionIdentity } from "./execution-store.ts";
import type { OrderEvidence, ReconciliationLease, ReconciliationStore } from "./reconciliation-store.ts";
import { brokerFillProofs } from "./broker-fill-proofs.ts";

const hosts = { demo: "https://demo.trading212.com/api/v0", live: "https://live.trading212.com/api/v0" };
export interface ReconciliationConfig {
  identity: ExecutionIdentity; store: ReconciliationStore; apiKey: string; apiSecret: string;
  fetchImpl?: typeof fetch; signal?: AbortSignal;
}

/** Operator-only, bounded GET plan. There is no order method or fence-clear capability. */
export async function reconcileExecution(cfg: ReconciliationConfig): Promise<OrderEvidence & { canClearFence: false }> {
  const order = await cfg.store.claim(cfg.identity); // Never touch the broker without durable admission.
  const lease: ReconciliationLease = { ...cfg.identity, generation: order.generation, operationId: order.operationId };
  const send = cfg.fetchImpl ?? fetch;
  const auth = "Basic " + Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString("base64");
  async function read(kind: "pending" | "history" | "portfolio", cursor?: number): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      cfg.signal?.throwIfAborted();
      const admitted = await cfg.store.begin({ ...lease, kind, ...(cursor === undefined ? {} : { cursor }) });
      const settle = (outcome: "read-completed" | "read-failed") => cfg.store.settle({ ...lease, operationId: admitted.readId, outcome });
      if (cfg.signal?.aborted || Date.now() >= admitted.leaseUntil) {
        await settle("read-failed");
        throw new Error("Reconciliation read not sent: admission expired or cancelled");
      }
      const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(cfg.signal ? [cfg.signal] : [])]);
      let response: Response, text: string;
      try {
        response = await send(hosts[cfg.identity.env] + admitted.path, { method: "GET", headers: { Authorization: auth }, signal });
        text = await response.text();
      } catch {
        await settle("read-failed").catch(() => {});
        throw new Error("Reconciliation broker read unavailable");
      }
      if (!response.ok) {
        await settle("read-failed");
        if (response.status === 429 && attempt < 3) { await sleep(retryDelayMs(response.headers, attempt)); continue; }
        // 404/empty history never proves a POST did not send.
        throw new Error("Reconciliation broker read refused");
      }
      let data: unknown;
      try {
        if (text.length > 1_000_000) throw new Error("oversized");
        data = JSON.parse(text);
      } catch {
        await settle("read-failed");
        throw new Error("Invalid reconciliation broker response");
      }
      await settle("read-completed"); // A stale/abandoned GET must not return its result.
      return data;
    }
  }

  const pending = await read("pending");
  if (!Array.isArray(pending) || pending.length > 128 || pending.some(o => !o || typeof o !== "object" || !Number.isSafeInteger(o.id)))
    throw new Error("Invalid reconciliation pending response");
  const rows: unknown[] = [];
  let historyComplete = false;
  let cursor: number | undefined;
  const seen = new Set<number>();
  const isActive = Array.isArray(pending) && pending.some(o => o !== null && typeof o === "object" && o.id === order.brokerOrderId);
  if (!isActive) for (let page = 0; page < 3; page++) {
    const result = await read("history", cursor);
    if (!result || typeof result !== "object" || !("items" in result) || !Array.isArray(result.items) || result.items.length > 50)
      throw new Error("Invalid reconciliation history response");
    rows.push(...result.items);
    const path = "nextPagePath" in result ? result.nextPagePath : undefined;
    if (path === null || path === "") { historyComplete = true; break; }
    if (path === undefined) break; // Missing pagination metadata does not prove completeness.
    const next = nextHistoryCursor(path, order.ticker);
    if (next === null || seen.has(next)) break; // Invalid/cyclic/truncated pagination remains incomplete.
    seen.add(next); cursor = next;
  }
  const portfolio = await read("portfolio");
  const evidence = classifyOrderEvidence(order, pending, rows, historyComplete, portfolio);
  const observedAt = Date.now();
  const fills = brokerFillProofs(order, rows, evidence, observedAt);
  await cfg.store.finish({ ...lease, observedAt, evidence, ...(fills === undefined ? {} : { fills }) });
  return { ...evidence, canClearFence: false };
}
