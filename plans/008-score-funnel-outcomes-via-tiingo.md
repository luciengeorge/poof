# Plan 008: Score funnel outcomes through Tiingo, not a 403 endpoint

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 0859c96..HEAD -- agent/lib/funnel.ts agent/lib/funnel.test.ts agent/lib/funnel-schedule.ts agent/lib/tiingo.ts agent/lib/data.ts`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-reinstall-dependency-tree.md (so a green test run is evidence)
- **Category**: bug
- **Planned at**: commit `0859c96`, 2026-09-30

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
hundred `funnelItems` rows sit with `outcomeAt` unset and zero scored, and have
done since the feature shipped. The repo already knows this. The doc comment on
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
two local scripts.

This is the only measurement path that exists. Of 55 live BUYs, three carry a
`jevConfidence` and none of the three has closed, so calibrating Jev off the
trading record will take months. The funnel produces hundreds of scoreable items
a day. Turn it on and the calibration experiment has data within two weeks;
leave it off and the shadow forecaster stays unfalsifiable indefinitely.

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

`agent/lib/funnel.ts:257-290`, the scorer:

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

`agent/lib/funnel-schedule.ts:45-53` builds `news` and `82-87` calls the scorer
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

Note on the summary prefix: Node 24 prints `ℹ pass N` / `ℹ fail N`, Node 22
prints `# pass N` / `# fail N`. Plan 001 puts this repo on Node 24. If you see
`#`, you are on the wrong Node and plan 001 is not done; a grep pinned to one
prefix will silently match nothing.

## Scope

**In scope** (the only files you should modify):

- `agent/lib/funnel.ts`: split the candle dependency out of `FunnelNewsSource`;
  rename the pacing constant used by the scorer
- `agent/lib/funnel-schedule.ts`: construct and inject the Tiingo candle source
- `agent/lib/funnel.test.ts`: tests
- `.env.example`: line 28 only, the `TIINGO_API_KEY` comment
- `README.md`: line 77 only, the "only needed locally" claim

**Out of scope** (do NOT touch, even though they look related):

- `agent/lib/data.ts`. Finnhub stays the news source and its `getCandles` stays
  where it is. It is still the right implementation for a tier that serves
  candles, it is tested (`agent/lib/data.test.ts:142`), and deleting it would
  break `MarketDataProvider`. Leave the 403 comment in place; it is now accurate
  history rather than a live problem.
- `agent/lib/tiingo.ts`. It works and is tested. Do not add a wrapper, a
  retry policy or a rate limiter to it here; plan 011 owns shared rate limiting.
- `outcomeFromCandles` (`agent/lib/funnel.ts:241`). The scoring maths is correct
  and tested. This plan changes where candles come from, nothing about what is
  done with them. If you find yourself editing it, you have gone off-plan.
- `FUNNEL_OUTCOMES_PER_RUN`. Raising it is tempting once scoring works (there is
  a backlog of 100+ unscored items) but it is the only bound on how many Tiingo
  symbols a fire touches, and the free tier's binding constraint is unique
  symbols, not requests per second. Changing it is a separate decision with data
  behind it; see Maintenance notes.
- `.env.example` lines 42-53. Plan 004 edits that block. Do not touch it, so the
  two plans do not collide in the same file.
- Anything about the screening path (`runFunnelChunk`, `screenFunnelItem`,
  `funnel-score.ts`). Scoring runs after it and must not disturb it.

## Git workflow

- Branch: `advisor/008-score-funnel-outcomes-via-tiingo`
- One commit. Message style from `git log`: conventional commits, subject in the
  imperative, body explaining the mechanism. For example:
  `fix(funnel): score outcomes through Tiingo, not a 403 Finnhub endpoint`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Check the production environment before writing any code

This wiring runs on Vercel, not locally. `tiingoFromEnv()` throws
`TIINGO_API_KEY is not set` when the variable is missing, and as of this plan's
writing `TIINGO_API_KEY` is **not present in the Vercel production
environment**. Every other key the funnel needs is (`FINNHUB_API_KEY`,
`TYPESAFE_API_KEY`, `CONVEX_URL`, `CONVEX_APP_SECRET`). A green deploy proves the
build, not the configuration, so check before building on the assumption.

```
npx vercel env ls production
```

**Verify**: read the output. If `TIINGO_API_KEY` is listed for Production,
record that and continue to step 2.

If it is **not** listed, that is expected, and it means this plan cannot finish
without an operator action you may not be able to perform. Continue building
(step 4 and the design in step 3 make the missing key a clean skip rather than a
crash), but treat step 7 as a hard gate and report the gap explicitly in your
final message. Do not invent, guess or paste a key, and do not print the value
of any environment variable at any point in this plan.

### Step 2: Write the failing wiring test first

Add to `agent/lib/funnel.test.ts` a structural test that fails against today's
code, modelled on the existing one at `agent/lib/funnel.test.ts:282` (which
reads schedule files as text and asserts on their contents).

The test reads `agent/lib/funnel-schedule.ts` as source text and asserts:

1. it imports from `./tiingo.ts`;
2. the call to `scoreFunnelOutcomes(` is passed a candle source, not the Finnhub
   `news` client;
3. `finnhubFromEnv()` is still what feeds `runFunnelChunk`, so this change did
   not quietly swap the news provider too.

Why structural and not behavioural: the unit tests below inject a fake candle
source and would stay green even if `funnel-schedule.ts` kept passing the 403
Finnhub client forever. That is exactly the failure that shipped here. The
comment on `agent/lib/hold-floor.test.ts:82-84` records the same lesson in the
same words; write a comment in that spirit above your test.

```ts
test("the funnel schedule scores outcomes from Tiingo, not from the Finnhub news client (structural)", () => {
  // Every unit test below injects a fake candle source, so all of them stay green if
  // funnel-schedule keeps passing the Finnhub client whose /stock/candle 403s on our tier.
  // That is precisely the bug: the scorer has never scored anything in production. The wiring
  // is only observable in this file's source, so it is asserted here.
  const src = readFileSync(new URL("./funnel-schedule.ts", import.meta.url), "utf8");
  // ... assertions
});
```

**Verify**: `node --test --experimental-strip-types agent/lib/funnel.test.ts`
→ the new test FAILS, everything else passes. A new test that passes before the
fix is not testing the fix.

### Step 3: Split the candle dependency out of `FunnelNewsSource`

In `agent/lib/funnel.ts`:

1. Remove `getCandles` from `FunnelNewsSource` (line 46). Nothing else uses it:
   `runFunnelChunk` (line 165) calls only `getCompanyNews`. Verify with
   `grep -n "getCandles" agent/lib/funnel.ts` before and after.
2. Add a separate one-method interface beside it:

```ts
/**
 * Daily candles for outcome scoring. Deliberately separate from FunnelNewsSource: the news
 * provider and the price provider are different services here, because Finnhub's /stock/candle
 * is gated on our tier and 403s, which is why no funnel outcome was ever scored. Tiingo serves
 * adjusted end-of-day bars on the free tier and returns the same Candle shape.
 */
export interface FunnelCandleSource {
  getCandles(symbol: string, fromISO: string, toISO: string): Promise<Candle[]>;
}
```

3. In `scoreFunnelOutcomes`, replace the `news: FunnelNewsSource` dependency with
   `candles: FunnelCandleSource`, and change the call site from
   `deps.news.getCandles(...)` to `deps.candles.getCandles(...)`. Keep the local
   variable name `candles` for the fetched array or rename it to avoid shadowing;
   either is fine, be consistent.
4. Rename the pacing constant used inside the scorer's loop. Leave
   `FUNNEL_FINNHUB_INTERVAL_MS` in place for the screening loop, which is still
   Finnhub, and add:

```ts
/**
 * Pause between outcome-scoring calls. Same 1,050 ms as the screening loop, so throughput is
 * unchanged by this switch, but it paces a different provider and so gets its own name. Note
 * that a per-second pause is NOT what protects us on Tiingo: its free tier is bounded by unique
 * symbols per hour and per month rather than by requests per minute, so the real control is
 * FUNNEL_OUTCOMES_PER_RUN (40 per fire, four fires a day, so at most 160 symbol-requests and
 * 160 unique symbols in a day). Raise that only with the quota in front of you.
 */
export const FUNNEL_OUTCOME_INTERVAL_MS = 1_050;
```

and use it in the scorer's `await pause(...)` at line 289. Leave the identical
call at line 192 alone: that one paces the Finnhub screening loop and is
correctly named.

Preserve two properties exactly:

- Per-item best-effort. A throw on one item increments `failures`, logs, and the
  loop continues. Do not let a provider error abort the batch.
- The returned shape `{ scored, pending, failures }` is unchanged, and
  `funnel-schedule.ts` logs it verbatim.

**Verify**: `pnpm typecheck` → exit 0. Expect the compiler to point at
`funnel-schedule.ts` if you have not done step 4 yet; that is the intended
signal, not an error to work around with a cast.

### Step 4: Inject the Tiingo candle source at the IO edge

In `agent/lib/funnel-schedule.ts`:

1. Import `tiingoFromEnv` from `./tiingo.ts`.
2. Leave the `finnhubFromEnv()` construction at line 50 exactly where it is.
   News still comes from Finnhub.
3. Build the candle source inside the existing outcome-scoring `try` block at
   lines 82-87, so an unset key is a logged skip and never a crash, and so it
   still cannot eat the 300-second budget. Target shape:

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

`tiingoFromEnv()` throwing on a missing key lands in the existing catch, so a
deployment without the variable logs one warning per fire and keeps screening.
That is the correct degradation and it is also how you will notice the variable
is missing: the log line names it.

**Verify**:

- `pnpm typecheck` → exit 0
- `node --test --experimental-strip-types agent/lib/funnel.test.ts` → all pass,
  including step 2's test, which should now be green

### Step 5: Prove it against the live API, once, locally

Unit tests with fake candle sources cannot tell you whether Tiingo actually
answers for these symbols on this account's tier. Run one real call.

Write a throwaway script outside the repo, for example at
`/tmp/check-tiingo.ts`, that imports the real provider and prints shapes only,
never the key:

```ts
import { tiingoFromEnv } from "/absolute/path/to/poof/agent/lib/tiingo.ts";

for (const symbol of ["AAPL", "BRK-B"]) {
  const c = await tiingoFromEnv().getCandles(symbol, "2026-09-01", "2026-09-30");
  console.log(symbol, "candles:", c.length, "first:", c[0], "last:", c.at(-1));
}
```

Run it with Node's own env loader rather than the `export $(grep ...)` shell
trick, which mangles values containing spaces or `#`:

```
node --env-file=.env.local --experimental-strip-types /tmp/check-tiingo.ts
```

**Verify**: both symbols print at least 15 candles, each `date` matching
`YYYY-MM-DD`, each `close` a positive number. `BRK-B` matters specifically: it
is one of only two punctuated tickers in the 503-name universe, and it is the
one that would silently fail if Tiingo wanted a different spelling.

If `BRK-B` returns an error or zero candles while `AAPL` works, do not paper over
it with a symbol-mapping table. Record the exact error and STOP: two names out of
503 failing is a known, bounded, loggable condition and the right response is a
decision, not an unreviewed mapping layer.

Delete `/tmp/check-tiingo.ts` afterwards. It must not be committed.

### Step 6: Correct the two places that call `TIINGO_API_KEY` local-only

Both statements become false the moment this lands, and a stale "you do not need
this in production" note is how the variable stays missing.

`.env.example:28` currently reads:

```
TIINGO_API_KEY=your-tiingo-api-key-here     # LOCAL ONLY: live candles for the backtest harness (agent/lib/tiingo.ts). Not used by the live trading cycle or CI evals.
```

Change the trailing comment so it says the funnel's outcome scorer uses it in
production (`agent/lib/funnel-schedule.ts`) as well as the local backtest
harness, and that without it the scorer skips and logs. Touch nothing else on
that line and no other line in the file.

`README.md:77` currently claims `TIINGO_API_KEY` "is only needed locally for
backtests. The live trading cycle and CI evals do..." Read the full sentence and
correct it the same way: still not needed by the trading cycle or CI evals,
but now required by the funnel schedules in production.

**Verify**: `grep -n "LOCAL ONLY" .env.example` → no output, exit 1. And
`grep -n "TIINGO_API_KEY" README.md .env.example` → the remaining mentions
describe production use.

### Step 7: Gate on the production variable

Re-run step 1's check.

```
npx vercel env ls production
```

**Verify**: `TIINGO_API_KEY` appears in the Production list.

If it does not, the code is correct and the feature is still dead in production.
Do not mark this plan DONE. Set its `plans/README.md` row to
`BLOCKED (TIINGO_API_KEY not set on Vercel production)` and say so plainly in
your final report, naming the command the operator needs to run
(`npx vercel env add TIINGO_API_KEY production`) without any value in it. A
merged change that silently does nothing in production is the exact pattern this
whole plan set exists to break.

### Step 8: Mutation-check your own tests

This repo has shipped vacuous tests four times: a constant compared against
itself, a mutation that landed in the wrong function, and unit tests with no
wiring test. Prove the new tests bite. Two mutations, because the structural
test and the unit tests guard different failures.

**Mutation A, the wiring.** In `agent/lib/funnel-schedule.ts`, revert step 4 by
hand: pass the Finnhub client as the candle source again
(`scoreFunnelOutcomes({ candles: news, memory, now, logger })`, which still
typechecks because `FinnhubProvider` structurally satisfies `FunnelCandleSource`).

1. Back up first: `/bin/cp -f agent/lib/funnel-schedule.ts /tmp/funnel-schedule.bak`
2. Make the change.
3. **Confirm the mutation actually landed**:
   `grep -n "scoreFunnelOutcomes" agent/lib/funnel-schedule.ts` and read the
   line. Do not skip this. `cp` is aliased to `cp -i` in this environment and
   has silently refused to overwrite before, producing a false green off a
   change that never happened.
4. Run `node --test --experimental-strip-types agent/lib/funnel.test.ts`
   → step 2's structural test must go RED.
5. Restore: `/bin/cp -f /tmp/funnel-schedule.bak agent/lib/funnel-schedule.ts`
6. **Verify the restore**: `git diff agent/lib/funnel-schedule.ts` shows only
   your intended change, and the tests pass again. A restore that silently
   no-ops turns an unrelated failure into false proof that the test works.

**Mutation B, the scorer.** In `agent/lib/funnel.ts`, break the scorer's
recording path: change `scored += 1;` to `scored += 0;`.

1. **Confirm it landed**: `grep -n "scored +=" agent/lib/funnel.ts`.
2. Run the funnel tests → the existing test at `agent/lib/funnel.test.ts:260`
   ("outcome scoring records finished items and leaves the rest pending") plus
   your new unit tests must go RED.
3. Restore and re-verify with `git diff` plus a passing run.

**Verify**: you observed the structural test go red under mutation A, the unit
tests go red under mutation B, and everything green after both restores. If a
mutation leaves the suite green, the test is not testing what it claims and that
is a STOP condition.

### Step 9: Confirm nothing else moved

**Verify**:

- `pnpm typecheck` → exit 0
- `npx tsc -p convex/tsconfig.json` → exit 0
- `pnpm test` → exit 0, `ℹ fail 0`, and 3 or more new tests versus the plan-001
  baseline
- `git status --short` lists only the five in-scope files

## Test plan

All new tests in `agent/lib/funnel.test.ts`, modelled on the tests already there
(`node:test`, `node:assert/strict`, plain fixtures, and the `readFileSync`
structural pattern at line 282):

1. **The wiring** (step 2, structural): `funnel-schedule.ts` imports
   `./tiingo.ts`, passes a candle source to `scoreFunnelOutcomes`, and still
   builds the Finnhub client for `runFunnelChunk`. This is the regression test
   for the actual bug.
2. **The scorer uses the candle source, not the news source.** Call
   `scoreFunnelOutcomes` with a candle source whose `getCandles` records the
   symbols it was asked for, and assert the recorded symbols are the items'
   tickers. Adapt the fixture at `agent/lib/funnel.test.ts:260`, which already
   builds exactly this shape with `store.setAwaiting([...])`.
3. **A provider error on one item does not abort the batch.** Two awaiting
   items; `getCandles` throws for the first and returns a full window for the
   second. Assert `{ scored: 1, failures: 1 }` and that the second item's
   outcome reached `recordFunnelOutcome`. This is the property that let a total
   403 outage look like nothing at all, so it is worth pinning explicitly.
4. **Pacing is honoured.** Pass a `sleepImpl` that records its argument and
   assert it was called with `FUNNEL_OUTCOME_INTERVAL_MS` once per item. Cheap,
   and it pins that the rename did not drop the pause.

Do not rewrite the existing test at line 260; update its `news:` dependency to
`candles:` and leave its assertions alone. If its assertions need changing to
pass, something in step 3 changed behaviour that should not have.

Verification: `pnpm test` → all pass, 3 or more new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0` and at least 3 more tests than the plan-001 baseline
- [ ] `grep -n "getCandles" agent/lib/funnel.ts` shows it only on
      `FunnelCandleSource` and at the `deps.candles.getCandles` call site, not on
      `FunnelNewsSource`
- [ ] `grep -n "tiingoFromEnv" agent/lib/funnel-schedule.ts` matches
- [ ] `grep -n "finnhubFromEnv" agent/lib/funnel-schedule.ts` still matches: news
      did not change provider
- [ ] `grep -n "LOCAL ONLY" .env.example` returns no output (exit 1)
- [ ] Step 5's live check printed real candles for both `AAPL` and `BRK-B`
- [ ] You observed both mutations turn the intended tests red, and green after restore
- [ ] `TIINGO_API_KEY` is listed for Production by `npx vercel env ls production`,
      or the `plans/README.md` row says `BLOCKED` with that reason
- [ ] `git status --short` shows only `agent/lib/funnel.ts`,
      `agent/lib/funnel-schedule.ts`, `agent/lib/funnel.test.ts`, `.env.example`
      and `README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the live files.
- Step 5's live call fails for `AAPL`. That means the Tiingo credential itself is
  dead or the tier does not serve this endpoint, and the entire premise of the
  plan is wrong. Report the HTTP status and the error body, with no key in it.
- Step 5 works for `AAPL` but not for `BRK-B`. Do not add a symbol-mapping layer
  on your own judgement; report the failure and let it be decided.
- A mutation in step 8 does not turn its test red.
- You conclude `outcomeFromCandles`, `FUNNEL_OUTCOMES_PER_RUN` or anything in
  `agent/lib/data.ts` must change to make this work. None of them does.
- Typecheck pushes you toward an `any`, a `@ts-ignore` or a double cast to make
  the provider fit. There are zero of each in non-test source today and this
  change does not need the first one. The shapes genuinely match; if they do not
  appear to, re-read `agent/lib/tiingo.ts:2`.
- You find yourself about to print, echo or commit the value of any environment
  variable.

## Maintenance notes

For whoever owns this next:

- **This turns on a data flow that has never run in production.** Watch the first
  day's logs for the `[funnel-a] outcomes: {...}` lines. `scored` should be
  non-zero and `failures` should be near zero. If `failures` equals the batch
  size, the provider is rejecting every call and you are back where you started,
  only louder. If `pending` is high, that is normal for recently screened items:
  `outcomeFromCandles` returns `null` until a full 10-trading-day window exists.
- **There is a backlog.** Over a hundred items are sitting unscored, and at 40
  per fire across four fires the backlog clears in under a day. Resist raising
  `FUNNEL_OUTCOMES_PER_RUN` to clear it faster: Tiingo's free tier is bounded by
  unique symbols per hour and per month, and 160 symbol-requests a day already
  sits inside a monthly unique-symbol budget that a larger batch would blow.
  `funnelItemsAwaitingOutcome` is ordered so the backlog drains on its own.
- A reviewer should check three things: that `finnhubFromEnv()` still feeds
  `runFunnelChunk` (news provider unchanged), that the scoring block is still the
  last thing in `runFunnelSchedule` and still inside its own try/catch (so it
  cannot eat the 300-second budget or fail the fire), and that the structural
  test would actually fail if the wiring were reverted.
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
