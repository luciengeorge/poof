import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributeFailures,
  MIN_PATTERN_OCCURRENCES,
  type ClosedTradeLike,
} from "./attribution.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_785_000_000_000;

/**
 * A closed loser by default. Uses `in` rather than `??` so that passing an EXPLICIT `undefined`
 * (an open trade, or one whose outcome was never established) actually removes the field instead
 * of silently falling back to the default, which is a fixture bug that makes a test assert
 * nothing.
 */
function trade(over: Partial<ClosedTradeLike> = {}): ClosedTradeLike {
  const base: ClosedTradeLike = {
    ticker: "ticker" in over ? (over.ticker as string) : "AAA_US_EQ",
    status: "status" in over ? (over.status as string) : "closed",
    price: "price" in over ? (over.price as number) : 100,
    createdAt: "createdAt" in over ? (over.createdAt as number) : T0,
  };
  const closedAt = "closedAt" in over ? over.closedAt : T0 + 3 * DAY;
  const pnl = "pnl" in over ? over.pnl : -5;
  return {
    ...base,
    ...(closedAt !== undefined ? { closedAt } : {}),
    ...(pnl !== undefined ? { pnl } : {}),
    ...(over.strategyTag !== undefined ? { strategyTag: over.strategyTag } : {}),
    ...(over.redTeamVerdict !== undefined ? { redTeamVerdict: over.redTeamVerdict } : {}),
    ...(over.exitPrice !== undefined ? { exitPrice: over.exitPrice } : {}),
    ...(over.stopLossPct !== undefined ? { stopLossPct: over.stopLossPct } : {}),
    ...(over.maxHoldDays !== undefined ? { maxHoldDays: over.maxHoldDays } : {}),
  };
}

const pattern = (result: ReturnType<typeof attributeFailures>, dimension: string, key: string) =>
  result.patterns.find((p) => p.dimension === dimension && p.key === key);

// --- the noise filter, which is the whole point ---

test("REGRESSION: a single bad outcome is NOT a pattern", () => {
  // The failure this replaces: reflecting on one cycle let one bad day install a permanent rule.
  // SHARP requires a pattern to recur before it may motivate a change.
  const result = attributeFailures([trade({ strategyTag: "momentum", pnl: -12 })]);
  assert.deepEqual(result.patterns, []);
  assert.match(result.note, /not enough/i);
});

test("two occurrences are still not a pattern; three are", () => {
  const two = Array.from({ length: 2 }, (_, i) =>
    trade({ ticker: `T${i}`, strategyTag: "momentum", pnl: -4 }),
  );
  assert.deepEqual(attributeFailures(two).patterns, []);

  const three = Array.from({ length: MIN_PATTERN_OCCURRENCES }, (_, i) =>
    trade({ ticker: `T${i}`, strategyTag: "momentum", pnl: -4 }),
  );
  const found = pattern(attributeFailures(three), "strategy", "momentum");
  assert.ok(found, "three losses on one strategy tag IS a pattern");
  assert.equal(found.losses, MIN_PATTERN_OCCURRENCES);
  assert.equal(found.totalPnl, -12);
});

test("winners are never attributed as failures", () => {
  const mixed = [
    ...Array.from({ length: 4 }, (_, i) => trade({ ticker: `W${i}`, strategyTag: "momentum", pnl: 6 })),
    trade({ ticker: "L1", strategyTag: "momentum", pnl: -2 }),
  ];
  assert.deepEqual(attributeFailures(mixed).patterns, []);
  assert.equal(attributeFailures(mixed).losingTrades, 1);
});

test("open trades are ignored: an unrealised loss is not yet a failure", () => {
  const open = Array.from({ length: 5 }, (_, i) =>
    trade({ ticker: `O${i}`, status: "placed", closedAt: undefined, pnl: undefined }),
  );
  const result = attributeFailures(open);
  assert.deepEqual(result.patterns, []);
  assert.equal(result.closedTrades, 0);
});

test("a closed trade with unknown P&L cannot be judged either way", () => {
  const unknown = Array.from({ length: 4 }, (_, i) =>
    trade({ ticker: `U${i}`, status: "closed-unknown", pnl: undefined }),
  );
  const result = attributeFailures(unknown);
  assert.deepEqual(result.patterns, []);
  assert.match(result.note, /unknown/i);
});

// --- the dimensions ---

test("losses concentrated in one holding-period bucket surface as a pattern", () => {
  const quick = Array.from({ length: 3 }, (_, i) =>
    trade({ ticker: `Q${i}`, pnl: -3, createdAt: T0, closedAt: T0 + 2 * DAY }),
  );
  const found = pattern(attributeFailures(quick), "holding-period", "under-1-week");
  assert.ok(found, "three quick losses are a holding-period pattern");
  assert.equal(found.losses, 3);
});

test("a max-hold time exit is distinguished from a stop-loss exit", () => {
  const timeExits = Array.from({ length: 3 }, (_, i) =>
    trade({
      ticker: `M${i}`,
      pnl: -1,
      maxHoldDays: 10,
      createdAt: T0,
      closedAt: T0 + 10 * DAY,
      price: 100,
      exitPrice: 99,
    }),
  );
  assert.ok(
    pattern(attributeFailures(timeExits), "exit-kind", "max-hold"),
    "exiting at the time limit while barely down is a time exit, not a stop",
  );

  const stops = Array.from({ length: 3 }, (_, i) =>
    trade({
      ticker: `S${i}`,
      pnl: -9,
      stopLossPct: 0.08,
      maxHoldDays: 10,
      createdAt: T0,
      closedAt: T0 + 2 * DAY,
      price: 100,
      exitPrice: 91,
    }),
  );
  assert.ok(
    pattern(attributeFailures(stops), "exit-kind", "stop-loss"),
    "exiting below the stop threshold is a stop-loss exit",
  );
});

test("losses the red team had already flagged are surfaced separately", () => {
  // If the risk reviewer said shrink and it lost anyway, that is evidence the reviewer was RIGHT
  // and its verdict should carry more weight, which is a different lesson from a clean loss.
  const flagged = Array.from({ length: 3 }, (_, i) =>
    trade({ ticker: `F${i}`, pnl: -7, redTeamVerdict: "shrink" }),
  );
  const found = pattern(attributeFailures(flagged), "red-team-verdict", "shrink");
  assert.ok(found);
  assert.equal(found.losses, 3);
});

test("repeated losses in the same instrument surface as a ticker pattern", () => {
  const sameName = Array.from({ length: 3 }, (_, i) =>
    trade({ ticker: "OXY_US_EQ", pnl: -2, closedAt: T0 + (i + 1) * DAY }),
  );
  const found = pattern(attributeFailures(sameName), "ticker", "OXY_US_EQ");
  assert.ok(found);
  assert.equal(found.losses, 3);
});

// --- ordering and honesty ---

test("patterns are ordered by money lost, worst first", () => {
  const trades = [
    ...Array.from({ length: 3 }, (_, i) => trade({ ticker: `A${i}`, strategyTag: "momentum", pnl: -2 })),
    ...Array.from({ length: 3 }, (_, i) =>
      trade({ ticker: `B${i}`, strategyTag: "earnings-play", pnl: -20 }),
    ),
  ];
  const strategies = attributeFailures(trades).patterns.filter((p) => p.dimension === "strategy");
  assert.equal(strategies[0]?.key, "earnings-play", "the biggest bleed comes first");
});

test("the note states the sample size honestly rather than implying an edge", () => {
  const result = attributeFailures(
    Array.from({ length: 3 }, (_, i) => trade({ ticker: `T${i}`, strategyTag: "momentum", pnl: -4 })),
  );
  assert.match(result.note, /3 closed/);
  assert.match(result.note, /small sample|not proof|correlation/i);
});

test("attribution is pure and does not mutate its input", () => {
  const trades = [trade({ strategyTag: "momentum", pnl: -4 })];
  const copy = JSON.parse(JSON.stringify(trades));
  attributeFailures(trades);
  assert.deepEqual(JSON.parse(JSON.stringify(trades)), copy);
});
