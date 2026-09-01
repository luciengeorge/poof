import { test } from "node:test";
import assert from "node:assert/strict";
import {
  notionalToShares,
  buildRiskSnapshot,
  accountValueGbp,
  deployedValueGbp,
  type BrokerSnapshot,
  reconcileAccountValueGbp,
  roundQuantity,
  parseQuantityPrecision,
  t212TickerToFinnhubSymbol,
} from "./execution.ts";
import type { CashBalance, T212Position } from "./t212.ts";
import type { FxResolution } from "./fx.ts";

function cash(over: Partial<CashBalance> = {}): CashBalance {
  return {
    total: 0,
    free: 0,
    blocked: 0,
    invested: 0,
    pieCash: 0,
    result: 0,
    ppl: 0,
    ...over,
  };
}

function pos(over: Partial<T212Position> = {}): T212Position {
  return {
    ticker: "AAPL_US_EQ",
    quantity: 1,
    averagePrice: 50,
    currentPrice: 50,
    ppl: 0,
    maxBuy: 0,
    maxSell: 0,
    pieQuantity: 0,
    ...over,
  };
}

function resolvedFx(
  rate: number,
  source: FxResolution["source"] = "live",
): FxResolution {
  return { rate, source };
}

function brokerSnapshot(over: Partial<BrokerSnapshot> = {}): BrokerSnapshot {
  const takenAt = over.takenAt ?? Date.UTC(2026, 8, 2, 12, 0, 0);
  return {
    cash: cash(),
    positions: [],
    fx: resolvedFx(1),
    takenAt,
    cashReadAt: takenAt,
    positionsReadAt: takenAt,
    ...over,
  };
}

// --- notionalToShares ---

test("notionalToShares converts account-ccy notional to shares via price*fx", () => {
  // £100 into a $50 stock at fx 0.8 (USD->GBP): price in GBP = 40 => 2.5 shares
  assert.equal(notionalToShares(100, 50, 0.8), 2.5);
});

test("notionalToShares keeps the sign (negative notional = SELL)", () => {
  assert.equal(notionalToShares(-100, 50, 0.8), -2.5);
});

test("notionalToShares rounds to 6 dp", () => {
  // 1 / (3 * 1) = 0.3333... -> 0.333333
  assert.equal(notionalToShares(1, 3, 1), 0.333333);
});

test("notionalToShares rejects non-positive price or fx", () => {
  assert.throws(() => notionalToShares(100, 0, 0.8), /positive/);
  assert.throws(() => notionalToShares(100, 50, 0), /positive/);
});

// --- account value reconciliation ---

test("broker total is authoritative regardless of the FX source", () => {
  for (const fx of [
    resolvedFx(0.73358, "env"),
    resolvedFx(0.7514, "live"),
    resolvedFx(0.79, "fallback"),
  ]) {
    assert.equal(
      accountValueGbp(brokerSnapshot({
        cash: cash({ total: 247.99, free: 150.38 }),
        positions: [pos({ quantity: 1, currentPrice: 132.9746835443038 })],
        fx,
      })),
      247.99,
    );
  }
});

test("deployed value is broker total minus free cash", () => {
  const reconciliation = reconcileAccountValueGbp(brokerSnapshot({
    cash: cash({ total: 247.99, free: 150.38 }),
    positions: [pos({ quantity: 1, currentPrice: 132.9746835443038 })],
    fx: resolvedFx(0.73358),
  }));
  assert.equal(reconciliation.deployedValueGbp, 247.99 - 150.38);
});

test("divergence alert carries FX, cash, holdings, and position evidence for every source", () => {
  for (const source of ["env", "live", "fallback"] as const) {
    const reconciliation = reconcileAccountValueGbp(brokerSnapshot({
      cash: cash({ total: 100, free: 50 }),
      positions: [pos({ quantity: 1, currentPrice: 60 })],
      fx: resolvedFx(1, source),
    }));
    const message = reconciliation.alert?.message ?? "";
    assert.equal(reconciliation.accountValueGbp, 100);
    assert.equal(reconciliation.alert?.code, "computed-total-divergence");
    assert.match(message, /GBP 10\.00/);
    assert.match(message, new RegExp(`FX USD->GBP 1\\.000000 \\(source: ${source}\\)`));
    assert.match(message, /free cash GBP 50\.00/);
    assert.match(message, /broker-derived holdings GBP 50\.00/);
    assert.match(message, /FX-derived holdings GBP 60\.00/);
    assert.match(message, /open positions 1/);
    assert.match(message, /snapshot taken at 2026-09-02T12:00:00\.000Z/);
  }
});

test("divergence just inside the 2% or GBP 1.00 threshold does not alert", () => {
  for (const { total, free, currentPrice } of [
    { total: 100, free: 50, currentPrice: 51.999 },
    { total: 10, free: 5, currentPrice: 5.999 },
  ]) {
    const reconciliation = reconcileAccountValueGbp(brokerSnapshot({
      cash: cash({ total, free }),
      positions: [pos({ quantity: 1, currentPrice })],
    }));
    assert.equal(reconciliation.alert, null);
  }
});

test("an unusable broker total falls back and reports the source failure", () => {
  for (const total of [undefined, Number.NaN, 0, -1]) {
    const reconciliation = reconcileAccountValueGbp(brokerSnapshot({
      cash: cash({ total, free: 20 }),
      positions: [pos({ quantity: 1, currentPrice: 50 })],
      fx: resolvedFx(0.8),
    }));
    assert.equal(reconciliation.accountValueGbp, 60);
    assert.equal(reconciliation.source, "computed-fallback");
    assert.equal(reconciliation.alert?.code, "broker-total-unusable");
  }
});

test("an unusable broker total alert names the actual unusable value", () => {
  const zero = reconcileAccountValueGbp(brokerSnapshot({
    cash: cash({ total: 0, free: 20 }),
    positions: [pos({ quantity: 1, currentPrice: 50 })],
    fx: resolvedFx(0.8),
  }));
  const missing = reconcileAccountValueGbp(brokerSnapshot({
    cash: cash({ total: undefined, free: 20 }),
    positions: [pos({ quantity: 1, currentPrice: 50 })],
    fx: resolvedFx(0.8),
  }));
  assert.match(zero.alert?.message ?? "", /received GBP 0\.00/);
  assert.match(missing.alert?.message ?? "", /received undefined/);
});

test("historical stale-FX case reports the broker total and raises an alert", () => {
  const reconciliation = reconcileAccountValueGbp(brokerSnapshot({
    cash: cash({ total: 247.99, free: 150.38 }),
    positions: [pos({ quantity: 1, currentPrice: 132.9746835443038 })],
    fx: resolvedFx(0.79),
  }));
  assert.equal(reconciliation.accountValueGbp, 247.99);
  assert.equal(reconciliation.computedAccountValueGbp, 255.43);
  assert.equal(reconciliation.alert?.code, "computed-total-divergence");
  assert.match(reconciliation.alert?.message ?? "", /GBP 7\.44/);
});

test("a non-atomic snapshot reports NOT-ATOMIC without claiming total divergence", () => {
  const reconciliation = reconcileAccountValueGbp(brokerSnapshot({
    cash: cash({ total: 100, free: 50 }),
    positions: [pos({ quantity: 1, currentPrice: 60 })],
    cashReadAt: 1_000,
    positionsReadAt: 2_001,
    takenAt: 2_001,
  }));
  assert.equal(reconciliation.alert?.code, "snapshot-not-atomic");
  assert.match(reconciliation.alert?.message ?? "", /not atomic/i);
  assert.doesNotMatch(reconciliation.alert?.message ?? "", /differs from FX-derived total/i);
});

test("deployedValueGbp converts USD holdings to GBP at the given fx", () => {
  assert.ok(
    Math.abs(deployedValueGbp([pos({ quantity: 1, currentPrice: 140.79 })], 0.7514) - 105.79) <
      0.01,
  );
  assert.equal(deployedValueGbp([], 0.7514), 0);
});

// --- buildRiskSnapshot ---

test("buildRiskSnapshot maps cash + positions into a risk snapshot (account ccy)", () => {
  const snap = buildRiskSnapshot({
    brokerSnapshot: brokerSnapshot({
      cash: cash({ total: 60, free: 20 }),
      positions: [pos({ ticker: "X", quantity: 1, currentPrice: 50 })],
      fx: resolvedFx(0.8), // position value = 1 * 50 * 0.8 = 40
    }),
    peakEquity: 0,
    dayPnl: -1,
    newPositionsToday: 1,
    consecutiveLossDays: 0,
  });
  assert.equal(snap.cash, 20);
  assert.equal(snap.positions[0].value, 40);
  assert.equal(snap.equity, 60); // 20 free + 40 deployed
  assert.equal(snap.accountValueReconciliation.source, "broker-total");
  assert.equal(snap.peakEquity, 60); // max(0, 60)
  assert.equal(snap.dayPnl, -1);
  assert.equal(snap.newPositionsToday, 1);
});

test("buildRiskSnapshot throws on non-finite cash.free (fail-closed)", () => {
  assert.throws(
    () =>
      buildRiskSnapshot({
        brokerSnapshot: brokerSnapshot({
          cash: cash({ free: NaN }),
          positions: [pos({ ticker: "X", quantity: 1, currentPrice: 50 })],
          fx: resolvedFx(0.8),
        }),
        peakEquity: 0,
        dayPnl: 0,
        newPositionsToday: 0,
        consecutiveLossDays: 0,
      }),
    /non-finite/,
  );
});

test("buildRiskSnapshot throws on non-finite position currentPrice (fail-closed)", () => {
  assert.throws(
    () =>
      buildRiskSnapshot({
        brokerSnapshot: brokerSnapshot({
          cash: cash({ free: 20 }),
          positions: [pos({ ticker: "X", quantity: 1, currentPrice: NaN })],
          fx: resolvedFx(0.8),
        }),
        peakEquity: 0,
        dayPnl: 0,
        newPositionsToday: 0,
        consecutiveLossDays: 0,
      }),
    /non-finite/,
  );
});

test("buildRiskSnapshot returns the same values as today for a normal finite snapshot", () => {
  const snap = buildRiskSnapshot({
    brokerSnapshot: brokerSnapshot({
      cash: cash({ total: 60, free: 20 }),
      positions: [pos({ ticker: "X", quantity: 1, currentPrice: 50 })],
      fx: resolvedFx(0.8),
    }),
    peakEquity: 0,
    dayPnl: -1,
    newPositionsToday: 1,
    consecutiveLossDays: 0,
  });
  assert.equal(snap.cash, 20);
  assert.equal(snap.positions[0].value, 40);
  assert.equal(snap.equity, 60);
  assert.equal(snap.peakEquity, 60);
  assert.equal(snap.dayPnl, -1);
  assert.equal(snap.newPositionsToday, 1);
});

test("roundQuantity: truncates DOWN to N decimals, clean of float noise", () => {
  assert.equal(roundQuantity(0.2234567, 4), 0.2234);
  assert.equal(roundQuantity(0.2234, 4), 0.2234); // float-noise safe (0.2234*1e4 ≈ 2233.9999)
  assert.equal(roundQuantity(12.09032128, 4), 12.0903);
  assert.equal(roundQuantity(3.9, 0), 3); // whole shares only
  assert.equal(roundQuantity(0.4, 0), 0); // < 1 share, whole-only → 0
  assert.equal(roundQuantity(0, 6), 0);
});

test("parseQuantityPrecision: extracts allowed dp, ignores HTTP status", () => {
  assert.equal(parseQuantityPrecision("invalid quantity precision 4"), 4);
  assert.equal(
    parseQuantityPrecision('Trading 212 API error 400: {"code":"invalid quantity precision 4"}'),
    4,
  );
  assert.equal(parseQuantityPrecision("Quantity must be limited to 0 decimal spaces"), 0);
  assert.equal(parseQuantityPrecision("insufficient funds"), null);
});

test("t212TickerToFinnhubSymbol: strips the _US_EQ suffix", () => {
  assert.equal(t212TickerToFinnhubSymbol("AAPL_US_EQ"), "AAPL");
});

test("t212TickerToFinnhubSymbol: returns null for a non-matching ticker", () => {
  assert.equal(t212TickerToFinnhubSymbol("AAPL"), null);
});

test("buildRiskSnapshot keeps a higher stored peakEquity", () => {
  const snap = buildRiskSnapshot({
    brokerSnapshot: brokerSnapshot({ cash: cash({ free: 10 }) }),
    peakEquity: 100,
    dayPnl: 0,
    newPositionsToday: 0,
    consecutiveLossDays: 0,
  });
  assert.equal(snap.equity, 10);
  assert.equal(snap.peakEquity, 100); // stored peak wins over current
});
