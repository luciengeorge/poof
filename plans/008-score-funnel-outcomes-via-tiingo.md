# Plan 008: Score funnel outcomes through Tiingo, not a 403 endpoint

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat ad33f28..HEAD -- agent/lib/funnel.ts agent/lib/funnel.test.ts agent/lib/funnel-schedule.ts agent/lib/tiingo.ts agent/lib/data.ts agent/lib/memory.ts convex/memory.ts convex/schema.ts`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (was S; the 2026-10-01 amendment moved scoring to one request per ticker)
- **Risk**: LOW
- **Depends on**: plans/001-reinstall-dependency-tree.md (so a green test run is evidence)
- **Category**: bug
- **Planned at**: commit `0859c96`, 2026-09-30
- **Amended at**: commit `ad33f28`, 2026-10-01 (see "Volume and quota")

## Why this matters

poof is an autonomous agent trading a real Trading 212 UK ISA with roughly £250
of real money. Beside the trading loop runs a "wide funnel": four scheduled
fires a day screen the whole S&P 500's news through a model called Jev, and Jev
records a directional forecast (`higherIn10d`) for each item. That forecast is a
shadow: it influences nothing until its accuracy has been measured on real
outcomes. Measuring it is the job of `scoreFunnelOutcomes`.

`scoreFunnelOutcomes` cannot measure anything, because the endpoint it calls
returns HTTP 403 on this account's Finnhub tier. Every item it tries to score
throws, gets counted as a failure, and is logged and swallowed. More than a
hundred `funnelItems` rows sit with `outcomeAt` unset and zero scored (about
1,600 by 2026-10-01), and have done since the feature shipped. The repo already knows this. The doc comment on
the Finnhub client at `agent/lib/data.ts:192-196` says so in writing:

```
   * NOTE: /stock/candle is gated on our current API tier, so live calls 403 ("no access");
   * this mapping exists so the harness is ready the moment a provider/tier that serves
   * candles is wired in.
```

A working provider was wired in for the backtest harness and never connected
here. `agent/lib/tiingo.ts:73` is a tested `getCandles` against Tiingo's
daily-prices endpoint, which serves adjusted end-of-day bars on the free tier,
and it returns the same `Candle[]` shape. Nothing in `agent/` calls it except
three local scripts (`scripts/backtest.ts`, `scripts/sweep-sizing.ts`,
`scripts/sweep-maxhold.ts`) and its own test.

This is the only measurement path that exists. Of 55 live BUYs, three carry a
`jevConfidence` and none of the three has closed, so calibrating Jev off the
trading record will take months. The funnel produces hundreds of scoreable items
a day. Turn it on and the calibration experiment has data within two weeks;
leave it off and the shadow forecaster stays unfalsifiable indefinitely.

### Volume and quota (amended 2026-10-01)

The first version of this plan assumed "a backlog of 100+ items" and scored one
item per Tiingo request. Production data says otherwise. Read on 2026-10-01 with
`npx convex data funnelItems --prod`:

- the funnel writes about **700 items a day across about 268 distinct tickers**
  (2026-09-30: 705 items / 268 tickers; 2026-10-01: 700 / 268);
- **1,603 rows are unscored**, and 314 distinct tickers appeared in the first
  three days;
- the S&P 500 universe is 503 names.

Tiingo's free tier, read from tiingo.com/about/pricing the same day: **50
requests per hour, 1,000 per day, 500 unique symbols per month**. Hobby cron
jitter can land all four funnel fires inside one hour (on 2026-10-01 they ran
between 12:53 and 13:28 UTC).

So one request per item cannot work. 40 items per fire across four fires is 160
requests in an hour, three times the hourly cap. The 429 retry in
`agent/lib/tiingo.ts` waits at most 10 s, three times, so every call past the cap
burns about 30 s and then fails, which runs the fire past its 300 s budget. And
160 items a day against 700 new ones means the backlog grows forever.

The fix is to **score by ticker, not by item.** One `getCandles` call returns a
ticker's full daily history over a date range, which scores every matured item
for that ticker in one go, across every day it appeared. Each fire picks at most
10 tickers (4 fires x 10 = 40 requests per hour, inside the 50 cap with headroom
for local backtests on the same key). The rotation reaches each of roughly
300-450 tickers every 8-11 days, so every item is eventually scored, about 1-2
weeks after its 10-trading-day window closes. That is full coverage with a lag,
which is what calibration and a rank-IC study need.

The 500-unique-symbols-a-month cap is the one limit this cannot rule out: the
funnel may touch close to the whole universe in a month. If it is hit, Tiingo
refuses symbols it has not yet counted this month. It is not documented whether
that refusal is a 429 or another 4xx. On a 429 the scorer stops its batch
(step 4), so every ticker after the refused one in that fire waits too; on any
other status it is one failed ticker and the fire carries on. Either way the
items wait for the month to roll over, and nothing is lost unless an item ages
past the 60-day window (step 3). Because each fire starts its ticker run at a
different point in the queue (step 4), a refused or broken ticker cannot sit at
the front and block every fire.

## Current state

Files involved:

- `agent/lib/funnel.ts`: the funnel's pure logic. Declares `FunnelNewsSource`
  (line 44), scores outcomes in `scoreFunnelOutcomes` (line 257), and computes
  the 10-trading-day direction in `outcomeFromCandles` (line 241).
- `agent/lib/funnel-schedule.ts`: the IO edge. Builds the real dependencies and
  calls `runFunnelChunk` then `scoreFunnelOutcomes`. 88 lines, read all of it.
- `agent/lib/tiingo.ts`: the working candle provider. `TiingoProvider.getCandles`
  at line 73, `tiingoFromEnv()` at line 112.
- `agent/lib/data.ts`: `Candle` (line 29), `FinnhubProvider.getCandles`
  (line 198, the 403 path), `finnhubFromEnv()` (line 229).
- `agent/lib/funnel.test.ts`: the exemplar for tests here.

`agent/lib/funnel.ts:44-47`, the dependency interface:

```ts
export interface FunnelNewsSource {
  getCompanyNews(symbol: string, fromISO: string, toISO: string): Promise<NewsItem[]>;
  getCandles(symbol: string, fromISO: string, toISO: string): Promise<Candle[]>;
}
```

`agent/lib/funnel.ts:257-292`, the scorer:

```ts
export async function scoreFunnelOutcomes(deps: {
  news: FunnelNewsSource;
  memory: FunnelMemory;
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
  logger?: Pick<Console, "warn">;
}): Promise<{ scored: number; pending: number; failures: number }> {
  const now = deps.now ?? Date.now;
  const pause = deps.sleepImpl ?? sleep;
  const logger = deps.logger ?? console;
  const at = now();
  // Ten trading days is at least fourteen calendar days; a little more covers holidays.
  const screenedBefore = at - 16 * 86_400_000;
  const items = await deps.memory.funnelItemsAwaitingOutcome(screenedBefore, FUNNEL_OUTCOMES_PER_RUN);
  let scored = 0;
  let pending = 0;
  let failures = 0;
  for (const item of items) {
    try {
      const screenedDay = utcDay(item.screenedAt);
      const candles = await deps.news.getCandles(item.ticker, screenedDay, utcDay(at));
      const outcome = outcomeFromCandles(candles, screenedDay);
      if (!outcome) {
        pending += 1;
        continue;
      }
      await deps.memory.recordFunnelOutcome({ id: item._id, outcomeAt: at, ...outcome });
      scored += 1;
    } catch (err) {
      failures += 1;
      logger.warn(`[funnel] outcome failed for ${item.ticker}:`, err);
    }
    await pause(FUNNEL_FINNHUB_INTERVAL_MS);
  }
  return { scored, pending, failures };
}
```

`agent/lib/funnel-schedule.ts:45-53` builds `news` and `80-87` calls the scorer
with it:

```ts
  let tickers: string[] = [];
  let news: ReturnType<typeof finnhubFromEnv>;
  try {
    const universe = loadUniverse();
    tickers = universeChunk(universe.tickers, claim.chunk, FUNNEL_CHUNKS);
    news = finnhubFromEnv();
```

```ts
  // Outcome scoring for the directional shadow. Best-effort and last, so it can never eat into
  // the screening budget; if the function is short on time this is the part that gets cut.
  try {
    const scored = await scoreFunnelOutcomes({ news, memory, now, logger });
    logger.log(`[${schedule}] outcomes: ${JSON.stringify(scored)}`);
  } catch (err) {
    logger.warn(`[${schedule}] outcome scoring failed (non-fatal):`, err);
  }
```

The pacing constant, `agent/lib/funnel.ts:31-32`:

```ts
/** Finnhub free tier is 60/min; one call a second with headroom for the occasional retry. */
export const FUNNEL_FINNHUB_INTERVAL_MS = 1_050;
```

and the batch bound, `agent/lib/funnel.ts:42`:

```ts
export const FUNNEL_OUTCOMES_PER_RUN = 40;
```

The memory interface the scorer uses, `agent/lib/funnel.ts:49-53`:

```ts
export interface FunnelMemory {
  upsertFunnelItems(items: FunnelItemRecord[]): Promise<{ inserted: number; skipped: number }>;
  funnelItemsAwaitingOutcome(screenedBefore: number, limit: number): Promise<StoredFunnelItem[]>;
  recordFunnelOutcome(input: { id: string; outcomeAt: number; outcomeUp: boolean; outcomePct: number }): Promise<unknown>;
}
```

implemented by `agent/lib/memory.ts:405-410` against these Convex functions,
`convex/memory.ts:1381-1408`:

```ts
export const funnelItemsAwaitingOutcome = query({
  args: { token: v.string(), screenedBefore: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const limit = Math.min(Math.max(args.limit, 1), 100);
    return await ctx.db
      .query("funnelItems")
      .withIndex("by_outcome_and_screened", (q) =>
        q.eq("outcomeAt", undefined).lt("screenedAt", args.screenedBefore),
      )
      .take(limit);
  },
});
```

and the one-row outcome mutation:

```ts
export const recordFunnelOutcome = mutation({
  args: {
    token: v.string(),
    id: v.id("funnelItems"),
    outcomeAt: v.number(),
    outcomeUp: v.boolean(),
    outcomePct: v.number(),
  },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const { token, id, ...rest } = args;
    await ctx.db.patch(id, rest);
  },
});
```
 The only index today is
`convex/schema.ts:417`: `.index("by_outcome_and_screened", ["outcomeAt", "screenedAt"])`.
Nothing outside these files calls `funnelItemsAwaitingOutcome`,
`recordFunnelOutcome` or `FUNNEL_OUTCOMES_PER_RUN`; confirm with
`grep -rn -e FUNNEL_OUTCOMES_PER_RUN -e recordFunnelOutcome -e funnelItemsAwaitingOutcome agent convex scripts evals`.
`TiingoError` (`agent/lib/tiingo.ts:11-22`) carries a numeric `status` and a
boolean `rateLimited`.

`Candle` shapes match exactly. `agent/lib/data.ts:28-36` defines the type, and
`agent/lib/tiingo.ts:2` imports that very type, so `TiingoProvider.getCandles`
returns `Candle[]` by construction. `mapTiingoPrices` (line 90) truncates the ISO
datetime to `YYYY-MM-DD` and sorts ascending, matching `mapCandles` in
`data.ts:217`. No adapter or field translation is needed. Confirm this yourself
rather than taking it on trust; it is the assumption the whole plan rests on.

One signature difference: `MarketDataProvider.getCandles` in `data.ts:51-56`
takes an optional fourth `resolution` argument, `TiingoProvider.getCandles` takes
three. The funnel only ever passes three, so a three-argument interface accepts
both providers.

Ticker format. `funnelItems.ticker` comes from the universe
(`agent/data/universe.ts`, loaded by `loadUniverse` at `agent/lib/universe.ts:19`),
which is 503 plain uppercase symbols. Exactly two contain punctuation: `BRK-B`
and `BF-B`, both in dash form. `TiingoProvider.getCandles` lowercases the symbol
and Tiingo's daily endpoint uses the dash form (`brk-b`), so the universe's
spelling maps straight through. Finnhub wanted the dot form. Step 4 checks this
against the live API rather than assuming it.

Repo conventions that apply here:

- Pure, unit-tested functions with IO at the edges. `funnel.ts` is pure and takes
  its dependencies as an object; `funnel-schedule.ts` is the only place that
  constructs real clients. Keep that split.
- Comments explain WHY, at length, and are not on every line. The block comment
  at `funnel-schedule.ts:43-44` ("a throw out here would leave the chunk at
  `started` for good, which is how a broken universe load went unnoticed for
  thirteen days") is the house voice.
- No em-dashes.
- Tests use `node:test` with `node:assert/strict`, plain object fixtures, and no
  mocking framework. `agent/lib/funnel.test.ts:260` is the existing outcome-scoring
  test; `agent/lib/funnel.test.ts:282` is the existing structural wiring test that
  reads source files as text. Model on both.
- NEVER use TypeScript parameter properties (`constructor(private readonly x)`).
  `--experimental-strip-types` cannot erase them and the whole test file dies
  with a bare "test failed". `agent/lib/tiingo.ts:39-45` shows the correct shape:
  declared fields, assigned in the constructor body.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck (app) | `pnpm typecheck` | exit 0 |
| Typecheck (convex) | `npx tsc -p convex/tsconfig.json` | exit 0 |
| Funnel tests | `node --test --experimental-strip-types agent/lib/funnel.test.ts` | all pass |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |
| Prod env names | `npx vercel env ls production` | lists names, values hidden |

Node version: this repo needs Node 24 (`.nvmrc`), but the default shell here is
Node 22. Run `source ~/.nvm/nvm.sh && nvm use` in every shell before any
command in this plan. Node 24 prints `ℹ pass N` / `ℹ fail N`; Node 22 prints
`# pass N`. If you see `#`, you skipped `nvm use`; it does not mean plan 001
is undone (it is DONE). A grep pinned to one prefix silently matches nothing on
the other.

## Scope

**In scope** (the only files you should modify):

- `agent/lib/funnel.ts`: split the candle dependency out of `FunnelNewsSource`;
  rewrite `scoreFunnelOutcomes` to work per ticker; replace
  `FUNNEL_OUTCOMES_PER_RUN` with the constants in step 4; extend `FunnelMemory`
- `agent/lib/funnel-schedule.ts`: construct and inject the Tiingo candle source
- `agent/lib/memory.ts`: the client methods behind the new `FunnelMemory` shape
- `convex/schema.ts`: one new index on `funnelItems`, nothing else
- `convex/memory.ts`: the per-ticker query, the windowed head query, the batch
  outcome mutation
- `agent/lib/funnel.test.ts`: tests
- `.env.example`: line 28 only, the `TIINGO_API_KEY` comment
- `README.md`: line 77 only, the "only needed locally" claim

**Out of scope** (do NOT touch, even though they look related):

- `agent/lib/data.ts`. Finnhub stays the news source and its `getCandles` stays
  where it is. It is the right implementation for a tier that serves candles, it
  is tested (`agent/lib/data.test.ts:142`), and deleting it would break
  `MarketDataProvider`. Leave the 403 comment in place.
- `agent/lib/tiingo.ts`. It works and is tested. Do not add a wrapper, a retry
  policy or a rate limiter to it; plan 011 owns shared rate limiting. The scorer
  reacts to a 429 itself (step 4).
- `outcomeFromCandles` (`agent/lib/funnel.ts:241`). The scoring maths is correct
  and tested. This plan changes where candles come from and how many items one
  request scores, nothing about what is done with them.
- Any new field on `funnelItems`. The table holds about 1,600 live rows. This plan
  adds an index only, which needs no backfill decision. If you think you need a
  field, STOP.
- `.env.example` lines 42-53. Plan 004 edits that block.
- Anything about the screening path (`runFunnelChunk`, `screenFunnelItem`,
  `funnel-score.ts`). Scoring runs after it and must not disturb it.
- Running `npx convex deploy` in any form, or any command against production
  other than the read-only `npx vercel env ls production` and step 6's one
  Tiingo read. The reviewer runs the production schema dry run.

## Git workflow

- Branch: `advisor/008-score-funnel-outcomes-via-tiingo`
- One or more commits, conventional style from `git log`, subject in the
  imperative, body explaining the mechanism. For example:
  `fix(funnel): score outcomes per ticker through Tiingo, not a 403 Finnhub endpoint`
- Stage explicit paths only. Never `git add -A`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0: Prepare the worktree

`convex/_generated` is gitignored, so a fresh worktree has none and the Convex
typecheck fails for reasons unrelated to your change. Copy it in from the main
checkout before anything else:

```
/bin/cp -R /Users/lucien/src/luciengeorge/poof/convex/_generated convex/
```

Read `convex/_generated/ai/guidelines.md` before writing any Convex code. Its
rules override what you may remember about Convex.

**Verify**: `npx tsc -p convex/tsconfig.json` exits 0 on the untouched tree.

### Step 1: Check the production environment

This wiring runs on Vercel. `tiingoFromEnv()` throws `TIINGO_API_KEY is not set`
when the variable is missing. It was added to Production on 2026-09-30; confirm
rather than assume.

```
npx vercel env ls production
```

**Verify**: `TIINGO_API_KEY` is listed for Production. If it is not, continue
building (the design makes a missing key a logged warning) but treat step 8 as a hard
gate. Never print the value of any environment variable.

### Step 2: Write the failing wiring test first

Add to `agent/lib/funnel.test.ts` a structural test modelled on the existing ones
near line 282 (they read schedule files as text). It reads
`agent/lib/funnel-schedule.ts` and asserts:

1. it imports from `./tiingo.ts`;
2. the call to `scoreFunnelOutcomes(` is passed a candle source, not the Finnhub
   `news` client;
3. `finnhubFromEnv()` is still what feeds `runFunnelChunk`.

Use these exact assertions, so that mutation A in step 9 (`candles: news`) is
caught even though the word `candles` survives it:

```ts
assert.match(src, /from "\.\/tiingo\.ts"/);
assert.match(src, /const candles = tiingoFromEnv\(\)/);
assert.match(src, /scoreFunnelOutcomes\(\{ candles, memory/);
assert.doesNotMatch(src, /scoreFunnelOutcomes\(\{[^}]*news/);
assert.match(src, /finnhubFromEnv\(\)/);
```

Put a comment above it in the spirit of `agent/lib/hold-floor.test.ts:82-84`:
every unit test injects a fake candle source, so all of them stay green if the
schedule keeps passing the Finnhub client whose `/stock/candle` 403s. That is the
bug that shipped; only this file's source shows the wiring.

**Verify**: `node --test --experimental-strip-types agent/lib/funnel.test.ts` →
the new test FAILS, everything else passes.

### Step 3: Convex: one index, a windowed head query, a per-ticker query, a batch mutation

In `convex/schema.ts`, add to `funnelItems` (keep the existing indexes):

```ts
    .index("by_ticker_and_outcome_and_screened", ["ticker", "outcomeAt", "screenedAt"]),
```

In `convex/memory.ts`:

1. Change `funnelItemsAwaitingOutcome` to take `screenedAfter` as well, and
   bound the range on both sides:
   `q.eq("outcomeAt", undefined).gt("screenedAt", args.screenedAfter).lt("screenedAt", args.screenedBefore)`.
   Why: an item whose ticker never yields a full window (renamed, delisted, a
   spelling Tiingo rejects) would otherwise sit at the head of the queue for
   ever and take one of the fire's ten ticker slots every time. The lower bound
   lets it age out after 60 days instead of starving the rotation.
2. Add `funnelItemsAwaitingOutcomeForTicker` with args
   `{ token, ticker, screenedAfter, screenedBefore, limit }`, using the new index:
   `q.eq("ticker", args.ticker).eq("outcomeAt", undefined).gt("screenedAt", args.screenedAfter).lt("screenedAt", args.screenedBefore)`,
   `limit` clamped to 1..200, `.take(limit)`.
3. Replace `recordFunnelOutcome` with `recordFunnelOutcomes`, args
   `{ token, outcomes: v.array(v.object({ id: v.id("funnelItems"), outcomeAt: v.number(), outcomeUp: v.boolean(), outcomePct: v.number() })) }`,
   which patches each row. One call per ticker instead of one per item: a busy
   ticker can have 30+ matured items, and 300 single-row HTTP mutations would eat
   the fire's budget.

Every function keeps `assertSecret(args.token)` as its first line, matching the
rest of the file.

In `agent/lib/memory.ts`, update the client to match: `funnelItemsAwaitingOutcome(screenedAfter, screenedBefore, limit)`,
add `funnelItemsAwaitingOutcomeForTicker(ticker, screenedAfter, screenedBefore, limit)`,
and replace `recordFunnelOutcome` with `recordFunnelOutcomes(outcomes)`. Follow
the existing one-line `this.query(...)` / `this.mutation(...)` style at
`agent/lib/memory.ts:405-410`.

**Verify**: `npx tsc -p convex/tsconfig.json` → exit 0. That checks `convex/`
only, not `agent/lib/memory.ts`; the app typecheck covers that file. `pnpm typecheck` is
expected to fail at this point, pointing at `funnel.ts` and the test fake; that
is step 4's job.

### Step 4: Rewrite the scorer to work per ticker

In `agent/lib/funnel.ts`:

1. Remove `getCandles` from `FunnelNewsSource`; `runFunnelChunk` only calls
   `getCompanyNews` (check with `grep -n "getCandles" agent/lib/funnel.ts`). Add:

```ts
/**
 * Daily candles for outcome scoring. Deliberately separate from FunnelNewsSource: news comes
 * from Finnhub, whose /stock/candle is gated on our tier and 403s, which is why no funnel outcome
 * was ever scored. Tiingo serves adjusted end-of-day bars on the free tier in the same Candle shape.
 */
export interface FunnelCandleSource {
  getCandles(symbol: string, fromISO: string, toISO: string): Promise<Candle[]>;
}
```

2. Update `FunnelMemory` to the three methods from step 3.

3. Replace `FUNNEL_OUTCOMES_PER_RUN` with:

```ts
/**
 * Tickers whose candles one fire fetches for outcome scoring. Tiingo's free tier allows 50
 * requests an hour, and Hobby jitter can land all four fires inside one hour, so 4 x 10 = 40
 * leaves headroom for local backtests on the same key. One request scores every matured item for
 * its ticker, so this bounds requests, not items.
 */
export const FUNNEL_OUTCOME_TICKERS_PER_RUN = 10;
/** Oldest awaiting items read to choose this fire's tickers. */
export const FUNNEL_OUTCOME_HEAD_ITEMS = 100;
/** Most awaiting items scored for one ticker in one fire. */
export const FUNNEL_OUTCOME_ITEMS_PER_TICKER = 200;
/** Items older than this are left unscored rather than retried for ever; see funnelItemsAwaitingOutcome. */
export const FUNNEL_OUTCOME_MAX_AGE_DAYS = 60;
/** Courtesy pause between ticker requests. Not the quota control: FUNNEL_OUTCOME_TICKERS_PER_RUN is. */
export const FUNNEL_OUTCOME_INTERVAL_MS = 1_050;
```

Leave `FUNNEL_FINNHUB_INTERVAL_MS` and its use in the screening loop alone.

4. Rewrite `scoreFunnelOutcomes`. Dependencies become
   `{ candles: FunnelCandleSource; memory: FunnelMemory; now?; sleepImpl?; logger? }`.
   Behaviour, in order:
   - `at = now()`, `screenedBefore = at - 16 days` (keep the existing comment),
     `screenedAfter = at - FUNNEL_OUTCOME_MAX_AGE_DAYS days`.
   - Read the head: `funnelItemsAwaitingOutcome(screenedAfter, screenedBefore, FUNNEL_OUTCOME_HEAD_ITEMS)`.
   - `distinct` = distinct tickers of the head in head order (oldest first).
     Take `FUNNEL_OUTCOME_TICKERS_PER_RUN` of them starting at
     `offset = Math.floor(at / 60_000) % distinct.length`, wrapping round to the
     start of the list (all of them when there are 10 or fewer). Why not simply
     the first 10: the head is deterministic, so a ticker that never scores
     (Tiingo does not know the symbol, or refuses it under the monthly cap) would
     sit in slot 1 every fire, and on a 429 would stop every fire before anything
     else is tried. A start point that moves with the clock means fires at
     different minutes try different tickers first.
   - For each ticker, inside its own try/catch:
     - read its items with `funnelItemsAwaitingOutcomeForTicker(ticker, screenedAfter, screenedBefore, FUNNEL_OUTCOME_ITEMS_PER_TICKER)`;
       skip the ticker if empty. Compute the earliest `screenedAt` with
       `Math.min(...)`; do not rely on the query's result order;
     - ONE `candles.getCandles(ticker, utcDay(min screenedAt among them), utcDay(at))`;
     - for each item, `outcomeFromCandles(bars, utcDay(item.screenedAt))`; null
       counts as `pending`, otherwise collect `{ id, outcomeAt: at, ...outcome }`;
     - if any were collected, ONE `recordFunnelOutcomes(collected)`; add the
       count to `scored`.
     - On a throw: `failures += 1` (per ticker). If the error carries
       `status === 429`, set `rateLimited = true`, log once, and `break`: a cap
       is reached and every further call would wait about 30 s and fail. Any
       other error: log with the ticker and continue. Do not import
       `TiingoError` into this pure module; read the property instead. This one
       narrowing cast is permitted, and it is the only one:

```ts
const status = typeof err === "object" && err !== null && "status" in err ? (err as { status?: unknown }).status : undefined;
if (status === 429) { /* rateLimited = true; log; break */ }
```
   - `await pause(FUNNEL_OUTCOME_INTERVAL_MS)` between tickers.
   - Return `{ tickers, scored, pending, failures, rateLimited }`, where
     `tickers` is how many tickers were actually fetched.
     `funnel-schedule.ts` logs it verbatim, so the new fields reach the logs with
     no other change.

**Verify**: `pnpm typecheck` → exit 0 once step 5 is also done (it will point
at `funnel-schedule.ts` until then; fix it there, never with a cast).

### Step 5: Inject the Tiingo candle source at the IO edge

In `agent/lib/funnel-schedule.ts`, import `tiingoFromEnv` from `./tiingo.ts`,
leave `finnhubFromEnv()` at line 50 untouched, and build the candle source
inside the existing scoring `try` block so a missing key is a logged warning:

```ts
  // Outcome scoring for the directional shadow. Best-effort and last, so it can never eat into
  // the screening budget; if the function is short on time this is the part that gets cut.
  // Candles come from Tiingo, not from the Finnhub client above: Finnhub's /stock/candle is
  // gated on our tier and 403s on every call, which is why this scored nothing for months.
  try {
    const candles = tiingoFromEnv();
    const scored = await scoreFunnelOutcomes({ candles, memory, now, logger });
    logger.log(`[${schedule}] outcomes: ${JSON.stringify(scored)}`);
  } catch (err) {
    logger.warn(`[${schedule}] outcome scoring failed (non-fatal):`, err);
  }
```

**Verify**: `pnpm typecheck` → exit 0, and
`node --test --experimental-strip-types agent/lib/funnel.test.ts` → all pass,
including step 2's test.

### Step 6: Prove it against the live API, once, locally

Write a throwaway script outside the repo (for example `/tmp/check-tiingo.ts`)
that prints shapes only, never the key:

```ts
import { tiingoFromEnv } from "/absolute/path/to/your/worktree/agent/lib/tiingo.ts";

for (const symbol of ["AAPL", "BRK-B"]) {
  const c = await tiingoFromEnv().getCandles(symbol, "2026-09-01", "2026-09-30");
  console.log(symbol, "candles:", c.length, "first:", c[0], "last:", c.at(-1));
}
```

Run it with `node --env-file=/Users/lucien/src/luciengeorge/poof/.env.local --experimental-strip-types /tmp/check-tiingo.ts`.
That is 2 of the 50 hourly requests; do not run it in a loop. If `.env.local`
has no `TIINGO_API_KEY`, STOP and report it; never copy the production value.

**Verify**: both symbols print at least 15 candles, each `date` `YYYY-MM-DD`,
each `close` positive. If `BRK-B` fails while `AAPL` works, record the exact error
and STOP; do not add a symbol-mapping layer. Delete the script afterwards.

### Step 7: Correct the two places that call `TIINGO_API_KEY` local-only

`.env.example:28` ends with `# LOCAL ONLY: live candles for the backtest harness
(agent/lib/tiingo.ts). Not used by the live trading cycle or CI evals.` Change
that comment so it says the funnel's outcome scorer uses it in production
(`agent/lib/funnel-schedule.ts`) as well as the local backtest harness, and that
without it the scorer skips and logs. Touch nothing else in the file.

`README.md:77` says `TIINGO_API_KEY` "is only needed locally for backtests".
Correct it the same way: still not needed by the trading cycle or CI evals, now
required by the funnel schedules in production.

**Verify**: `grep -n "LOCAL ONLY" .env.example` → no output.

### Step 8: Gate on the production variable

Re-run `npx vercel env ls production`. If `TIINGO_API_KEY` is not listed for
Production, do not mark this plan DONE: set its `plans/README.md` row to
`BLOCKED (TIINGO_API_KEY not set on Vercel production)` and say so in your report.

### Step 9: Mutation-check your own tests

For each mutation: back up with `/bin/cp -f <file> /tmp/<name>.bak`, make the
change, **confirm it landed with grep and read the line** (`cp` is aliased to
`cp -i` here and has silently refused before), run the funnel tests, restore
with `/bin/cp -f`, then **confirm the restore** with `git diff <file>` and a green
run.

- **A, the wiring.** In `funnel-schedule.ts` pass the Finnhub client again:
  `scoreFunnelOutcomes({ candles: news, memory, now, logger })` (it still
  typechecks). Step 2's structural test must go RED.
- **B, one request per ticker.** In `scoreFunnelOutcomes`, move the
  `getCandles` call inside the per-item loop. The "one request per ticker" test
  must go RED.
- **C, the 429 stop.** Replace the `break` on a 429 with `continue`. The "stops
  on a 429" test must go RED.
- **D, the recording.** Change the `scored +=` line to add 0. The existing
  "records finished items and leaves the rest pending" test must go RED.
- **E, the moving start.** Replace the `offset` expression with `0`. Tests 3
  and 6 must go RED. (Pick test 3's `NOW` so that `Math.floor(NOW / 60_000) % 12`
  is not 0, and assert that in the test, or this mutation cannot be seen.)

**Verify**: all five went red and everything is green after each restore. A
mutation that leaves the suite green is a STOP condition.

### Step 10: Confirm nothing else moved

- `pnpm typecheck` → exit 0
- `npx tsc -p convex/tsconfig.json` → exit 0
- `pnpm test` → exit 0 with `ℹ fail 0` and at least 7 more tests than before you
  started (record the count in step 0)
- `git status --short` lists only the in-scope files

## Test plan

All new tests in `agent/lib/funnel.test.ts`, using `node:test`,
`node:assert/strict` and the existing `fakeMemory()` at `agent/lib/funnel.test.ts:86`.
Extend it exactly like this: the head query returns the awaiting items sorted by
`screenedAt` ascending with a STABLE sort (several fixtures share a
`screenedAt`, and tests 3 and 6 depend on order); the per-ticker query returns
the awaiting items for that ticker; `recordFunnelOutcomes(batch)` pushes the
batch onto a new `batches` array AND appends each entry to the existing
`outcomes` array, so the existing test's `store.outcomes[0]?.id` check keeps
working. Neither query needs to filter by date: the fixtures control that. The
existing test "outcome scoring records finished items and leaves the rest
pending" keeps its assertions; change only `news:` to `candles:` and whatever the
fake needs.

1. **The wiring** (step 2, structural).
2. **One request per ticker.** Three awaiting items for ticker X on two
   different screening days plus one for Y; the candle source records its calls.
   Assert exactly two `getCandles` calls (X once, Y once), that X's call starts at
   X's oldest screening day, and that all four outcomes reached
   `recordFunnelOutcomes` in two batches.
3. **At most `FUNNEL_OUTCOME_TICKERS_PER_RUN` tickers per fire, from a moving
   start.** Give the head 12 distinct tickers; assert exactly 10 `getCandles`
   calls, and that they are the 10 consecutive (wrapping) tickers starting at
   `Math.floor(NOW / 60_000) % 12` in head order.
4. **A non-429 error on one ticker does not abort the batch.** X throws a plain
   `Error`, Y returns a full window. Assert `failures: 1`, Y's outcome recorded,
   `rateLimited: false`.
5. **The batch stops on a 429.** X throws an error object with `status: 429`;
   Y would succeed. Pass a `now` for which the run starts at X (with two
   tickers in head order X, Y that means `Math.floor(now / 60_000) % 2 === 0`),
   and assert that precondition in the test. Assert Y was never requested, `rateLimited: true`,
   `failures: 1`, `scored: 0`.
6. **A ticker that always fails cannot block every fire.** 11 distinct tickers;
   the first in head order always throws a plain `Error`. Run the scorer twice
   with `now` values one minute apart; assert the two runs did not request the
   same first ticker, and that between them more than 10 distinct tickers were
   requested.
7. **Young items stay pending.** A window shorter than
   `FUNNEL_OUTCOME_TRADING_DAYS + 1` candles counts as `pending` and records
   nothing for that item.

Verification: `pnpm test` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0` and at least 7 more tests than at step 0
- [ ] `grep -n "getCandles" agent/lib/funnel.ts` shows it on `FunnelCandleSource`
      and the scorer's single call site, not on `FunnelNewsSource`
- [ ] `grep -rn FUNNEL_OUTCOMES_PER_RUN agent` returns nothing
- [ ] `grep -n "tiingoFromEnv" agent/lib/funnel-schedule.ts` matches, and
      `grep -n "finnhubFromEnv" agent/lib/funnel-schedule.ts` still matches
- [ ] `grep -n "by_ticker_and_outcome_and_screened" convex/schema.ts convex/memory.ts` matches in both
- [ ] `grep -n "LOCAL ONLY" .env.example` returns no output
- [ ] Step 6 printed real candles for both `AAPL` and `BRK-B`
- [ ] All five mutations observed red, and green after restore
- [ ] `TIINGO_API_KEY` is listed for Production, or the README row says `BLOCKED`
- [ ] `git status --short` shows only the in-scope files
- [ ] `plans/README.md` row updated: status, and the Effort cell from `S` to `M`

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the live files.
- Step 6's live call fails for `AAPL` (report the HTTP status and error body,
  with no key in it), or works for `AAPL` but not for `BRK-B`.
- A mutation in step 9 does not turn its test red.
- You conclude `outcomeFromCandles`, anything in `agent/lib/data.ts`, or
  anything in `agent/lib/tiingo.ts` must change, or that `funnelItems` needs a
  new field.
- Typecheck pushes you toward an `any`, a `@ts-ignore` or a double cast.
- You find yourself about to print, echo or commit the value of any environment
  variable, or to run `npx convex deploy`.

## Maintenance notes

For whoever owns this next:

- **This turns on a data flow that has never run in production.** Watch the first
  day's logs for the `[funnel-a] outcomes: {...}` lines. `scored` should be
  non-zero and `failures` should be near zero (it counts tickers, not items). If
  `failures` equals `tickers`, the provider is rejecting every call and you are
  back where you started, only louder. If `pending` is high, that is normal for recently screened items:
  `outcomeFromCandles` returns `null` until a full 10-trading-day window exists.
- **There is a backlog, and it drains on its own.** About 1,600 items were
  unscored on 2026-10-01 and about 700 arrive a day. Scoring per ticker clears a
  ticker's whole history in one request, so 40 requests a day keep up: each ticker
  comes round every 8-11 days. Do not raise `FUNNEL_OUTCOME_TICKERS_PER_RUN` past
  12: four fires can land in one hour, and Tiingo's free tier stops at 50 requests
  an hour, 1,000 a day and 500 unique symbols a month.
- **Judge the first deploy from the second fire.** `vercel.json` runs
  `convex deploy` before the new app bundle goes live, so a fire that starts in
  that window calls the old `funnelItemsAwaitingOutcome` signature and the
  removed `recordFunnelOutcome`, and logs `outcome scoring failed (non-fatal)`.
  It lands in the scorer's catch and does no harm.
- **Two fires landing in the same minute** fetch the same tickers, wasting up
  to 10 of the hour's 40 requests. That is a lost slot, not a breach of the cap.
- **`rateLimited: true` in the logs** means Tiingo answered 429 and the fire
  stopped scoring early. Once in a while is fine (someone ran a backtest in the
  funnel hour). Every fire, for days, near the end of a month, means the
  500-unique-symbol cap: scoring resumes when the month rolls over, and only items
  older than 60 days are lost. It is not documented whether Tiingo answers that
  cap with a 429 or another 4xx: if it is another 4xx, expect `failures` to climb
  with `rateLimited: false` instead. If it persists into a new month, the key itself is
  the problem.
- A reviewer should check four things: that `finnhubFromEnv()` still feeds
  `runFunnelChunk` (news provider unchanged), that the scoring block is still the
  last thing in `runFunnelSchedule` and still inside its own try/catch (so it
  cannot eat the 300-second budget or fail the fire), that the structural test
  would actually fail if the wiring were reverted, and that
  `npx convex deploy --dry-run -y` against production reports "Schema validation
  complete" with the new index (the reviewer runs it, never the executor).
- Deliberately deferred: a shared rate limiter and a request timeout across all
  HTTP providers, which is plan 011. Tiingo's client already retries 429 with
  `Retry-After` (`agent/lib/tiingo.ts:60-63`) but has no timeout, so a hung
  socket would stall the scoring block until the OS gives up. It is last in the
  fire and wrapped in a catch, so the blast radius is one fire's scoring, which
  is why this plan does not fix it.
- Once outcomes accumulate, the thing they exist for is calibrating Jev's
  `higherIn10d` against reality. Nothing in the trading path may read that number
  until it has a Brier score on a real sample; `agent/instructions.md:18` states
  that rule and this plan does not change it.
- This plan and plan 004 both edit `.env.example`. 004's change is the block at
  lines 42-53 and does not overlap line 28; rebase and keep both.
