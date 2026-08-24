/**
 * READ-ONLY parameter sweep over `defaultMaxHoldDays`, to test the one finding poof's own
 * attribution pass produced: max-holding-period exits were its largest loss cluster.
 *
 * METHOD, and why it is built this way:
 *  - Reports ALPHA vs SPY, not raw return. With one buy-and-hold signal per ticker, a longer
 *    max-hold is arithmetically closer to buy-and-hold, so in a rising market "longer is better"
 *    is guaranteed and measures market drift rather than the rule. Alpha controls for that.
 *  - Runs SEVERAL non-overlapping windows and prints SPY's own return for each, so a result that
 *    only holds in up markets is visible as such rather than mistaken for a general truth.
 *  - Prints the WHOLE curve. Picking the best value from a sweep is textbook backtest overfitting
 *    (the deflated-Sharpe problem): with enough trials a good number appears by chance. The only
 *    conclusion worth acting on here is a consistent DIRECTION or a broad plateau across windows.
 *
 * Never touches Convex or the broker.
 */
import { tiingoFromEnv } from "../agent/lib/tiingo.ts";
import { runBacktest, type Signal } from "../agent/lib/backtest.ts";
import { DEFAULT_EXITS } from "../agent/lib/exits.ts";
import type { Candle } from "../agent/lib/data.ts";

/** The names poof actually trades, so the sweep is about this strategy and not a random basket. */
const TICKERS = ["CRM", "NOW", "ORCL", "AMZN", "PYPL", "KO", "SBUX", "COP", "LNG", "OXY"];
const SPY = "SPY";

/** Non-overlapping windows, deliberately spanning different market conditions. */
const WINDOWS: { label: string; from: string; to: string }[] = [
  { label: "2024-H1", from: "2024-01-02", to: "2024-06-28" },
  { label: "2024-H2", from: "2024-07-01", to: "2024-12-31" },
  { label: "2025-H1", from: "2025-01-02", to: "2025-06-30" },
  { label: "2025-H2", from: "2025-07-01", to: "2025-12-31" },
];

/** Current production value is 10. A very large value stands in for "no time limit". */
const MAX_HOLD_VALUES = [5, 10, 15, 20, 30, 60, 9999];

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
/** alphaPct is already in percentage POINTS, so it must not be scaled again. */
const pp = (x: number) => `${x.toFixed(2)}pp`;

async function main(): Promise<void> {
  const tiingo = tiingoFromEnv(); // throws if TIINGO_API_KEY is unset

  console.log(`Sweeping defaultMaxHoldDays over ${WINDOWS.length} windows.`);
  console.log(`Basket: ${TICKERS.join(", ")}\n`);

  // alpha[maxHold][window]
  const table = new Map<number, Map<string, { alpha: number; dd: number; closed: number; byReason: Record<string, number> }>>();
  for (const v of MAX_HOLD_VALUES) table.set(v, new Map());
  const spyReturn = new Map<string, number>();

  for (const w of WINDOWS) {
    const series: Record<string, Candle[]> = {};
    for (const t of TICKERS) {
      try {
        const candles = await tiingo.getCandles(t, w.from, w.to);
        if (candles.length > 0) series[t] = candles;
      } catch (err) {
        console.warn(`  skip ${t} in ${w.label}: ${String(err).slice(0, 80)}`);
      }
    }
    const spySeries = await tiingo.getCandles(SPY, w.from, w.to);
    if (spySeries.length === 0) {
      console.warn(`  no SPY data for ${w.label}; skipping window`);
      continue;
    }
    const first = spySeries[0]?.close ?? 0;
    const last = spySeries[spySeries.length - 1]?.close ?? 0;
    spyReturn.set(w.label, first > 0 ? last / first - 1 : 0);

    // One entry signal per ticker on the first session, exactly as the live CLI does.
    const signals: Signal[] = Object.entries(series)
      .map(([ticker, candles]) => {
        const date = candles[0]?.date;
        return date ? { ticker, date } : null;
      })
      .filter((s): s is Signal => s !== null);

    for (const maxHold of MAX_HOLD_VALUES) {
      const result = runBacktest(series, signals, {
        startingEquity: 250,
        spySeries,
        exits: { ...DEFAULT_EXITS, defaultMaxHoldDays: maxHold },
      });
      const alphaPct = result.alphaVsSpy.alphaPct;
      if (typeof alphaPct !== "number" || Number.isNaN(alphaPct)) {
        throw new Error(
          `alphaPct missing for maxHold=${maxHold} ${w.label}. Refusing to report a metric that ` +
            "did not compute: a zero-filled table reads like a finding.",
        );
      }
      // WHICH rule ended each trade is the actual question. The live attribution pass flagged
      // max-hold exits as its largest loss cluster, so a sweep that cannot see exit reasons cannot
      // confirm or refute it.
      const byReason: Record<string, number> = {};
      for (const t of result.trades) {
        if (t.exitReason === null) continue;
        byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;
      }
      table.get(maxHold)?.set(w.label, {
        alpha: alphaPct,
        dd: result.maxDrawdown,
        closed: result.trades.filter((t) => t.exitDate !== null).length,
        byReason,
      });
    }
    console.log(`  ${w.label}: SPY ${pct(spyReturn.get(w.label) ?? 0)}, ${signals.length} names`);
  }

  const labels = WINDOWS.map((w) => w.label).filter((l) => spyReturn.has(l));

  console.log("\n=== ALPHA vs SPY by maxHoldDays (the number that controls for drift) ===");
  console.log(["maxHold".padEnd(9), ...labels.map((l) => l.padStart(10))].join(""), "  mean");
  for (const v of MAX_HOLD_VALUES) {
    const row = labels.map((l) => table.get(v)?.get(l)?.alpha ?? 0);
    const mean = row.reduce((a, b) => a + b, 0) / (row.length || 1);
    const tag = v === 10 ? " <- CURRENT" : v === 9999 ? " (no limit)" : "";
    console.log(
      [String(v).padEnd(9), ...row.map((a) => pp(a).padStart(10))].join(""),
      ` ${pp(mean).padStart(8)}${tag}`,
    );
  }

  console.log("\n=== MAX DRAWDOWN (a better alpha bought with much more risk is not better) ===");
  console.log(["maxHold".padEnd(9), ...labels.map((l) => l.padStart(10))].join(""));
  for (const v of MAX_HOLD_VALUES) {
    const row = labels.map((l) => table.get(v)?.get(l)?.dd ?? 0);
    console.log([String(v).padEnd(9), ...row.map((d) => pct(d).padStart(10))].join(""));
  }

  console.log("\n=== EXIT REASON MIX, summed across windows (does max-hold even BIND?) ===");
  for (const v of MAX_HOLD_VALUES) {
    const totals: Record<string, number> = {};
    for (const l of labels) {
      for (const [reason, n] of Object.entries(table.get(v)?.get(l)?.byReason ?? {})) {
        totals[reason] = (totals[reason] ?? 0) + n;
      }
    }
    const parts = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r}=${n}`);
    console.log(String(v).padEnd(9), parts.join("  ") || "(none closed)");
  }

  console.log(
    "\nRead the DIRECTION and the spread across windows, not the best cell. A single winning" +
      "\nvalue on four windows is noise; a monotone trend or a broad plateau is signal.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
