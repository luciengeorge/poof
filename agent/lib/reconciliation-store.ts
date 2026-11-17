import type { ExecutionIdentity, ExecutionLease, ExecutionStore } from "./execution-store.ts";
import type { BrokerFill } from "./inventory-store.ts";

export interface FencedOrder { operationId: string; brokerOrderId: number; ticker: string; quantity: number; startedAt: number }
export interface OrderEvidence {
  classification: "pending" | "partial" | "filled" | "rejected" | "unknown";
  filledQuantity?: number; positionQuantity?: number; historyComplete: boolean; matchedFillCount: number;
  reason: "pending-order" | "matched-history" | "not-found" | "order-mismatch" | "invalid-response" | "history-incomplete";
}
export type ReconciliationLease = ExecutionLease & { operationId: string };
export interface ReconciliationStore {
  claim(identity: ExecutionIdentity & { handoff?: { owner: string; generation: number } }): Promise<FencedOrder & { generation: number }>;
  begin(args: ReconciliationLease & { kind: "pending" | "history" | "portfolio"; cursor?: number }): Promise<{ readId: string; path: string; leaseUntil: number }>;
  settle: ExecutionStore["settle"];
  finish(args: ReconciliationLease & { observedAt: number; evidence: OrderEvidence; fills?: BrokerFill[] }): Promise<{ receiptId: string; canClearFence: false }>;
}
export function createReconciliationStore(mutate: (namespace: string, name: string, args: Record<string, unknown>) => Promise<unknown>): ReconciliationStore {
  return {
    claim: args => mutate("executionReconciliation", "claim", { ...args }) as ReturnType<ReconciliationStore["claim"]>,
    begin: args => mutate("executionReconciliation", "begin", { ...args }) as ReturnType<ReconciliationStore["begin"]>,
    settle: args => mutate("executionCoordination", "settle", { ...args }),
    finish: args => mutate("executionReconciliation", "finish", { ...args }) as ReturnType<ReconciliationStore["finish"]>,
  };
}
