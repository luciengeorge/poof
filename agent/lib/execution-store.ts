import type { Env } from "./memory.ts";
export interface ExecutionIdentity { env: Env; account: string; owner: string }
export interface ExecutionLease extends ExecutionIdentity { generation: number }
export interface ExecutionStore {
  claim(identity: ExecutionIdentity): Promise<{ generation: number }>;
  begin(args: ExecutionLease & { key: string; kind: "read" | "write"; ticker: string; quantity: number; entryLimit: number }): Promise<{ operationId: string; leaseUntil: number }>;
  settle(args: ExecutionLease & { operationId: string; outcome: "read-completed" | "read-failed" | "not-sent" | "filled" | "rejected" | "pending" | "unknown";
    brokerOrderId?: number; retryableRejection?: boolean }): Promise<unknown>;
  resolve(args: { env: Env; account: string; evidenceId: string }): Promise<{ classification: "filled" | "rejected"; filledQuantity: number }>;
  release(identity: ExecutionIdentity): Promise<boolean>;
  drain(args: { env: Env; account: string; draining: boolean }): Promise<unknown>;
  status(args: { env: Env; account: string }): Promise<{ unresolvedWrite: boolean; inventoryInitialized: boolean }>;
}
export function createExecutionStore(query: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  mutate: (name: string, args: Record<string, unknown>) => Promise<unknown>): ExecutionStore {
  return {
    claim: args => mutate("claim", { ...args }) as ReturnType<ExecutionStore["claim"]>,
    begin: args => mutate("begin", { ...args }) as ReturnType<ExecutionStore["begin"]>,
    settle: args => mutate("settle", { ...args }),
    resolve: args => mutate("resolve", { ...args }) as ReturnType<ExecutionStore["resolve"]>,
    release: args => mutate("release", { ...args }) as Promise<boolean>,
    drain: args => mutate("drain", args), status: args => query("status", args) as ReturnType<ExecutionStore["status"]>,
  };
}
