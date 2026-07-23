/**
 * Thin, READ-ONLY backtest CLI. Loads candles + signals from a local JSON fixture, runs the
 * pure runBacktest engine, and prints the metrics. It never touches Convex, the broker, or any
 * network: give it a fixture and it prints numbers. Live candle wiring is deferred separately.
 *
 *   node --experimental-strip-types scripts/backtest.ts [path/to/fixture.json]
 *
 * With no path it uses scripts/fixtures/backtest-sample.json so it runs out of the box.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Candle } from "../agent/lib/data.ts";
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

function loadFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function main(): void {
  const defaultPath = resolve(import.meta.dirname, "fixtures", "backtest-sample.json");
  const path = process.argv[2] ? resolve(process.argv[2]) : defaultPath;
  const fx = loadFixture(path);

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

  console.log(`Backtest fixture: ${path}`);
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

main();
