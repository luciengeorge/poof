/**
 * Runtime glue shared by the order tools: resolve the durable cross-cycle risk state
 * (load from Convex -> derive day-rollover/peak/halt -> persist) and expose it as the
 * `resolveRiskState` callback `evaluateAndExecute` expects. Best-effort: if memory is
 * unavailable, fall back to a neutral state (no halt) so trading is never blocked.
 *
 * That fallback is fail-OPEN by design: a Convex outage or transient error must not be
 * able to halt live trading (e.g. block SELLs/stop-losses) just because the risk-state
 * read/write failed. The tradeoff is that a real breach (drawdown/daily-loss/consecutive-
 * loss) will not be enforced during an outage window either. This is a conscious choice,
 * not a latent surprise.
 */
import { checkHalt } from "./risk.ts";
import {
  deriveRiskState,
  loadRiskState,
  resolveLimits,
  type RiskState,
  type StoredRiskState,
} from "./state.ts";
import { etDateString } from "./clock.ts";
import { memoryFromEnv, type Env } from "./memory.ts";

export const tradingEnv = (): Env =>
  (process.env.TRADING212_ENV ?? "demo") as Env;

export async function resolveRiskState(
  currentEquity: number,
  memory = memoryFromEnv(),
): Promise<RiskState> {
  try {
    const stored = (await memory.getRiskState(tradingEnv())) as StoredRiskState | null;
    const derived = deriveRiskState(stored, currentEquity, etDateString(new Date()));
    const halt = checkHalt(
      { equity: currentEquity, cash: 0, positions: [], ...derived.fields },
      resolveLimits(),
    );
    await memory.saveRiskState({
      env: tradingEnv(),
      ...derived.persist,
      haltState: halt.halted
        ? halt.manualResumeRequired
          ? "circuit"
          : "daily"
        : "none",
    });
    return derived.fields;
  } catch (err) {
    console.warn(
      "[memory] risk-state resolve failed; using neutral state (no halt):",
      err,
    );
    return loadRiskState();
  }
}
