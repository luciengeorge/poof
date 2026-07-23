import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "./data.ts";
import { runBacktest, type BacktestConfig } from "./backtest.ts";
import { DEFAULT_EXITS } from "./exits.ts";

/** Terse candle builder; high/low are filled in around open/close when omitted. */
function bar(date: string, open: number, close: number, high?: number, low?: number): Candle {
  return {
    date,
    open,
    close,
    high: high ?? Math.max(open, close) + 1,
    low: low ?? Math.min(open, close) - 1,
  };
}

const DATES = [
  "2024-01-01",
  "2024-01-02",
  "2024-01-03",
  "2024-01-04",
  "2024-01-05",
  "2024-01-06",
];

/** Flat SPY over the window so alpha isolates the account's own return. */
const flatSpy: Candle[] = DATES.map((d) => bar(d, 400, 400));

function baseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    startingEquity: 10_000,
    spySeries: flatSpy,
    defaultNotional: 1_000,
    ...overrides,
  };
}

test("(a) monotonic-up series yields a positive return and no spurious stop-outs", () => {
  const series: Candle[] = [
    bar("2024-01-01", 100, 100),
    bar("2024-01-02", 101, 101),
    bar("2024-01-03", 102, 102),
    bar("2024-01-04", 103, 103),
    bar("2024-01-05", 104, 104),
    bar("2024-01-06", 105, 105),
  ];
  const result = runBacktest(
    { UP: series },
    [{ ticker: "UP", date: "2024-01-01" }],
    baseConfig(),
  );

  const finalEquity = result.equityCurve[result.equityCurve.length - 1].equity;
  assert.ok(finalEquity > 10_000, `expected profit, got ${finalEquity}`);
  assert.equal(result.equityCurve.length, DATES.length);
  // Gentle uptrend stays inside the stop/take-profit band: the one position is still open.
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, null);
  assert.ok(!result.trades.some((t) => t.exitReason === "stop-loss"), "no stop-loss should fire");
});

test("(b) a dip past the stop produces a stop-loss exit at the expected level", () => {
  const entry = 100;
  const series: Candle[] = [
    bar("2024-01-01", 100, 100),
    bar("2024-01-02", entry, 100), // fill at open 100
    bar("2024-01-03", 99, 89, 100, 88), // close 89 => -11% <= -10% stop
  ];
  const result = runBacktest(
    { DIP: series },
    [{ ticker: "DIP", date: "2024-01-01" }],
    baseConfig(),
  );

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.exitReason, "stop-loss");
  assert.equal(trade.entryPrice, entry);
  assert.equal(trade.exitDate, "2024-01-03");
  assert.equal(trade.exitPrice, 89);
  assert.ok(trade.exitPrice! <= entry * 0.9, "stop fired at or below the 10% stop level");
  assert.ok((trade.realizedPnl ?? 0) < 0, "a stop-out is a losing trade");
  assert.equal(result.winRate, 0);
});

test("(c) look-ahead safety: entry fills at T+1 open, never day T's close", () => {
  const series: Candle[] = [
    bar("2024-01-01", 50, 60), // day T: close is 60 (the tempting look-ahead price)
    bar("2024-01-02", 70, 71), // day T+1: open 70 is the only legal fill
    bar("2024-01-03", 71, 72),
  ];
  const result = runBacktest(
    { LA: series },
    [{ ticker: "LA", date: "2024-01-01" }],
    baseConfig(),
  );

  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  assert.equal(trade.entryDate, "2024-01-02");
  assert.equal(trade.entryPrice, 70, "must fill at T+1 open");
  assert.notEqual(trade.entryPrice, 60, "must NOT fill at day T's close");
});

test("(d) the cost model reduces net return versus a zero-cost run", () => {
  const series: Candle[] = [
    bar("2024-01-01", 100, 100),
    bar("2024-01-02", 100, 100), // fill at open 100
    bar("2024-01-03", 100, 130), // +30% close => take-profit round trip
  ];
  const signals = [{ ticker: "RT", date: "2024-01-01" }];
  // Pin the take-profit so this test isolates cost, independent of the production
  // DEFAULT_EXITS take-profit level (which can change without invalidating this test).
  const pinnedTP = { ...DEFAULT_EXITS, defaultTakeProfitPct: 0.2 };

  const withCost = runBacktest({ RT: series }, signals, baseConfig({ exits: pinnedTP }));
  const zeroCost = runBacktest(
    { RT: series },
    signals,
    baseConfig({ spreadBps: 0, fxBps: 0, exits: pinnedTP }),
  );

  // Both must complete the same round trip (take-profit), isolating cost as the only difference.
  assert.equal(withCost.trades[0].exitReason, "take-profit");
  assert.equal(zeroCost.trades[0].exitReason, "take-profit");
  assert.ok(withCost.trades[0].costs > 0, "cost run pays fees");
  assert.equal(zeroCost.trades[0].costs, 0, "zero-cost run pays no fees");
  assert.ok(
    zeroCost.realizedPnl > withCost.realizedPnl,
    `zero-cost pnl ${zeroCost.realizedPnl} should beat cost pnl ${withCost.realizedPnl}`,
  );
});

test("alphaVsSpy compares the account return against buy-and-hold SPY", () => {
  const series: Candle[] = [
    bar("2024-01-01", 100, 100),
    bar("2024-01-02", 100, 100),
    bar("2024-01-03", 100, 130),
  ];
  // SPY rises 10% over the same window.
  const spy: Candle[] = [
    bar("2024-01-01", 400, 400),
    bar("2024-01-02", 400, 400),
    bar("2024-01-03", 400, 440),
  ];
  const result = runBacktest(
    { RT: series },
    [{ ticker: "RT", date: "2024-01-01" }],
    baseConfig({ spySeries: spy }),
  );
  assert.ok(Math.abs(result.alphaVsSpy.spyReturnPct - 10) < 1e-9);
  assert.ok(
    Math.abs(result.alphaVsSpy.alphaPct - (result.alphaVsSpy.accountReturnPct - 10)) < 1e-9,
  );
});

test("mismatched trading calendars do not manufacture a phantom drawdown", () => {
  // HOLD is a flat position that has NO bar on 2024-01-03; GAP trades that day, forcing it into
  // the union of dates. A held ticker with no bar must carry its last close forward, not mark to
  // zero. Without the fix this yields equityCurve [10000,10000,5000,10000] and maxDrawdown 0.5.
  const hold: Candle[] = [
    bar("2024-01-01", 100, 100),
    bar("2024-01-02", 100, 100), // fill at open 100
    // no bar on 2024-01-03
    bar("2024-01-04", 100, 100),
  ];
  const gap: Candle[] = [bar("2024-01-03", 100, 100)];
  const spy: Candle[] = [
    bar("2024-01-01", 400, 400),
    bar("2024-01-02", 400, 400),
    bar("2024-01-03", 400, 400),
    bar("2024-01-04", 400, 400),
  ];
  const result = runBacktest(
    { HOLD: hold, GAP: gap },
    [{ ticker: "HOLD", date: "2024-01-01" }],
    baseConfig({ defaultNotional: 5_000, spreadBps: 0, fxBps: 0, spySeries: spy }),
  );

  const curve = result.equityCurve;
  assert.deepEqual(
    curve.map((p) => p.date),
    ["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"],
  );
  // Flat, zero-cost hold: equity is 10000 on every day, including the missing-bar date.
  for (const point of curve) {
    assert.ok(
      Math.abs(point.equity - 10_000) < 1e-9,
      `phantom dip on ${point.date}: equity ${point.equity}`,
    );
  }
  const gapDay = curve.find((p) => p.date === "2024-01-03")!;
  assert.ok(Math.abs(gapDay.equity - 10_000) < 1e-9, "no dip on the missing-bar date");
  assert.ok(result.maxDrawdown < 1e-9, `expected ~0 drawdown, got ${result.maxDrawdown}`);
});
