import { test } from "node:test";
import assert from "node:assert/strict";
import {
  valueExternalHolding,
  daysUntilEarnings,
  type ExternalHoldingInput,
} from "./external-holdings.ts";
import { buildRiskSnapshot } from "./execution.ts";
import { validateOrders, DEFAULT_LIMITS } from "./risk.ts";
import type { CashBalance, T212Position } from "./t212.ts";

// The real external holding this feature exists for: SHOP held in a separate (non-T212)
// brokerage account. Numbers are the live ones at the time the feature was built, so a
// regression in the maths shows up as a wrong figure a human would recognize.
const SHOP: ExternalHoldingInput = {
  shares: 83.03770915,
  costBasisGbp: 9982.65,
  livePriceInstrumentCcy: 126.88,
  fxRate: 0.75094,
};

// --- valueExternalHolding: real data point ---

test("valueExternalHolding prices the real SHOP holding to about GBP 7911.77", () => {
  const v = valueExternalHolding(SHOP);
  // 83.03770915 shares x $126.88 = $10535.82, x 0.75094 = GBP 7911.77
  assert.ok(
    Math.abs(v.valueInstrumentCcy - 10535.82) < 0.05,
    `valueInstrumentCcy was ${v.valueInstrumentCcy}`,
  );
  assert.ok(
    Math.abs(v.valueGbp - 7911.77) < 0.05,
    `valueGbp was ${v.valueGbp}`,
  );
});

test("valueExternalHolding reports the real SHOP loss: sign negative, about -20.7%", () => {
  const v = valueExternalHolding(SHOP);
  assert.ok(v.unrealisedPnlGbp < 0, "unrealised P&L must be negative (a loss)");
  assert.ok(
    Math.abs(v.unrealisedPnlGbp - -2070.88) < 0.05,
    `unrealisedPnlGbp was ${v.unrealisedPnlGbp}`,
  );
  assert.ok(v.unrealisedPnlPct < 0, "unrealised P&L pct must be negative");
  assert.ok(
    Math.abs(v.unrealisedPnlPct - -20.74) < 0.05,
    `unrealisedPnlPct was ${v.unrealisedPnlPct}`,
  );
});

test("valueExternalHolding computes the break-even price in the instrument currency", () => {
  const v = valueExternalHolding(SHOP);
  // Cost per share is GBP 9982.65 / 83.03770915 = GBP 120.22; at 0.75094 that needs $160.09.
  // With exit intent this is the number that says what a full recovery actually requires.
  assert.ok(
    Math.abs(v.breakEvenPriceInstrumentCcy - 160.09) < 0.05,
    `breakEvenPriceInstrumentCcy was ${v.breakEvenPriceInstrumentCcy}`,
  );
  // Sanity: valuing the holding AT break-even leaves zero P&L.
  const atBreakEven = valueExternalHolding({
    ...SHOP,
    livePriceInstrumentCcy: v.breakEvenPriceInstrumentCcy,
  });
  assert.ok(
    Math.abs(atBreakEven.unrealisedPnlGbp) < 0.01,
    `P&L at break-even was ${atBreakEven.unrealisedPnlGbp}`,
  );
});

test("valueExternalHolding handles a gain and a zero cost basis", () => {
  const gain = valueExternalHolding({
    shares: 10,
    costBasisGbp: 500,
    livePriceInstrumentCcy: 100,
    fxRate: 0.8,
  });
  assert.equal(gain.valueInstrumentCcy, 1000);
  assert.equal(gain.valueGbp, 800);
  assert.equal(gain.unrealisedPnlGbp, 300);
  assert.equal(gain.unrealisedPnlPct, 60);
  assert.equal(gain.breakEvenPriceInstrumentCcy, 62.5);

  // Zero cost basis (e.g. a gift): percentage is undefined, reported as 0 rather than Infinity.
  const free = valueExternalHolding({
    shares: 10,
    costBasisGbp: 0,
    livePriceInstrumentCcy: 100,
    fxRate: 0.8,
  });
  assert.equal(free.unrealisedPnlGbp, 800);
  assert.equal(free.unrealisedPnlPct, 0);
  assert.equal(free.breakEvenPriceInstrumentCcy, 0);
});

test("valueExternalHolding throws on non-positive/non-finite shares, price or fx", () => {
  assert.throws(() => valueExternalHolding({ ...SHOP, shares: 0 }), /positive/);
  assert.throws(() => valueExternalHolding({ ...SHOP, shares: -1 }), /positive/);
  assert.throws(
    () => valueExternalHolding({ ...SHOP, livePriceInstrumentCcy: 0 }),
    /positive/,
  );
  assert.throws(() => valueExternalHolding({ ...SHOP, fxRate: 0 }), /positive/);
  assert.throws(
    () => valueExternalHolding({ ...SHOP, fxRate: Number.NaN }),
    /positive/,
  );
});

// --- daysUntilEarnings ---

test("daysUntilEarnings counts whole days from today to the report date", () => {
  // The real deadline this feature was built around: SHOP reports 2026-08-05 before open.
  assert.equal(daysUntilEarnings("2026-08-05", "2026-07-28"), 8);
  assert.equal(daysUntilEarnings("2026-07-28", "2026-07-28"), 0);
  assert.equal(daysUntilEarnings("2026-07-29", "2026-07-28"), 1);
  // Crossing a month boundary and a past date both stay correct.
  assert.equal(daysUntilEarnings("2026-08-01", "2026-07-30"), 2);
  assert.equal(daysUntilEarnings("2026-07-20", "2026-07-28"), -8);
});

test("daysUntilEarnings returns null for a missing or unparseable date", () => {
  assert.equal(daysUntilEarnings(null, "2026-07-28"), null);
  assert.equal(daysUntilEarnings(undefined, "2026-07-28"), null);
  assert.equal(daysUntilEarnings("", "2026-07-28"), null);
  assert.equal(daysUntilEarnings("not-a-date", "2026-07-28"), null);
});

// --- ISOLATION REGRESSION TEST ---
//
// INTENT (do not "fix" this by wiring the two together): external holdings live in an
// account the agent cannot trade and are ~32x the size of the Trading 212 account. If they
// ever leaked into accountValueGbp, position sizing would authorise trades ~32x too large
// and the drawdown / daily-loss breakers would compute against the wrong base.
//
// buildRiskSnapshot therefore takes ONLY broker inputs (cash + T212 positions + fx). This
// test pins that: the snapshot and the gate's verdict are byte-identical whether or not an
// external holding exists, because external holdings are simply not an input to this path.
// A future refactor that threads them in will fail here, loudly and on purpose.

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

test("REGRESSION: external holdings do NOT affect accountValueGbp / the risk snapshot", () => {
  // The real Trading 212 account: about GBP 248 total. The external SHOP holding is about
  // GBP 7912, roughly 32x this account.
  const brokerInputs = {
    cash: cash({ free: 148 }),
    positions: [pos({ ticker: "NKE_US_EQ", quantity: 2, currentPrice: 66.6 })],
    fxRate: 0.75094,
    peakEquity: 0,
    dayPnl: 0,
    newPositionsToday: 0,
    consecutiveLossDays: 0,
  };

  // Snapshot with NO external holding in existence.
  const before = buildRiskSnapshot(brokerInputs);

  // Now an external holding exists and is valued. This is the entire advisory path.
  const external = valueExternalHolding(SHOP);
  assert.ok(
    external.valueGbp > 30 * before.equity,
    "test premise: the external holding must dwarf the trading account",
  );

  // Snapshot built from the SAME broker inputs, with the external holding sitting there.
  const after = buildRiskSnapshot(brokerInputs);

  // Identical. Equity is broker-only, so sizing and the breakers see the small account.
  assert.deepEqual(after, before);
  assert.ok(
    before.equity < 300,
    `equity must be the T212 account only, was ${before.equity}`,
  );
  // Explicitly: the external value is nowhere in the snapshot.
  assert.equal(
    before.positions.some((p) => p.ticker === "SHOP"),
    false,
  );
  assert.ok(
    before.equity < external.valueGbp,
    "external value must never be added to equity",
  );
});

test("REGRESSION: the risk gate sizes off the T212 account, not the external holding", () => {
  const snap = buildRiskSnapshot({
    cash: cash({ free: 248 }),
    positions: [],
    fxRate: 0.75094,
    peakEquity: 248,
    dayPnl: 0,
    newPositionsToday: 0,
    consecutiveLossDays: 0,
  });

  // GBP 500 is a trivial fraction of the external holding but way over maxTradePct (30%)
  // of the real GBP 248 account. It MUST be rejected: this is the failure mode the
  // isolation exists to prevent.
  const result = validateOrders(
    [{ ticker: "SHOP_US_EQ", side: "BUY", notional: 500, price: 126.88 }],
    snap,
    DEFAULT_LIMITS,
  );
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /trade size/);
});
