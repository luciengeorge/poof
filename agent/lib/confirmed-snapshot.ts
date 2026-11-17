import type { BrokerAccountSnapshot } from "./t212.ts";
import type { Env, Memory } from "./memory.ts";

/** Reuses an already completed broker read. Failure is isolated from the trading path. */
export async function publishConfirmedSnapshot(account: BrokerAccountSnapshot, env: Env,
  writer: Pick<Memory, "recordConfirmedSnapshot">, simulated: boolean): Promise<void> {
  if (simulated) return;
  try {
    await writer.recordConfirmedSnapshot({ env, observedAt: account.positionsReadAt,
      positions: account.positions.map(({ ticker, quantity, averagePrice, currentPrice }) =>
        ({ ticker, quantity, averagePrice, currentPrice })) });
  } catch {
    console.warn("[observation] confirmed snapshot unavailable");
  }
}
