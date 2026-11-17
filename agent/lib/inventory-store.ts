import type { Env } from "./memory.ts";
import type { ExecutionLease } from "./execution-store.ts";
export interface BrokerFill { id: number; quantity: number; price: number; filledAt: number; walletCurrency: "GBP"; realizedPnlGbp: number }
export interface InventoryStore {
  baseline(args: ExecutionLease & { positions: { ticker: string; quantity: number; averagePrice: number }[];
    positionsReadAt: number; pendingReadAt: number; pendingCount: number }): Promise<unknown>;
  apply(args: { env: Env; account: string; evidenceId: string }): Promise<{ receiptId: string; replayed: boolean; appliedFills: number; canClearFence: false }>;
  positions(args: { env: Env; account: string }): Promise<unknown>;
}
export function createInventoryStore(query: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  mutate: (name: string, args: Record<string, unknown>) => Promise<unknown>): InventoryStore {
  return { baseline: args => mutate("baseline", { ...args }),
    apply: args => mutate("apply", args) as ReturnType<InventoryStore["apply"]>, positions: args => query("positions", args) };
}
