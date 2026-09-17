/**
 * READ-ONLY parameter sweep over per-trade notional, to test the finding from seven weeks live:
 * the closed trades had positive expectancy (+0.8% mean) while the account went nowhere, because
 * the median order was 10 GBP on a 250 GBP account.
 *
 * METHOD, same discipline as sweep-maxhold.ts:
 *  - Alpha vs SPY, not raw return, so market drift is controlled for.
 *  - Several non-overlapping windows, SPY's own return printed per window.
 *  - The whole curve, never the best cell.
 *
 * What this can and cannot show. The backtest sizes every entry at one notional and buys until
 * cash runs out, so at 250 GBP a 56 GBP size fills about four names and a 10 GBP size fills all
 * ten: concentration falls out of affordability, which is the live mechanism too. Gross alpha
 * scales roughly linearly with size by construction; the questions worth reading are whether the
 * 0.3% FX round trip changes the sign at small sizes, and what concentration does to drawdown.
 *
 * Never touches Convex or the broker.
 */
import { tiingoFromEnv } from "../agent/lib/tiingo.ts";
import { runBacktest, type Signal } from "../agent/lib/backtest.ts";
import { DEFAULT_EXITS } from "../agent/lib/exits.ts";
import type { Candle } from "../agent/lib/data.ts";

const TICKERS = ["CRM", "NOW", "ORCL", "AMZN", "PYPL", "KO", "SBUX", "COP", "LNG", "OXY"];
const SPY = "SPY";
const STARTING_EQUITY = 250;

const WINDOWS: { label: string; from: string; to: string }[] = [
  { label: "2024-H1", from: "2024-01-02", to: "2024-06-28" },
  { label: "2024-H2", from: "2024-07-01", to: "2024-12-31" },
  { label: "2025-H1", from: "2025-01-02", to: "2025-06-30" },
  { label: "2025-H2", from: "2025-07-01", to: "2025-12-31" },
];

/** 10 is the live median. 37.5 and 75 are the new 15% floor and 30% cap. */
const NOTIONALS = [10, 25, 37.5, 56, 75];

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const pp = (x: number) => `${x.toFixed(2)}pp`;

interface Cell {
  alpha: number;
  dd: number;
  opened: number;
  byReason: Record<string, number>;
}

async function main(): Promise<void> {
  const tiingo = tiingoFromEnv();
  console.log(`Sweeping per-trade notional at ${STARTING_EQUITY} GBP equity over ${WINDOWS.length} windows.`);
  console.log(`Basket: ${TICKERS.join(", ")}\n`);

  const table = new Map<number, Map<string, Cell>>();
  for (const n of NOTIONALS) table.set(n, new Map());
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

    const signals: Signal[] = Object.entries(series)
      .map(([ticker, candles]) => {
        const date = candles[0]?.date;
        return date ? { ticker, date } : null;
      })
      .filter((s): s is Signal => s !== null);

    for (const notional of NOTIONALS) {
      const result = runBacktest(series, signals, {
        startingEquity: STARTING_EQUITY,
        defaultNotional: notional,
        spySeries,
        exits: DEFAULT_EXITS,
      });
      const alphaPct = result.alphaVsSpy.alphaPct;
      if (typeof alphaPct !== "number" || Number.isNaN(alphaPct)) {
        throw new Error(
          `alphaPct missing for notional=${notional} ${w.label}. Refusing to report a metric that ` +
            "did not compute: a zero-filled table reads like a finding.",
        );
      }
      const byReason: Record<string, number> = {};
      for (const t of result.trades) {
        if (t.exitReason === null) continue;
        byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;
      }
      table.get(notional)?.set(w.label, {
        alpha: alphaPct,
        dd: result.maxDrawdown,
        opened: result.trades.length,
        byReason,
      });
    }
    console.log(`  ${w.label}: SPY ${pct(spyReturn.get(w.label) ?? 0)}, ${signals.length} names`);
  }

  const labels = WINDOWS.map((w) => w.label).filter((l) => spyReturn.has(l));

  console.log("\n=== ALPHA vs SPY by per-trade notional (GBP) ===");
  console.log(["notional".padEnd(10), ...labels.map((l) => l.padStart(10))].join(""), "  mean");
  for (const n of NOTIONALS) {
    const row = labels.map((l) => table.get(n)?.get(l)?.alpha ?? 0);
    const mean = row.reduce((a, b) => a + b, 0) / (row.length || 1);
    const tag = n === 10 ? " <- LIVE MEDIAN" : n === 37.5 ? " <- new floor" : n === 75 ? " <- cap" : "";
    console.log(
      [String(n).padEnd(10), ...row.map((a) => pp(a).padStart(10))].join(""),
      ` ${pp(mean).padStart(8)}${tag}`,
    );
  }

  console.log("\n=== MAX DRAWDOWN (concentration's price) ===");
  console.log(["notional".padEnd(10), ...labels.map((l) => l.padStart(10))].join(""));
  for (const n of NOTIONALS) {
    const row = labels.map((l) => table.get(n)?.get(l)?.dd ?? 0);
    console.log([String(n).padEnd(10), ...row.map((d) => pct(d).padStart(10))].join(""));
  }

  console.log("\n=== POSITIONS OPENED per window (how many names the cash affords) ===");
  console.log(["notional".padEnd(10), ...labels.map((l) => l.padStart(10))].join(""));
  for (const n of NOTIONALS) {
    const row = labels.map((l) => table.get(n)?.get(l)?.opened ?? 0);
    console.log([String(n).padEnd(10), ...row.map((c) => String(c).padStart(10))].join(""));
  }

  console.log(
    "\nRead the direction and the drawdown together. Bigger is not a finding; bigger with a" +
      "\ndrawdown the breakers can live with is.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
