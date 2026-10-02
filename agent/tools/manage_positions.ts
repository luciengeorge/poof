import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv, type T212Client, type T212Position } from "../lib/t212.ts";
import { evaluateAndExecute, type Proposal } from "../lib/orders.ts";
import { resolveLimits, isDryRun } from "../lib/state.ts";
import { fxForCycle } from "../lib/fx.ts";
import { memoryFromEnv, type Env, type Memory } from "../lib/memory.ts";
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
  type CloseTradeArgs,
} from "../lib/order-bookkeeping.ts";
import { isCore } from "../lib/core.ts";
import { alert } from "../lib/alert.ts";
import { etDateString } from "../lib/clock.ts";

/**
 * The positions the exit engine may sell and the open BUYs it may reconcile: never the index core.
 * The core is the account's home for idle money, not a trade, so a 20-day max-hold would sell the
 * index every month and a 10% stop would sell it in every correction. Both lists are filtered, the
 * open BUYs too, so a core row can never be booked as an orphan once its position is filtered out.
 * Exported as the test seam that proves this tool, not just a helper, applies the filter.
 *
 * `rawPositions` is the same read before the filter, for the orphan guard (see orphanedOpenBuys).
 * `pendingTickers` is null when the pending orders could not be read: exits do not need them, so
 * that failure must not stop a stop-loss firing. Reconciliation refuses instead.
 */
export async function loadExitScope(
  client: Pick<T212Client, "getPortfolio" | "getPendingOrders">,
  memory: Pick<Memory, "openBuys">,
  env: Env,
): Promise<{
  positions: T212Position[];
  rawPositions: T212Position[];
  openBuys: OpenBuyTrade[];
  pendingTickers: Set<string> | null;
}> {
  // Pending orders before the portfolio, so a BUY that fills between the two reads is still seen
  // in one of them. The portfolio read is fresh: the client's short cache could predate the
  // pending read, and a BUY filling in that gap would be in neither.
  const pendingTickers = await client
    .getPendingOrders()
    .then((orders) => new Set(orders.map((o) => o.ticker)))
    .catch((err: unknown) => {
      console.warn("[t212] getPendingOrders failed; orphan reconciliation will refuse:", err);
      return null;
    });
  const rawPositions = await client.getPortfolio({ fresh: true });
  const positions = rawPositions.filter((p) => !isCore(p.ticker));
  const openBuys = (((await memory.openBuys(env)) ?? []) as OpenBuyTrade[]).filter(
    (b) => !isCore(b.ticker),
  );
  return { positions, rawPositions, openBuys, pendingTickers };
}

/**
 * The exit path's intent key: one exit per ticker per ET day. The executor's default key carries
 * the notional, and an exit's notional is the live market value, so two runs would never match.
 * Safe because every exit sells the whole position and the cycle runs once a day.
 */
export function exitIntentKey(p: Proposal): string {
  return `${etDateString(new Date())}:${p.ticker}:EXIT`;
}

export type ReconciliationResult =
  | { status: "reconciled"; closed: number }
  | { status: "refused"; reason: string };

/**
 * Book each open BUY the broker no longer holds as closed, or, when the read cannot support that
 * conclusion, close nothing and alert. Exported as the test seam that proves the tool honours a
 * refusal: a unit test of orphanedOpenBuys alone cannot show that the caller does.
 */
export async function reconcileOrphans(args: {
  openBuys: OpenBuyTrade[];
  rawPositions: T212Position[];
  pendingTickers: ReadonlySet<string> | null;
  fxRate: number;
  closeTrade: (a: CloseTradeArgs) => Promise<unknown>;
  alert: (text: string) => Promise<void>;
}): Promise<ReconciliationResult> {
  const result = orphanedOpenBuys(args.openBuys, args.rawPositions, args.pendingTickers);
  if (!result.reconcilable) {
    await args.alert(
      `manage_positions: orphan reconciliation refused, nothing closed: ${result.reason}`,
    );
    return { status: "refused", reason: result.reason };
  }
  const orphanArgs = buildOrphanCloseTradeArgs(result.orphans, args.fxRate);
  await Promise.all(orphanArgs.map((a) => args.closeTrade(a)));
  return { status: "reconciled", closed: orphanArgs.length };
}

export default defineTool({
  description:
    "Enforce exit rules on open positions: sells any whose stop-loss, take-profit, or max-hold has triggered (mechanical, not a judgement call). Call this EARLY each cycle, before looking for new entries. SELLs are allowed even when trading is halted (de-risking is always permitted). Honors DRY_RUN. Returns the exits triggered and what was placed.",
  inputSchema: z.object({}),
  async execute() {
    const client = t212FromEnv();
    const fx = await fxForCycle();
    const fxRate = fx.rate;
    const dryRun = isDryRun();
    const memory = memoryFromEnv();
    const scope = await loadExitScope(client, memory, tradingEnv());
    const { positions, rawPositions, openBuys, pendingTickers } = scope;

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
            hasOrderIntent: (key) => memory.hasOrderIntent(tradingEnv(), key),
            recordOrderIntent: async (key) => {
              await memory.recordOrderIntent(tradingEnv(), key);
            },
            intentKeyOf: exitIntentKey,
          })
        : { placed: [], rejected: [] };

    // Record realized P&L + close the originating BUY for each exit actually executed.
    let reconciliation: ReconciliationResult | undefined;
    try {
      const closeArgs = buildCloseTradeArgs(result.placed, byTicker);
      await Promise.all(closeArgs.map((a) => memory.closeTrade(a)));
      // Reconcile: BUYs whose position is no longer held were closed elsewhere.
      reconciliation = await reconcileOrphans({
        openBuys,
        rawPositions,
        pendingTickers,
        fxRate,
        closeTrade: (a) => memory.closeTrade(a),
        alert,
      });
    } catch (err) {
      console.warn("[memory] closeTrade reconciliation failed (non-fatal):", err);
    }

    return {
      exitsTriggered: signals,
      placed: result.placed,
      rejected: result.rejected,
      reconciliation,
      dryRun,
      note:
        signals.length === 0 ? "no exit conditions met" : `${signals.length} exit(s)`,
    };
  },
});
