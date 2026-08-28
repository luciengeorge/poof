import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { evaluateAndExecute, type Proposal } from "../lib/orders.ts";
import { resolveLimits, isDryRun } from "../lib/state.ts";
import { fxForCycle } from "../lib/fx.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { resolveRiskState, tradingEnv } from "../lib/risk-runtime.ts";
import { checkExits, DEFAULT_EXITS } from "../lib/exits.ts";
import {
  buildManagedPositions,
  orphanedOpenBuys,
  type OpenBuyTrade,
} from "../lib/positions.ts";
import {
  buildCloseTradeArgs,
  buildOrphanCloseTradeArgs,
} from "../lib/order-bookkeeping.ts";

export default defineTool({
  description:
    "Enforce exit rules on open positions: sells any whose stop-loss, take-profit, or max-hold has triggered (mechanical, not a judgement call). Call this EARLY each cycle, before looking for new entries. SELLs are allowed even when trading is halted (de-risking is always permitted). Honors DRY_RUN. Returns the exits triggered and what was placed.",
  inputSchema: z.object({}),
  async execute() {
    const client = t212FromEnv();
    const fx = await fxForCycle();
    const fxRate = fx.rate;
    const dryRun = isDryRun();
    const positions = await client.getPortfolio();

    const memory = memoryFromEnv();
    const openBuys = ((await memory.openBuys(tradingEnv())) ?? []) as OpenBuyTrade[];

    // Ratchet each held position's high-water mark up to the latest price, and persist it
    // so the trailing stop is durable across cycles. Best-effort: a memory failure must
    // never block exits (the engine still runs on the in-memory peaks).
    const raw = buildManagedPositions(positions, openBuys, fxRate);
    const managed = raw.map((m) => ({
      ...m,
      peakPrice: Math.max(m.peakPrice ?? m.entryPrice, m.currentPrice),
    }));
    try {
      // Only persist positions that actually made a new high this cycle; an unchanged
      // high-water mark is a no-op, so skip the round-trip entirely.
      await Promise.all(
        raw
          .filter((m) => m.tradeId && m.currentPrice > (m.peakPrice ?? m.entryPrice))
          .map((m) => memory.updatePeak({ tradeId: m.tradeId!, price: m.currentPrice })),
      );
    } catch (err) {
      console.warn("[memory] updatePeak failed (non-fatal):", err);
    }

    // Record the price we can SEE for every position, in one round trip. Unlike updatePeak above
    // this is not filtered to new highs: a position that fell is exactly the one whose outcome is
    // most worth recovering if it later vanishes from the broker. Without this, reconciliation has
    // nothing real to work from and books the trade `closed-unknown`, which silently starves
    // attribution and calibration (3 of 7 closures on 2026-08-10).
    try {
      const entries = raw
        .filter((m) => m.tradeId && Number.isFinite(m.currentPrice) && m.currentPrice > 0)
        .map((m) => ({ tradeId: m.tradeId!, price: m.currentPrice }));
      if (entries.length > 0) await memory.recordObservedPrices(entries);
    } catch (err) {
      console.warn("[memory] recordObservedPrices failed (non-fatal):", err);
    }

    const signals = checkExits(managed, DEFAULT_EXITS, Date.now());

    const byTicker = new Map(managed.map((m) => [m.ticker, m]));
    const proposals: Proposal[] = signals.map((s) => ({
      ticker: s.ticker,
      side: "SELL",
      notional: s.marketValue,
      price: byTicker.get(s.ticker)?.currentPrice ?? 0,
      thesis: `exit: ${s.detail}`,
    }));

    const result =
      proposals.length > 0
        ? await evaluateAndExecute(proposals, {
            client,
            fx,
            dryRun,
            resolveRiskState,
            limits: resolveLimits(),
          })
        : { placed: [], rejected: [] };

    // Record realized P&L + close the originating BUY for each exit actually executed.
    try {
      const closeArgs = buildCloseTradeArgs(result.placed, byTicker);
      await Promise.all(closeArgs.map((a) => memory.closeTrade(a)));
      // Reconcile: BUYs whose position is no longer held were closed elsewhere.
      const orphans = orphanedOpenBuys(openBuys, positions);
      const orphanArgs = buildOrphanCloseTradeArgs(orphans, fxRate);
      await Promise.all(orphanArgs.map((a) => memory.closeTrade(a)));
    } catch (err) {
      console.warn("[memory] closeTrade reconciliation failed (non-fatal):", err);
    }

    return {
      exitsTriggered: signals,
      placed: result.placed,
      rejected: result.rejected,
      dryRun,
      note:
        signals.length === 0 ? "no exit conditions met" : `${signals.length} exit(s)`,
    };
  },
});
