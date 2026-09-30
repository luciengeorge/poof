# Plan 011: Give the Finnhub client a timeout, and one shared instance

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- agent/lib/data.ts agent/lib/data.test.ts agent/lib/funnel.ts agent/lib/jev.ts`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.
>
> **Read this before you start**: the "Scope change from the plan title" section
> below explains why the shared rate limiter is NOT in this plan. Do not build
> one.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-reinstall-dependency-tree.md (so the test run is evidence)
- **Category**: perf
- **Planned at**: commit `0859c96`, 2026-09-30

## Scope change from the plan title

This plan was scoped as "timeout plus shared rate limiter". On reading the
code, those are two changes with very different risk, and bundling them would
make the result unattributable. **This plan does the timeout and the shared
client. It does NOT add a rate limiter.**

The reasoning, so nobody re-derives it:

- The timeout is a strict safety improvement. It can only turn an unbounded
  stall into a caught, counted, logged failure. Nothing gets slower.
- A rate limiter is not. Finnhub's free tier is 60 requests a minute. Pacing
  every call at one per second would serialise `get_prices`, which today sends
  up to 40 quotes in parallel and returns in about a second. Paced, that same
  call takes about 42 seconds. Inside a 300 second Vercel Hobby wall, on the
  cycle that actually trades, that is a large and possibly harmful regression.
  The correct design is a token bucket that permits a burst up to the
  per-minute allowance and only throttles beyond it, and getting that right
  needs a measured 429 rate to size against. Nobody has measured one.
- The limiter also depends on this plan: a limiter only limits anything if it
  lives on a shared instance, and there is no shared instance today. Step 4
  creates it.

So: build the timeout, build the shared instance, and leave the limiter to a
follow-up plan that can measure its own effect against a working baseline. Say
this in your final report.

## Why this matters

poof runs on Vercel Hobby. One cron fire gets a **300 second function wall**,
after which the platform kills the function outright. A kill is not an
exception: no `catch` runs, no `finally` runs, no cleanup happens.

The wide funnel is the piece that lives closest to that wall. Each fire claims
one chunk of the S&P 500 and reads company news for every ticker in it,
sequentially, paced. Measured on a 12-ticker sample, a Finnhub fetch averages
about **132 ms**, and the funnel adds a **1050 ms** pause after each ticker. So
a full 126-ticker chunk costs about **149 seconds** of the 300 second budget in
the healthy case, leaving roughly 151 seconds of headroom.

`FinnhubProvider` issues a **bare `fetch` with no `AbortController` and no
timeout.** One Finnhub read that hangs rather than errors therefore has no
bound at all. It can consume the whole remaining 151 seconds by itself and take
the function down with it. When that happens, the funnel chunk stays at status
`started` for ever, because the code that would mark it `failed` never runs.

That is not hypothetical in this repo. A silent stall of exactly this shape,
where a broken funnel left no trace while its cron heartbeat kept reporting
`dispatched=true`, ran for 13 days before anyone noticed. `agent/lib/funnel-schedule.ts:43-45`
carries the scar as a comment:

```ts
  // Everything after the claim belongs in the try: a throw out here would leave the chunk at
  // `started` for good, which is how a broken universe load went unnoticed for thirteen days.
```

A `try` cannot save you from a process kill. A deadline can.

The repo already knows this. `agent/lib/jev.ts` aborts at 8 seconds.
`agent/lib/alpaca.ts` aborts at 8 seconds. `agent/lib/fetch-timeout.ts` exists
as a general wrapper. Finnhub, the single most-called external service in the
system and the only one on the critical path of a 149-second loop, got none of
it.

## Current state

### The unbounded fetch

`agent/lib/data.ts:120-149`. `FinnhubProvider` and the one method every public
call funnels through:

```ts
export class FinnhubProvider implements MarketDataProvider {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: FinnhubConfig) {
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = new URL(FINNHUB_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("token", this.apiKey);
    // Finnhub's free tier is tightly rate-limited. Back off and retry on 429
    // honoring Retry-After, so a single busy symbol doesn't fail the request.
    const maxRetries = 3;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url);
      const text = await res.text();
      if (res.ok) return JSON.parse(text) as T;
      if (res.status === 429 && attempt < maxRetries) {
        await sleep(retryDelayMs(res.headers, attempt));
        continue;
      }
      throw new FinnhubError(res.status, text);
    }
  }
```

`const res = await this.fetchImpl(url);` at line 140 is the whole problem: no
second argument, so no `signal`.

Note the retry loop. It multiplies the exposure. `retryDelayMs`
(`agent/lib/http-backoff.ts:5-15`) caps each backoff at 10 seconds, so a
persistent 429 costs up to 30 seconds of sleep **plus four unbounded fetches**
in a single `get()` call. A per-attempt timeout alone does not bound that, which
is why step 3 adds a whole-call budget as well.

`FINNHUB_BASE` is `agent/lib/data.ts:3`:
```ts
const FINNHUB_BASE = "https://finnhub.io/api/v1";
```

### The shape to copy

`agent/lib/jev.ts:28` and `agent/lib/jev.ts:131-146`:

```ts
export const JEV_TIMEOUT_MS = 8_000;
```

```ts
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(JEV_ENDPOINT, {
        method: "POST",
        headers: { /* ... */ },
        body: JSON.stringify({ state, model: this.model, questions }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
```

`agent/lib/alpaca.ts:21` has the identical `ALPACA_TIMEOUT_MS = 8_000` and the
same `AbortController` + `clearTimeout` in a `finally`. Match this shape.
`HttpJevClient` also takes `timeoutMs` as a constructor parameter defaulting to
the constant (`agent/lib/jev.ts:117-127`), purely so tests can use a short
deadline. Do the same for `FinnhubConfig`.

**Note**: `grep -rn "abort\|timeoutMs" agent/lib/jev.test.ts agent/lib/alpaca.test.ts`
returns nothing. Neither existing timeout has a test. Yours will be the first,
so it has to be a good one, and step 6 mutation-checks it.

### The funnel loop that depends on the bound

`agent/lib/funnel.ts:30-37`:

```ts
export const FUNNEL_CHUNKS = 4;
/** Finnhub free tier is 60/min; one call a second with headroom for the occasional retry. */
export const FUNNEL_FINNHUB_INTERVAL_MS = 1_050;
/** Company news is fetched over this window, then trimmed to items that are actually recent. */
export const FUNNEL_NEWS_MAX_AGE_HOURS = 36;
export const FUNNEL_ITEMS_PER_TICKER = 5;
/** How many items one fire may screen, so a busy news day cannot outrun the 300 s budget. */
export const FUNNEL_MAX_ITEMS_PER_CHUNK = 220;
```

`agent/lib/funnel.ts:180-193`:

```ts
  const candidates: { ticker: string; item: NewsItem }[] = [];
  let failures = 0;
  for (const ticker of tickers) {
    try {
      const raw = await deps.news.getCompanyNews(ticker, fromISO, toISO);
      for (const item of selectTickerNews(raw, startedAt)) candidates.push({ ticker, item });
    } catch (err) {
      failures += 1;
      logger.warn(`[funnel] news failed for ${ticker}:`, err);
    }
    if (candidates.length >= FUNNEL_MAX_ITEMS_PER_CHUNK) break;
    await pause(FUNNEL_FINNHUB_INTERVAL_MS);
  }
```

The per-ticker `try/catch` is already correct: a throw counts a failure and the
loop carries on. So once a stalled read THROWS instead of hanging, the funnel
degrades gracefully with no further change. That is the entire point of this
plan, and it is why `funnel.ts` itself needs no edit.

The chunk size: `agent/data/universe.ts` holds 503 tickers,
`universeChunk` (`agent/lib/universe.ts:39-43`) stripes them across
`FUNNEL_CHUNKS = 4`, so a chunk is **126 tickers**.

**The arithmetic, which you should re-check after your change:**

| | per ticker | 126 tickers |
|---|---|---|
| healthy (132 ms fetch + 1050 ms pace) | 1182 ms | **149 s** of 300 s |
| one stall, today (unbounded) | up to 151 s | **function killed** |
| one stall, with an 8 s per-attempt bound | 9050 ms | 157 s, survives |

With an 8 second bound, roughly 19 stalled tickers in one chunk are survivable
before the wall bites, versus **one** today.

### The per-call-site construction

`agent/lib/data.ts:229-233`:

```ts
export function finnhubFromEnv(fetchImpl?: typeof fetch): FinnhubProvider {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error("FINNHUB_API_KEY is not set");
  return new FinnhubProvider({ apiKey, fetchImpl });
}
```

Every call builds a new provider. `agent/tools/review_performance.ts:99` and
`:120` even call `finnhubFromEnv()` twice inside one tool. Contrast
`agent/lib/t212.ts:254-269`, which memoises:

```ts
let singleton: T212Client | null = null;

export function t212FromEnv(fetchImpl?: typeof fetch): T212Client {
  if (!fetchImpl && singleton) return singleton;
  /* ... */
  const client = new T212Client({ apiKey, apiSecret, env, fetchImpl });
  if (!fetchImpl) singleton = client;
  return client;
}
```

and `agent/lib/fx.ts:100-108`, which uses the same pattern and calls it out:

```ts
/** Provider singleton so the default path shares one instance per process (mirrors t212). */
let providerSingleton: FrankfurterProvider | null = null;

export function frankfurterFromEnv(fetchImpl?: typeof fetch): FrankfurterProvider {
  if (!fetchImpl && providerSingleton) return providerSingleton;
  const p = new FrankfurterProvider({ fetchImpl });
  if (!fetchImpl) providerSingleton = p;
  return p;
}
```

`agent/lib/fx.ts:151-153` exports a test hook for the cache, which is the
convention for resetting module-level state in tests:

```ts
/** Test hook: clear the per-process FX cache. */
export function resetFxCache(): void {
  cache = null;
}
```

### Why the shared instance matters even without a limiter

Within one cycle, these tools each build their own provider:
`get_prices` (up to **40** symbols, all in one `Promise.allSettled`,
`agent/tools/get_prices.ts:13-15`), `get_earnings_calendar` (up to **20**, all
in one `Promise.all`, `agent/tools/get_earnings_calendar.ts:22-24`),
`get_news`, `review_external_holdings`, `review_performance` (twice) and
`submit_orders`. Sixty requests inside a few seconds against a 60/min tier is
already at the ceiling before anything else runs.

Nothing in the current design can see that, because there is no single object
through which the calls pass. The shared instance is the place a future limiter
or a request counter can live. It is also, on its own, the cheapest possible
step: no behaviour changes.

### Conventions

- Pure, unit-tested functions; IO at the edges. Comments explain WHY, at length,
  and are not written on every line.
- No em-dashes.
- **NEVER use TypeScript parameter properties** (`constructor(private readonly x)`).
  `--experimental-strip-types` cannot erase them and the test file dies with a
  bare "test failed". Assign fields in the constructor body, as
  `FinnhubProvider` already does.
- Tests: `node:test` + `node:assert/strict`, plain object fixtures, no mocking
  framework. `agent/lib/data.test.ts` is the exemplar; read its `fakeFetch`
  helper at lines 5-21 before writing anything.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck (app) | `pnpm typecheck` | exit 0 |
| Typecheck (convex) | `npx tsc -p convex/tsconfig.json` | exit 0 |
| This file's tests | `node --test --experimental-strip-types agent/lib/data.test.ts` | all pass |
| Funnel tests | `node --test --experimental-strip-types agent/lib/funnel.test.ts` | all pass |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |
| Build | `pnpm build` | exit 0 |

Node must be 24.x. `pnpm test` prints `ℹ pass N` / `ℹ fail N` on Node 24 (Node
22 prints `# pass N` instead, so a grep pinned to one form silently matches
nothing). If you see the `#` form, you are on the wrong Node and plan 001 has
not landed. STOP.

## Scope

**In scope** (the only files you should modify):
- `agent/lib/data.ts`, `FinnhubConfig`, `FinnhubProvider.get`, `finnhubFromEnv`, one new exported constant, one new exported reset hook
- `agent/lib/data.test.ts`, new tests

**Out of scope** (do NOT touch, even though they look related):
- **A rate limiter, a token bucket, a queue, or any pacing of Finnhub calls.**
  See "Scope change from the plan title". Building one here makes both changes
  unmeasurable and risks a large latency regression on the trading cycle.
- **`FUNNEL_FINNHUB_INTERVAL_MS`, `FUNNEL_CHUNKS`, `FUNNEL_MAX_ITEMS_PER_CHUNK`,
  or anything about the funnel's chunking** (`agent/lib/funnel.ts:30-37`).
  Those numbers are load-bearing against the 300 s wall and were tuned
  deliberately. The funnel needs no edit: its per-ticker `try/catch`
  (`agent/lib/funnel.ts:183-190`) already handles a throw correctly, and this
  plan's whole job is turning a hang into a throw.
- `agent/lib/jev.ts` and `agent/lib/alpaca.ts`. Read them as the pattern; do
  not refactor them into a shared helper. That is a separate cleanup and it
  would put two more services' timeouts at risk for no gain here.
- `agent/lib/fetch-timeout.ts`. It exists, but its doc comment explicitly
  scopes it to observability hooks and states "NOT applied to the trading
  path". Do not widen that contract in this plan. Write the `AbortController`
  inline, matching `jev.ts`.
- `agent/tools/*`. No tool changes. `finnhubFromEnv()` keeps its signature, so
  every call site keeps working untouched.
- The retry budget (`maxRetries = 3`) and `retryDelayMs`. You are bounding how
  long each attempt may take, not how many attempts there are.

## Git workflow

- Branch: `advisor/011-finnhub-timeout`
- Two commits, in this order, so the risky-ish one is separable:
  1. `fix(data): bound every Finnhub read, so one stall cannot blow the 300s wall`
  2. `refactor(data): one Finnhub provider per process, mirroring t212 and fx`
- Conventional commits, imperative subject, body explaining the mechanism.
  Recent examples from `git log`: `fix(funnel): the universe never reached the
  deployed bundle`, `fix(benchmark): rebase the baseline across a cash flow`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing timeout test first

Add to `agent/lib/data.test.ts`. The test needs a fetch that HANGS rather than
errors, and must observe the abort. Target shape:

```ts
/** A fetch that never resolves on its own; it settles only when aborted. */
function hangingFetch() {
  let aborted = false;
  const fn = async (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  };
  return { fn: fn as unknown as typeof fetch, wasAborted: () => aborted };
}
```

Then:

```ts
test("a hanging Finnhub read is aborted at the deadline instead of waiting for ever", async () => {
  const h = hangingFetch();
  const p = new FinnhubProvider({ apiKey: "KEY", fetchImpl: h.fn, timeoutMs: 25 });
  const startedAt = Date.now();
  await assert.rejects(() => p.getQuote("AAPL"));
  assert.ok(h.wasAborted(), "the AbortSignal must have fired");
  assert.ok(Date.now() - startedAt < 2_000, "must not have waited anywhere near the default");
});
```

Use a short `timeoutMs` (tens of milliseconds) so the suite stays fast, and
assert `wasAborted()` rather than only timing: a test that passes purely on
elapsed time can go green for the wrong reason.

**Verify**: `node --test --experimental-strip-types agent/lib/data.test.ts`
→ the new test **FAILS**, and it must fail by hanging until the node test
runner's own timeout, not by a type error. Everything else passes. A new test
that passes before the fix is not testing the fix.

If it fails with a TypeScript error because `timeoutMs` is not on
`FinnhubConfig` yet, add the field in step 2 and re-run this step to see the
real red.

### Step 2: Add the per-attempt deadline

In `agent/lib/data.ts`:

1. Add the constant beside `FINNHUB_BASE`, with a WHY comment in this repo's
   style. It should say that the funnel reads 126 tickers sequentially inside a
   300 second wall, that a kill runs no `catch`, and that a bound turns a hang
   into a counted failure:

```ts
/**
 * Deadline for one Finnhub HTTP attempt. Matches JEV_TIMEOUT_MS and
 * ALPACA_TIMEOUT_MS. ...
 */
export const FINNHUB_TIMEOUT_MS = 8_000;
```

2. Add `timeoutMs?: number` to `FinnhubConfig` (`agent/lib/data.ts:59-62`), and
   a `private readonly timeoutMs: number;` field assigned in the constructor
   body with `cfg.timeoutMs ?? FINNHUB_TIMEOUT_MS`. **Assign it in the body. Do
   not use a parameter property.**

3. In `get`, wrap the fetch, matching `agent/lib/jev.ts:131-146`:

```ts
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
```

Note the `finally`: the timer must be cleared on the success path too, or a
long-lived process accumulates pending timers.

**Verify**: `node --test --experimental-strip-types agent/lib/data.test.ts`
→ all pass, including step 1's test.

### Step 3: Bound the whole call, not just one attempt

A per-attempt deadline does not bound `get()`, because of the retry loop. Worst
case today with an 8 second per-attempt bound is four attempts plus three
backoff sleeps capped at 10 seconds each: `4 * 8 + 30 = 62` seconds for ONE
ticker. Three such tickers exceed the funnel's 151 seconds of headroom, so the
per-attempt bound alone does not actually close the hole this plan exists to
close.

Add a whole-call budget:

```ts
/**
 * Ceiling for one `get()` INCLUDING its 429 retries and their backoff sleeps.
 * The per-attempt deadline alone does not bound the call: four attempts plus
 * three ten-second backoffs is 62 s, and the funnel's headroom inside the
 * 300 s wall is about 151 s, so three bad tickers would still kill the
 * function. Past this budget the call gives up and throws, which the funnel's
 * per-ticker catch already handles as a counted failure.
 */
export const FINNHUB_CALL_BUDGET_MS = 20_000;
```

In `get`, capture a deadline before the loop and check it before each retry:

```ts
    const deadline = Date.now() + this.callBudgetMs;
    // ... inside the loop, at the retry branch:
      if (res.status === 429 && attempt < maxRetries) {
        const delay = retryDelayMs(res.headers, attempt);
        if (Date.now() + delay >= deadline) throw new FinnhubError(res.status, text);
        await sleep(delay);
        continue;
      }
```

Make `callBudgetMs` a `FinnhubConfig` field too, defaulting to the constant, so
tests can shorten it.

Throwing `FinnhubError` rather than a bare `Error` keeps the error type callers
already handle (`agent/tools/get_earnings_calendar.ts:33-41` catches and
degrades; `agent/lib/funnel.ts:186-189` catches and counts).

**Verify**: `node --test --experimental-strip-types agent/lib/data.test.ts`
→ all pass, including the new budget test from the test plan below. Also
re-run the existing test at `agent/lib/data.test.ts:37-49`
("persistent 429 retries the full budget then throws FinnhubError", which
asserts `f.calls.length === 4`): it must STILL pass, because the default
`FINNHUB_CALL_BUDGET_MS` is large enough that a fake fetch's instant 429s never
approach it. If that test now fails, your budget check is firing when it should
not. Fix it; do not change that test.

### Step 4: One provider per process

Rewrite `finnhubFromEnv` to memoise, mirroring `t212FromEnv`
(`agent/lib/t212.ts:254-269`) and `frankfurterFromEnv` (`agent/lib/fx.ts:100-108`)
exactly:

```ts
/**
 * Per-process singleton so every tool in one serverless invocation shares one
 * provider, mirroring t212FromEnv and frankfurterFromEnv. Finnhub is the most
 * called external service here and was the only one still constructing a fresh
 * client per call site, which left nowhere for a shared request budget to live.
 * Only memoised on the default path; callers that inject a fetchImpl (tests)
 * always get a fresh provider.
 */
let providerSingleton: FinnhubProvider | null = null;

export function finnhubFromEnv(fetchImpl?: typeof fetch): FinnhubProvider {
  if (!fetchImpl && providerSingleton) return providerSingleton;
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error("FINNHUB_API_KEY is not set");
  const p = new FinnhubProvider({ apiKey, fetchImpl });
  if (!fetchImpl) providerSingleton = p;
  return p;
}

/** Test hook: drop the per-process provider. Mirrors resetFxCache in fx.ts. */
export function resetFinnhubProvider(): void {
  providerSingleton = null;
}
```

Now read the two existing tests at `agent/lib/data.test.ts:183-200`:

```ts
test("finnhubFromEnv throws when FINNHUB_API_KEY is unset", () => {
```
and
```ts
test("finnhubFromEnv returns a provider when the key is set", () => {
```

**These two tests now interact through module-level state.** Whichever runs
first can memoise a provider that makes the other pass or fail for the wrong
reason. Add `resetFinnhubProvider()` at the top of each, and add a comment
saying why. This is exactly the kind of order-dependent green this repo has
been bitten by.

**Verify**: `node --test --experimental-strip-types agent/lib/data.test.ts`
→ all pass. Then run it twice more to check for order dependence:
`for i in 1 2 3; do node --test --experimental-strip-types agent/lib/data.test.ts || echo "RUN $i FAILED"; done`
→ no `RUN n FAILED` line.

### Step 5: Confirm nothing else moved

**Verify**: `pnpm test` → exit 0, `ℹ fail 0`.
Then `pnpm typecheck` → exit 0, `npx tsc -p convex/tsconfig.json` → exit 0,
`pnpm build` → exit 0.

If an existing test now fails, read it carefully before editing it. The only
legitimate reason a test changes here is the singleton in step 4. If a test
fails for any other reason, STOP.

### Step 6: Mutation-check your own tests

This repo has shipped VACUOUS TESTS four times, and the two timeouts that
already exist in this codebase (`jev.ts`, `alpaca.ts`) have **no tests at all**.
Yours is the first, so prove it bites.

**Mutation A, the per-attempt deadline:**

1. Back up: `/bin/cp -f agent/lib/data.ts /tmp/data.bak`
2. Mutate: in `get`, remove `{ signal: controller.signal }` so the fetch call
   is bare again (`const res = await this.fetchImpl(url);`).
3. **Confirm the mutation actually landed**: run
   `grep -n "fetchImpl(url" agent/lib/data.ts` and READ the output. It must
   show the bare form with no `signal`. `cp` is aliased to `cp -i` in this
   environment and has silently refused to overwrite before, producing a false
   green. Never trust an unread copy or an unread edit.
4. Run `node --test --experimental-strip-types agent/lib/data.test.ts`
   → the step-1 timeout test must go **RED** (it will hang until the runner
   gives up, which is the correct red here).
5. Restore: `/bin/cp -f /tmp/data.bak agent/lib/data.ts`
6. **Verify the restore landed**: `grep -n "controller.signal" agent/lib/data.ts`
   shows it again, AND `pnpm test` passes. A silent no-op restore turns an
   unrelated later failure into false proof that the test works.

**Mutation B, the call budget:**

Repeat the same six-part cycle. Mutate by deleting the
`if (Date.now() + delay >= deadline) throw ...` line. Confirm with
`grep -n "deadline" agent/lib/data.ts` before running. The budget test must go
red.

**Mutation C, the singleton:**

Repeat. Mutate by deleting `if (!fetchImpl && providerSingleton) return providerSingleton;`.
Confirm with `grep -n "providerSingleton" agent/lib/data.ts`. The identity test
must go red.

**Verify**: you observed all three tests go red under their mutation, having
read a grep confirming each mutation landed, and green after each restore.

### Step 7: Re-check the arithmetic against your own change

State the new worst case explicitly, in the commit body, using YOUR constants:

```
healthy chunk:     126 x (132 ms fetch + 1050 ms pace) = ~149 s of 300 s
headroom:          ~151 s
per stalled ticker: FINNHUB_TIMEOUT_MS + FUNNEL_FINNHUB_INTERVAL_MS
stalls survivable:  floor(headroom / (FINNHUB_TIMEOUT_MS - 132 ms))
worst case per ticker with persistent 429: capped at FINNHUB_CALL_BUDGET_MS
```

**Verify**: `grep -n "FINNHUB_TIMEOUT_MS\|FINNHUB_CALL_BUDGET_MS" agent/lib/data.ts`
→ both constants exist and are exported, and the numbers you quoted in the
commit body match the values you actually shipped.

## Test plan

All in `agent/lib/data.test.ts`, modelled on its existing `fakeFetch` helper
(lines 5-21) and its existing 429 tests (lines 37-64):

1. **The regression** (step 1): a hanging fetch is aborted at the deadline.
   Asserts both that `AbortSignal` fired and that the elapsed time is small.
2. **Every attempt carries a signal**: a `fakeFetch` variant that records
   `init?.signal` asserts it is an `AbortSignal` and not `undefined`, on a
   normal 200 response. Catches a signal that is only passed on some paths.
3. **The timer is cleared on success**: a successful `getQuote` followed by
   `assert.ok(true)` proves nothing on its own, so instead assert that a
   provider with `timeoutMs: 20` can complete ten sequential successful calls
   without any of them rejecting. If the timer were not cleared the aborts
   would leak across calls.
4. **The call budget bounds a persistent 429**: a fetch that always returns 429
   with `retry-after: 10`, a provider with `callBudgetMs: 50`, must reject with
   a `FinnhubError` after FEWER than the full four attempts. Assert on
   `f.calls.length < 4`, so the test distinguishes "budget fired" from "retries
   exhausted".
5. **The existing 429 test still holds**: `agent/lib/data.test.ts:37-49` must
   still see exactly four calls with the default budget. Do not modify it.
6. **Singleton identity**: `resetFinnhubProvider()`, then
   `assert.equal(finnhubFromEnv(), finnhubFromEnv())`.
7. **Injection still bypasses the singleton**: with a `fetchImpl` argument, two
   calls return different instances, and neither is the memoised one.
8. **Reset works**: `finnhubFromEnv()`, `resetFinnhubProvider()`,
   `finnhubFromEnv()` returns a DIFFERENT instance. Without this the reset hook
   itself is untested and the other tests' isolation is unproven.
9. Add `resetFinnhubProvider()` to the two existing `finnhubFromEnv` tests
   (lines 183-200) so they stop depending on execution order.

Verification: `pnpm test` → exit 0, `ℹ fail 0`, eight more tests than the
plan-001 baseline.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0`, eight more tests than the plan-001 baseline
- [ ] `pnpm build` exits 0
- [ ] `grep -n "controller.signal" agent/lib/data.ts` → the fetch in `get` passes a signal
- [ ] `grep -cE "^export const FINNHUB_(TIMEOUT|CALL_BUDGET)_MS" agent/lib/data.ts` → `2`
- [ ] `grep -n "providerSingleton" agent/lib/data.ts` → the memoisation exists
- [ ] `grep -n "resetFinnhubProvider" agent/lib/data.ts agent/lib/data.test.ts` → defined and used
- [ ] `grep -n "FUNNEL_FINNHUB_INTERVAL_MS = 1_050" agent/lib/funnel.ts` still matches, the funnel constants did NOT change
- [ ] `git diff --stat 0859c96..HEAD -- agent/lib/funnel.ts` → empty
- [ ] `grep -riE "ratelimit|token.?bucket|limiter" agent/lib/data.ts` → no new limiter was built
- [ ] `grep -n "constructor(private\|constructor(readonly\|constructor(public" agent/lib/data.ts` → no matches (no parameter properties)
- [ ] Running `node --test --experimental-strip-types agent/lib/data.test.ts` three times in a row passes every time
- [ ] You observed all three mutations (A, B, C) turn their test red, each confirmed by a grep you read, and green after restore
- [ ] `git status` shows only `agent/lib/data.ts` and `agent/lib/data.test.ts` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `pnpm test` prints `# pass N` rather than `ℹ pass N`. You are on Node 22 and
  plan 001 has not landed, so nothing you measure is evidence.
- The "Current state" excerpt of `FinnhubProvider.get` does not match the live
  `agent/lib/data.ts`.
- The step-1 test PASSES before you make any change. Then the fetch is already
  bounded somewhere you have not found, and the premise of this plan is wrong.
- A mutation in step 6 does not turn its test red.
- The existing 429 test (`agent/lib/data.test.ts:37-49`, asserting four calls)
  fails after step 3 and you cannot make it pass without editing it. Editing it
  would hide a real change to the retry budget.
- An existing test outside `data.test.ts` fails. Nothing here should be visible
  outside this module.
- You find yourself wanting to change `FUNNEL_FINNHUB_INTERVAL_MS`, the chunk
  count, or the funnel loop. Those are out of scope and they are tuned against
  a 300 second wall.
- You conclude a rate limiter is needed to make a test pass. It is not, and
  building one here is explicitly out of scope.
- A test needs more than about two seconds of wall time. A timeout test that
  actually waits eight seconds will make the suite unpleasant and will tempt
  the next person to delete it. Inject a short `timeoutMs`.

## Maintenance notes

- **`FINNHUB_TIMEOUT_MS` is coupled to the funnel's budget.** If
  `FUNNEL_CHUNKS`, `FUNNEL_FINNHUB_INTERVAL_MS`, or the size of
  `agent/data/universe.ts` changes, the headroom changes and the number of
  survivable stalls changes with it. Redo the step-7 arithmetic then.
- **The universe is 503 tickers today.** Adding names shrinks the headroom
  linearly. At roughly 250 tickers per chunk the healthy case alone reaches the
  wall, with no stalls at all.
- A reviewer should check three things: the `clearTimeout` is in a `finally`
  (a leaked timer in a warm serverless process is a slow bleed), the budget
  check happens BEFORE the sleep rather than after, and `finnhubFromEnv`'s
  memoisation only applies when no `fetchImpl` was injected. That last one is
  what keeps every existing test independent.
- **Explicitly deferred, and the reason**: the shared rate limiter. Finnhub's
  free tier is 60 requests a minute; `get_prices` alone can send 40 in
  parallel and `get_earnings_calendar` another 20, so one cycle sits at the
  ceiling. But naive pacing at one call a second would turn `get_prices` from
  about one second into about 42, inside a 300 second wall on the cycle that
  trades real money. The right shape is a token bucket that permits a burst to
  the per-minute allowance and throttles only beyond it, sized against a
  measured 429 rate that nobody has collected. That is its own plan, and step 4
  of this one gives it the shared instance it needs to live on.
- Also deferred: `agent/lib/jev.ts` and `agent/lib/alpaca.ts` have identical
  untested `AbortController` blocks. Once the pattern here is proven, folding
  all three onto one tested helper is a clean, low-risk follow-up. It is not
  this plan, because it would put two more services at risk for no gain.
