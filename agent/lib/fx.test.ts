import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  FrankfurterProvider,
  FxError,
  mapFrankfurterRate,
  fxOverrideFromEnv,
  resolveUsdGbp,
  fxForCycle,
  resetFxCache,
  FX_FALLBACK_USD_GBP,
} from "./fx.ts";

function fakeFetch(
  handler: (url: string) => { status?: number; body?: unknown },
) {
  const calls: string[] = [];
  const fn = async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const r = handler(String(input));
    const bodyText =
      r.body === undefined
        ? ""
        : typeof r.body === "string"
          ? r.body
          : JSON.stringify(r.body);
    return new Response(bodyText, { status: r.status ?? 200 });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

// --- mapFrankfurterRate ---

test("mapFrankfurterRate extracts rates.GBP", () => {
  assert.equal(mapFrankfurterRate({ rates: { GBP: 0.7514 } }), 0.7514);
});

test("mapFrankfurterRate throws on missing/invalid rate", () => {
  assert.throws(() => mapFrankfurterRate({}), FxError);
  assert.throws(() => mapFrankfurterRate({ rates: {} }), FxError);
  assert.throws(() => mapFrankfurterRate({ rates: { GBP: 0 } }), FxError);
  assert.throws(() => mapFrankfurterRate({ rates: { GBP: -1 } }), FxError);
  assert.throws(() => mapFrankfurterRate(null), FxError);
});

// --- FrankfurterProvider.getUsdGbp: URL / params / parse (offline) ---

test("getUsdGbp calls /latest with from=USD&to=GBP and parses the rate", async () => {
  const f = fakeFetch(() => ({ body: { rates: { GBP: 0.7514 } } }));
  const p = new FrankfurterProvider({ fetchImpl: f.fn });
  const rate = await p.getUsdGbp();
  assert.equal(rate, 0.7514);
  const u = new URL(f.calls[0]);
  assert.equal(u.origin + u.pathname, "https://api.frankfurter.app/latest");
  assert.equal(u.searchParams.get("from"), "USD");
  assert.equal(u.searchParams.get("to"), "GBP");
});

test("getUsdGbp retries once on 429 then resolves", async () => {
  let calls = 0;
  const f = fakeFetch(() => {
    calls++;
    if (calls === 1) return { status: 429, body: "limit" };
    return { body: { rates: { GBP: 0.75 } } };
  });
  const p = new FrankfurterProvider({ fetchImpl: f.fn });
  assert.equal(await p.getUsdGbp(), 0.75);
  assert.equal(calls, 2);
});

test("getUsdGbp throws FxError on a non-429 error without retrying", async () => {
  const f = fakeFetch(() => ({ status: 500, body: "boom" }));
  const p = new FrankfurterProvider({ fetchImpl: f.fn });
  await assert.rejects(() => p.getUsdGbp(), FxError);
  assert.equal(f.calls.length, 1);
});

// --- fxOverrideFromEnv: only a valid positive number counts ---

test("fxOverrideFromEnv accepts a valid positive number", () => {
  assert.equal(fxOverrideFromEnv({ USD_GBP_RATE: "0.7514" }), 0.7514);
});

test("fxOverrideFromEnv rejects empty/blank/invalid/non-positive (returns null)", () => {
  assert.equal(fxOverrideFromEnv({ USD_GBP_RATE: "" }), null);
  assert.equal(fxOverrideFromEnv({ USD_GBP_RATE: "   " }), null);
  assert.equal(fxOverrideFromEnv({ USD_GBP_RATE: "abc" }), null);
  assert.equal(fxOverrideFromEnv({ USD_GBP_RATE: "0" }), null);
  assert.equal(fxOverrideFromEnv({ USD_GBP_RATE: "-0.7" }), null);
  assert.equal(fxOverrideFromEnv({}), null);
});

// --- resolveUsdGbp: env override > live fetch > loud fallback ---

test("resolveUsdGbp uses the env override without fetching", async () => {
  const f = fakeFetch(() => {
    throw new Error("should not fetch");
  });
  const r = await resolveUsdGbp({
    provider: new FrankfurterProvider({ fetchImpl: f.fn }),
    env: { USD_GBP_RATE: "0.72" },
  });
  assert.deepEqual(r, { rate: 0.72, source: "env" });
  assert.equal(f.calls.length, 0);
});

test("resolveUsdGbp fetches live when no valid override", async () => {
  const f = fakeFetch(() => ({ body: { rates: { GBP: 0.7514 } } }));
  const r = await resolveUsdGbp({
    provider: new FrankfurterProvider({ fetchImpl: f.fn }),
    env: { USD_GBP_RATE: "" },
  });
  assert.deepEqual(r, { rate: 0.7514, source: "live" });
});

// --- fxForCycle: cached within the TTL, refreshed after it ---

test("fxForCycle caches the resolution within the TTL and refreshes after it", async () => {
  // Uses the USD_GBP_RATE override so this never touches the network; the env is changed
  // between calls so a stale cached value is distinguishable from a fresh resolution.
  const prev = process.env.USD_GBP_RATE;
  mock.timers.enable({ apis: ["Date"] });
  resetFxCache();
  try {
    process.env.USD_GBP_RATE = "0.70";
    assert.equal((await fxForCycle()).rate, 0.7);

    // Within the TTL: the cached rate is returned even though the env now says otherwise.
    process.env.USD_GBP_RATE = "0.60";
    assert.equal((await fxForCycle()).rate, 0.7);

    // Past the TTL (1h): re-resolved, so the new value wins.
    mock.timers.tick(60 * 60 * 1000 + 1);
    assert.equal((await fxForCycle()).rate, 0.6);
  } finally {
    mock.timers.reset();
    resetFxCache();
    if (prev === undefined) delete process.env.USD_GBP_RATE;
    else process.env.USD_GBP_RATE = prev;
  }
});

test("resolveUsdGbp falls back LOUDLY (source=fallback) when the live fetch fails", async () => {
  const f = fakeFetch(() => ({ status: 503, body: "down" }));
  const r = await resolveUsdGbp({
    provider: new FrankfurterProvider({ fetchImpl: f.fn }),
    env: {},
  });
  assert.equal(r.source, "fallback");
  assert.equal(r.rate, FX_FALLBACK_USD_GBP);
});
