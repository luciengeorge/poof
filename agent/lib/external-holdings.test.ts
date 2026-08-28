import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  valueExternalHolding,
  daysUntilEarnings,
  externalHoldingSymbols,
  partitionExternalHoldingBuys,
  EXTERNAL_HOLDING_SKIP_REASON,
  type ExternalHoldingInput,
} from "./external-holdings.ts";
import { buildRiskSnapshot } from "./execution.ts";
import { validateOrders, DEFAULT_LIMITS } from "./risk.ts";
import { evaluateAndExecute, type OrderExecClient, type Proposal } from "./orders.ts";
import type { CashBalance, T212Position, T212Order } from "./t212.ts";

const LIVE_FX = { rate: 0.75094, source: "live" } as const;
const UNITY_FX = { rate: 1, source: "live" } as const;

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
    fx: LIVE_FX,
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

// --- PRE-GATE TICKER GUARD ---
//
// Prompts cannot be trusted, so "the instructions say not to trade it" is not a control.
// This guard is the CODE-LEVEL stop: a BUY for a ticker held in the external account is
// skipped before the order path ever sees it. Note the guard deliberately moves only TICKER
// STRINGS across the boundary; no shares, values, or cost basis go anywhere near sizing.

test("externalHoldingSymbols normalises to plain symbols and yields STRINGS ONLY", () => {
  // Deliberately includes the value fields, to prove none of them can cross the boundary.
  const symbols = externalHoldingSymbols([
    { ticker: "SHOP", shares: 83.03770915, costBasisGbp: 9982.65 },
    { ticker: "nke_us_eq" },
  ] as { ticker: string }[]);

  assert.deepEqual([...symbols].sort(), ["NKE", "SHOP"]);
  // Type-level intent, asserted at runtime: the set carries strings and nothing else.
  for (const s of symbols) assert.equal(typeof s, "string");
  assert.equal(
    [...symbols].some((s) => typeof s === "number"),
    false,
    "no numeric value may cross the guard boundary",
  );
});

test("guard blocks a BUY for an external holding whether written SHOP or SHOP_US_EQ", () => {
  const excluded = externalHoldingSymbols([{ ticker: "SHOP" }]);
  const proposals = [
    { ticker: "SHOP", side: "BUY" as const },
    { ticker: "SHOP_US_EQ", side: "BUY" as const },
    { ticker: "shop_us_eq", side: "BUY" as const },
    { ticker: "NKE_US_EQ", side: "BUY" as const },
  ];
  const { allowed, blocked } = partitionExternalHoldingBuys(proposals, excluded);
  // A naive "SHOP" would fail at T212 as an unknown instrument anyway, but a deliberately
  // constructed "SHOP_US_EQ" would go through, so both sides are normalised.
  assert.deepEqual(
    blocked.map((p) => p.ticker),
    ["SHOP", "SHOP_US_EQ", "shop_us_eq"],
  );
  assert.deepEqual(
    allowed.map((p) => p.ticker),
    ["NKE_US_EQ"],
  );
});

test("guard does NOT block SELLs: de-risking an external name held in T212 stays allowed", () => {
  const excluded = externalHoldingSymbols([{ ticker: "SHOP" }]);
  const { allowed, blocked } = partitionExternalHoldingBuys(
    [
      { ticker: "SHOP_US_EQ", side: "SELL" as const },
      { ticker: "SHOP", side: "SELL" as const },
    ],
    excluded,
  );
  assert.equal(blocked.length, 0);
  assert.equal(allowed.length, 2);
});

test("guard blocks every BUY when told to fail closed, still allowing SELLs", () => {
  // Used when the external-holding lookup itself fails on LIVE: without the list we cannot
  // know which names are excluded, so no new exposure is opened, mirroring resolveRiskState's
  // fail-closed behaviour (halt BUYs, allow SELLs) on a Convex outage.
  const { allowed, blocked } = partitionExternalHoldingBuys(
    [
      { ticker: "NKE_US_EQ", side: "BUY" as const },
      { ticker: "AAPL_US_EQ", side: "SELL" as const },
    ],
    new Set<string>(),
    { blockAllBuys: true },
  );
  assert.deepEqual(
    blocked.map((p) => p.ticker),
    ["NKE_US_EQ"],
  );
  assert.deepEqual(
    allowed.map((p) => p.ticker),
    ["AAPL_US_EQ"],
  );
});

test("blocked external BUY is skipped with the reason while the rest of the batch executes", async () => {
  // Mirrors exactly what submit_orders.ts does: partition first, execute only `allowed`,
  // then fold the blocked proposals back in as skips. One blocked proposal must never abort
  // the batch, so the sibling BUY still places.
  const placedAtBroker: { ticker: string; quantity: number }[] = [];
  const client: OrderExecClient = {
    async getCash() {
      return {
        total: 10000,
        free: 10000,
        blocked: 0,
        invested: 0,
        pieCash: 0,
        result: 0,
        ppl: 0,
      };
    },
    async getPortfolio() {
      return [];
    },
    async getPendingOrders() {
      return [];
    },
    async placeMarketOrder(input) {
      placedAtBroker.push(input);
      return { id: 1, ...input } as T212Order;
    },
  };

  const proposals: Proposal[] = [
    { ticker: "SHOP_US_EQ", side: "BUY", notional: 500, price: 126.88, thesis: "no" },
    { ticker: "NKE_US_EQ", side: "BUY", notional: 500, price: 100, thesis: "yes" },
  ];

  const excluded = externalHoldingSymbols([{ ticker: "SHOP" }]);
  const { allowed, blocked } = partitionExternalHoldingBuys(proposals, excluded);

  const result = await evaluateAndExecute(allowed, {
    client,
    fx: UNITY_FX,
    dryRun: false,
    resolveRiskState: async () => ({
      peakEquity: 0,
      dayPnl: 0,
      newPositionsToday: 0,
      consecutiveLossDays: 0,
    }),
    resolvePrice: async () => 100,
  });
  for (const proposal of blocked) {
    result.placed.push({
      proposal,
      quantity: 0,
      dryRun: false,
      skipped: EXTERNAL_HOLDING_SKIP_REASON,
    });
  }

  // The external name never reached the broker.
  assert.deepEqual(
    placedAtBroker.map((o) => o.ticker),
    ["NKE_US_EQ"],
  );
  // The sibling BUY executed normally.
  const nke = result.placed.find((p) => p.proposal.ticker === "NKE_US_EQ");
  assert.ok(nke, "the non-external BUY must still execute");
  assert.equal(nke.skipped, undefined);
  assert.equal(nke.quantity, 5); // GBP 500 / ($100 * fx 1)
  // The external BUY is reported as a skip with an explicit reason, not silently dropped
  // and not a rejection that could abort the batch.
  const shop = result.placed.find((p) => p.proposal.ticker === "SHOP_US_EQ");
  assert.ok(shop, "the blocked BUY must be reported, not swallowed");
  assert.equal(shop.quantity, 0);
  assert.equal(shop.skipped, EXTERNAL_HOLDING_SKIP_REASON);
  assert.match(shop.skipped, /external advisory account/);
  assert.equal(result.rejected.length, 0);
});

test("REGRESSION: the risk gate sizes off the T212 account, not the external holding", () => {
  const snap = buildRiskSnapshot({
    cash: cash({ free: 248 }),
    positions: [],
    fx: LIVE_FX,
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

// The behavioural tests above compare pure functions given identical inputs, so they cannot
// catch contamination added at a CALL SITE: e.g. get_account.ts adding external value to
// equity AFTER buildRiskSnapshot returns, or record_cycle.ts logging a combined total. This
// guard closes that gap structurally by asserting the trading path never even mentions the
// concept.
//
// INTENT: a future refactor that wires external holdings into any of these files should fail
// HERE, deliberately and immediately, with this comment as the explanation. If you are reading
// this because the test just failed: that is the point. External holdings are ~32x the
// trading account; they must not reach equity, sizing, or the breakers. Put the advisory
// read in the advisory tool (agent/tools/review_external_holdings.ts) instead.
//
// submit_orders.ts is deliberately NOT in this list: it hosts the pre-gate ticker guard,
// which moves ticker STRINGS only and never a value.
const TRADING_PATH_FILES = [
  "./execution.ts",
  "./orders.ts",
  "./risk.ts",
  "./risk-runtime.ts",
  "../tools/get_account.ts",
  "../tools/review_performance.ts",
  "../tools/record_cycle.ts",
];

test("REGRESSION: no trading-path source file references external holdings at all", () => {
  const pattern = /external[-_ ]?holding/i;
  for (const rel of TRADING_PATH_FILES) {
    const path = new URL(rel, import.meta.url);
    const source = readFileSync(path, "utf8");
    assert.equal(
      pattern.test(source),
      false,
      `${rel} must not reference external holdings: equity, sizing and the risk gate are ` +
        "broker-only by design. See the comment above TRADING_PATH_FILES.",
    );
  }
});

test("the trading-path guard list actually resolves (the guard cannot go vacuous)", () => {
  // Without this, a renamed or moved file would make the guard above silently pass on
  // nothing at all.
  assert.equal(TRADING_PATH_FILES.length, 7);
  for (const rel of TRADING_PATH_FILES) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.ok(source.length > 0, `${rel} must exist and be non-empty`);
  }
});
