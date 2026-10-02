import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_LIMITS, type RiskLimits } from "./risk.ts";
import { DEFAULT_LOSS_DAY_MIN_DROP_PCT, lossDayMinDropPctFromEnv, resolveLimits } from "./state.ts";

/**
 * .env.example is the file README.md tells a new operator to copy. It therefore configures
 * real deployments, and for a while it shipped LIVE assignments holding the pre-#76 risk
 * limits: a 2% trade floor and 10 concurrent positions on an account that had just been
 * retuned to 15% and 4. Following the documented setup restored the exact probe sizing #76
 * deleted. These tests make that impossible to reintroduce quietly.
 */

const ENV_EXAMPLE = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

/** env var name -> the DEFAULT_LIMITS field resolveLimits() overlays it onto. */
const LIMIT_KEYS: Record<string, keyof RiskLimits> = {
  TRADING_MAX_PER_NAME_PCT: "maxPerNamePct",
  TRADING_MAX_DEPLOYED_PCT: "maxDeployedPct",
  TRADING_MAX_NEW_POSITIONS_PER_DAY: "maxNewPositionsPerDay",
  TRADING_MIN_TRADE_PCT: "minTradePct",
  TRADING_MAX_TRADE_PCT: "maxTradePct",
  TRADING_DAILY_LOSS_HALT_PCT: "dailyLossHaltPct",
  TRADING_MAX_CONCURRENT_POSITIONS: "maxConcurrentPositions",
  TRADING_MIN_PRICE: "minPrice",
  TRADING_MAX_DRAWDOWN_PCT: "maxDrawdownPct",
  TRADING_MAX_CONSECUTIVE_LOSS_DAYS: "maxConsecutiveLossDays",
};

const LOSS_DAY_KEY = "TRADING_LOSS_DAY_MIN_DROP_PCT";

/** Every documented override, parsed off the commented-out lines. */
function documentedOverrides(): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of ENV_EXAMPLE.split("\n")) {
    const m = line.match(/^#\s*(TRADING_[A-Z0-9_]+)=([-0-9.]+)/);
    if (m) out.set(m[1], Number(m[2]));
  }
  return out;
}

test("no TRADING_* override is a live assignment in .env.example", () => {
  // Matches what dotenv would load, not just the canonical form: leading whitespace and an
  // `export ` prefix both still set the var, so either would move the gate just the same.
  const live = ENV_EXAMPLE.split("\n").filter((line) =>
    /^\s*(?:export\s+)?TRADING_[A-Z0-9_]+\s*[=:]/.test(line),
  );
  assert.deepEqual(live, [], `copying .env.example would override the risk gate: ${live.join(" | ")}`);
});

test("every documented TRADING_* value equals the shipped default", () => {
  const documented = documentedOverrides();
  for (const [envName, field] of Object.entries(LIMIT_KEYS)) {
    assert.equal(
      documented.get(envName),
      DEFAULT_LIMITS[field],
      `.env.example documents ${envName}=${documented.get(envName)} but DEFAULT_LIMITS.${field} is ${DEFAULT_LIMITS[field]}`,
    );
  }
  assert.equal(documented.get(LOSS_DAY_KEY), DEFAULT_LOSS_DAY_MIN_DROP_PCT);
});

test("the documented overrides cover DEFAULT_LIMITS exactly, and every name is one state.ts reads", () => {
  const documented = documentedOverrides();
  const stateSrc = readFileSync(new URL("./state.ts", import.meta.url), "utf8");

  // Sorted arrays rather than sets, so two env names mapped onto one field also fail.
  assert.deepEqual(Object.values(LIMIT_KEYS).sort(), Object.keys(DEFAULT_LIMITS).sort());
  for (const envName of Object.keys(LIMIT_KEYS)) {
    assert.ok(documented.has(envName), `${envName} is a live limit but .env.example does not document it`);
  }

  for (const name of documented.keys()) {
    assert.ok(name in LIMIT_KEYS || name === LOSS_DAY_KEY, `${name} is documented but maps to no limit`);
    assert.ok(stateSrc.includes(`"${name}"`), `${name} is documented but agent/lib/state.ts never reads it`);
  }

  // The literal-name check proves a name is read somewhere, not that it lands on the field
  // LIMIT_KEYS claims. Two limits share 0.3, so a swapped pair in the map would pass test 2 and
  // then misattribute the next drift. Overriding each var alone through the real resolver pins it.
  for (const [envName, field] of Object.entries(LIMIT_KEYS)) {
    assert.deepEqual(resolveLimits({ [envName]: "777" }), { ...DEFAULT_LIMITS, [field]: 777 }, envName);
  }
  assert.equal(lossDayMinDropPctFromEnv({ [LOSS_DAY_KEY]: "777" }), 777);
});
