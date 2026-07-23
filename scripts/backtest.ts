/**
 * Thin, READ-ONLY backtest CLI. Runs the pure runBacktest engine and prints the metrics. It
 * never touches Convex or the broker. Two modes:
 *
 *   Fixture (offline default): loads candles + signals from a local JSON fixture.
 *     node --experimental-strip-types scripts/backtest.ts [path/to/fixture.json]
 *     With no path it uses scripts/fixtures/backtest-sample.json so it runs out of the box.
 *
 *   Live (Tiingo): fetches real adjusted daily candles for a ticker set + SPY over a date
 *   range. Requires TIINGO_API_KEY in the environment.
 *     node --experimental-strip-types scripts/backtest.ts \
 *       --tickers AAPL,MSFT --spy SPY --from 2024-01-01 --to 2025-01-01
 *   In live mode each ticker gets one buy-and-hold signal on the first --from session, so the
 *   run reports how a naive equal-weight basket would have done vs SPY on real prices.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle } from "../agent/lib/data.ts";
import { tiingoFromEnv } from "../agent/lib/tiingo.ts";
import { runBacktest, type Signal, type BacktestConfig } from "../agent/lib/backtest.ts";

interface Fixture {
  startingEquity: number;
  defaultNotional?: number;
  spreadBps?: number;
  fxBps?: number;
  signals: Signal[];
  priceSeriesByTicker: Record<string, Candle[]>;
  spySeries: Candle[];
}

interface LiveArgs {
  tickers: string[];
  spy: string;
  from: string;
  to: string;
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = argv[i + 1] ?? "";
      i++;
    }
  }
  return flags;
}

function loadFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

/** Build a Fixture by fetching adjusted daily candles for the tickers + SPY from Tiingo. */
async function loadLiveFixture(args: LiveArgs): Promise<Fixture> {
  const provider = tiingoFromEnv();
  const priceSeriesByTicker: Record<string, Candle[]> = {};
  for (const ticker of args.tickers) {
    const series = await provider.getCandles(ticker, args.from, args.to);
    if (series.length === 0) {
      throw new Error(`Tiingo returned no candles for ${ticker} over ${args.from}..${args.to}`);
    }
    priceSeriesByTicker[ticker] = series;
  }
  const spySeries = await provider.getCandles(args.spy, args.from, args.to);
  if (spySeries.length === 0) {
    throw new Error(`Tiingo returned no candles for the SPY benchmark (${args.spy})`);
  }

  // One buy-and-hold signal per ticker on the first available session; the engine fills at the
  // NEXT open, so use each series' first date as the signal date.
  const signals: Signal[] = args.tickers.map((ticker) => ({
    ticker,
    date: priceSeriesByTicker[ticker][0].date,
  }));

  return { startingEquity: 100_000, signals, priceSeriesByTicker, spySeries };
}

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const live = flags.tickers !== undefined;

  let fx: Fixture;
  let source: string;
  if (live) {
    const tickers = flags.tickers
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const spy = flags.spy ?? "SPY";
    const from = flags.from ?? "2024-01-01";
    const to = flags.to ?? "2025-01-01";
    fx = await loadLiveFixture({ tickers, spy, from, to });
    source = `live Tiingo: ${tickers.join(",")} + ${spy} over ${from}..${to}`;
  } else {
    const defaultPath = resolve(import.meta.dirname, "fixtures", "backtest-sample.json");
    const path = process.argv[2] ? resolve(process.argv[2]) : defaultPath;
    fx = loadFixture(path);
    source = path;
  }

  const config: BacktestConfig = {
    startingEquity: fx.startingEquity,
    spySeries: fx.spySeries,
    defaultNotional: fx.defaultNotional,
    spreadBps: fx.spreadBps,
    fxBps: fx.fxBps,
  };
  const result = runBacktest(fx.priceSeriesByTicker, fx.signals, config);

  const startEquity = fx.startingEquity;
  const finalEquity =
    result.equityCurve.length > 0
      ? result.equityCurve[result.equityCurve.length - 1].equity
      : startEquity;
  const netReturnPct = ((finalEquity - startEquity) / startEquity) * 100;
  const closed = result.trades.filter((t) => t.exitDate !== null);
  const openCount = result.trades.length - closed.length;

  console.log(`Backtest source : ${source}`);
  console.log("=".repeat(60));
  console.log(`Starting equity : ${money(startEquity)}`);
  console.log(`Final equity    : ${money(finalEquity)}`);
  console.log(`Net return      : ${pct(netReturnPct)}`);
  console.log(`Realized PnL    : ${money(result.realizedPnl)}`);
  console.log(`Win rate        : ${(result.winRate * 100).toFixed(1)}% (${closed.length} closed, ${openCount} open)`);
  console.log(`Max drawdown    : ${(result.maxDrawdown * 100).toFixed(2)}%`);
  console.log(
    `Alpha vs SPY    : ${pct(result.alphaVsSpy.alphaPct)} ` +
      `(account ${pct(result.alphaVsSpy.accountReturnPct)}, SPY ${pct(result.alphaVsSpy.spyReturnPct)})`,
  );
  console.log("-".repeat(60));
  console.log("Trades:");
  for (const t of result.trades) {
    const exit = t.exitDate
      ? `exit ${t.exitDate} @ ${t.exitPrice} (${t.exitReason}), pnl ${money(t.realizedPnl ?? 0)}`
      : "OPEN";
    console.log(
      `  ${t.ticker.padEnd(6)} entry ${t.entryDate} @ ${t.entryPrice} x ${t.shares.toFixed(4)}  ${exit}`,
    );
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
