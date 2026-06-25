import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { evaluateAndExecute, type Proposal } from "../lib/orders.ts";
import { resolveLimits, fxRateFromEnv, isDryRun } from "../lib/state.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { resolveRiskState, tradingEnv } from "../lib/risk-runtime.ts";
import { checkExits, DEFAULT_EXITS } from "../lib/exits.ts";
import {
  buildManagedPositions,
  orphanedOpenBuys,
  type OpenBuyTrade,
} from "../lib/positions.ts";

export default defineTool({
  description:
    "Enforce exit rules on open positions: sells any whose stop-loss, take-profit, or max-hold has triggered (mechanical — not a judgement call). Call this EARLY each cycle, before looking for new entries. SELLs are allowed even when trading is halted (de-risking is always permitted). Honors DRY_RUN. Returns the exits triggered and what was placed.",
  inputSchema: z.object({}),
  async execute() {
    const client = t212FromEnv();
    const fxRate = fxRateFromEnv();
    const dryRun = isDryRun();
    const positions = await client.getPortfolio();

    const memory = memoryFromEnv();
    const openBuys = ((await memory.openBuys(tradingEnv())) ?? []) as OpenBuyTrade[];

    const managed = buildManagedPositions(positions, openBuys, fxRate);
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
            fxRate,
            dryRun,
            resolveRiskState,
            limits: resolveLimits(),
          })
        : { placed: [], rejected: [] };

    // Record realized P&L + close the originating BUY for each exit actually executed.
    try {
      await Promise.all(
        result.placed
          .filter((p) => !p.skipped)
          .map((p) => {
            const m = byTicker.get(p.proposal.ticker);
            if (!m?.tradeId) return Promise.resolve();
            return memory.closeTrade({
              tradeId: m.tradeId,
              pnl: m.unrealizedPnl,
              exitPrice: m.currentPrice,
            });
          }),
      );
      // Reconcile: BUYs whose position is no longer held were closed elsewhere.
      const orphans = orphanedOpenBuys(openBuys, positions);
      await Promise.all(
        orphans.map((o) => memory.closeTrade({ tradeId: o._id, pnl: 0 })),
      );
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
