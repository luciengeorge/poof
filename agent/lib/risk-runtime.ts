/**
 * Runtime glue shared by the order tools: resolve the durable cross-cycle risk state
 * (load from Convex -> derive day-rollover/peak/halt -> persist) and expose it as the
 * `resolveRiskState` callback `evaluateAndExecute` expects.
 *
 * Fallback policy when the risk state can't be resolved (Convex outage / transient error),
 * split by env and by design:
 *   - live: FAIL-CLOSED. Return a state that trips the risk gate so new BUYs are rejected,
 *     while de-risking SELLs still pass (validateOrders only gates BUYs on a halt). We must
 *     not open new risk with the durable state blind.
 *   - demo (any non-live): FAIL-OPEN. Return the neutral zero state (no halt) so an outage
 *     never blocks demo trading. The tradeoff is that a real breach isn't enforced during
 *     the outage window on demo, which is acceptable because no real money is at stake.
 * This split is a conscious choice, not a latent surprise.
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
    if (tradingEnv() === "live") {
      console.warn(
        "[memory] risk-state resolve failed on LIVE; failing closed (halt new BUYs, allow SELLs):",
        err,
      );
      // Trip checkHalt's consecutive-loss-days circuit breaker so validateOrders rejects
      // BUYs while de-risking SELLs still pass. Derived from resolveLimits() (the same
      // limits the gate uses) rather than a magic number.
      return {
        ...loadRiskState(),
        consecutiveLossDays: resolveLimits().maxConsecutiveLossDays,
      };
    }
    console.warn(
      "[memory] risk-state resolve failed; using neutral state (no halt):",
      err,
    );
    return loadRiskState();
  }
}
