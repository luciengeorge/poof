# Plan 013: Measure performance over the whole record, not 50 mixed rows

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 0859c96..HEAD -- agent/tools/review_performance.ts convex/memory.ts convex/schema.ts agent/lib/memory.ts agent/lib/positions.ts`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-reinstall-dependency-tree.md (so a green test run is evidence)
- **Category**: bug
- **Planned at**: commit `0859c96`, 2026-09-30

## Amendment 2026-10-02 (read before the steps; it overrides them where they conflict)

Planned against `0859c96`; amended against `cab1f14`. The drift check shows changes in
`review_performance.ts`, `memory.ts`, `positions.ts`, `convex/memory.ts`, `convex/schema.ts` (PRs #84,
#86, #89). The targeted code is unchanged in substance; line numbers moved: the `recallRecent(env, {
tradeLimit: 50 })` fetch is now around `agent/tools/review_performance.ts:80` with the `closedTrades`
binding at ~86; `convex/memory.ts` `openBuys` is at ~653 and `recallRecent` at ~1212. `by_env_side_status`
still exists (`convex/schema.ts:86`). Compare by content. Not a STOP.

**Correction to "Why this matters".** Since PR #84 (plan 018) the instructions no longer tell the agent
to bias sizing off these stats: `agent/instructions.md` step 3 now says per-tag and overall stats are
"too small to act on" and "must not drive sizing". So the stakes are measurement accuracy (the record
the agent and the owner read, and the attribution/calibration verdicts), not live sizing. Still worth
doing; do not change the instructions.

**Note.** Index-core (VUAG) orders never reach the `trades` table (they go to `coreOrders`), so the
closed record is stocks only. Adding a query to `convex/memory.ts` needs no `convex/_generated`
regeneration (`api.d.ts` types modules via `typeof`), and no schema change is expected; if you find you
need one, STOP.

**Environment.** Run `source ~/.nvm/nvm.sh` and `nvm use` as separate commands in every shell, never
chained after a command that can fail (test output must show `ℹ tests N`, i.e. Node 24).
`convex/_generated` is now committed (PR #91), so no copy is needed. Never call live services, place
orders or run `npx convex deploy`. Stage explicit paths only.

## Why this matters

poof trades a real Trading 212 UK ISA holding roughly £250. Once a cycle it
calls `review_performance`, and that tool is where the agent learns: realised
win rate, per-strategy-tag expectancy, recurring failure patterns, and whether
the confidence it claimed at entry matches what happened. The instructions tell
it to bias sizing and selection off those numbers. They are an input to real
trades.

Every one of those numbers is computed over the most recent **50 trade rows of
any kind**. Not 50 closed trades: 50 rows, including BUYs still open, SELLs,
skipped proposals and dry-run rows. `agent/tools/review_performance.ts:42` asks
for `{ tradeLimit: 50 }` and `convex/memory.ts:1203-1207` takes 50 rows off the
`trades` table by env, newest first, with no filter on side or status. The
downstream modules then filter that sample down to whatever they can use.

Two things follow, and the second is worse than the first.

The sample is smaller than it looks. At the time of this audit the live account
had 99 trade rows of which 52 were closed, so a 50-row mixed window already
missed roughly half the closed record. `agent/lib/attribution.ts:3` describes
itself as operating on "the WHOLE closed record"; it never sees it.

And the coverage **shrinks as the account trades more**. Every new row of any
kind, including a skipped proposal that was never placed, pushes one closed
trade out of the window. The longer poof runs, the less of its own history it
can see, and the measurement quietly degrades while reporting normally. That is
the same shape as the other four instruments in this audit: broken, and
announcing nothing.

There is a second, quieter cost. `agent/lib/calibration.ts:42` sets
`MIN_CALIBRATION_SAMPLE = 10`, below which the verdict is "insufficient-data".
Truncating the sample keeps pushing the account back under thresholds it has
already earned the right to clear.

After this change, the closed record is read in full, from an index, bounded at
a level the account will not reach for years.

## Current state

Files involved:

- `agent/tools/review_performance.ts`: the tool. Fetch at lines 40-43, the
  `closedTrades` binding at lines 44-64, consumers at lines 110, 113, 162, 166,
  169.
- `convex/memory.ts`: `recallRecent` at line 1187 (the over-broad read),
  `openBuys` at line 628 (the exemplar for the new query), `getBenchmark` at
  line 614.
- `convex/schema.ts:84-86`: the `trades` indexes. `by_env_side_status` on
  `["env", "side", "status"]` already exists.
- `agent/lib/memory.ts`: the client facade. `openBuys` at line 297,
  `getBenchmark` at line 307, `recallRecent` at line 526.
- `agent/lib/positions.ts:118-134`: `outcomeKind`, the one shared definition of
  what "closed" means. Read its doc comment before writing the query.

`agent/tools/review_performance.ts:40-64` exactly as it exists today:

```ts
    const memory = memoryFromEnv();
    const env = tradingEnv();
    const [openBuysRaw, recall] = await Promise.all([
      memory.openBuys(env),
      memory.recallRecent(env, { tradeLimit: 50 }),
    ]);
    const openBuys = (openBuysRaw ?? []) as OpenBuyTrade[];
    // Full trade rows, not a narrow projection: attribution needs the entry price, the timestamps
    // and the exit levels to tell a stop-loss exit from a time exit, and calibration needs the
    // confidence claimed at entry. These come straight from Convex, so the fields are present.
    const closedTrades =
      ((recall as { trades?: unknown[] })?.trades ?? []) as {
        ticker: string;
        status: string;
        price: number;
        createdAt: number;
        closedAt?: number;
        pnl?: number;
        strategyTag?: string;
        redTeamVerdict?: string;
        exitPrice?: number;
        stopLossPct?: number;
        maxHoldDays?: number;
        predictedConfidence?: number;
      }[];
```

Note the binding is named `closedTrades` and holds nothing of the sort: it is
the raw 50-row mixed window, behind a double cast that erases the fact.

`convex/memory.ts:1203-1207`, the read behind it:

```ts
    const trades = await ctx.db
      .query("trades")
      .withIndex("by_env", (q) => q.eq("env", env))
      .order("desc")
      .take(tradeLimit ?? 20);
```

`recallRecent` also returns the benchmark row, which this tool does use
(`agent/tools/review_performance.ts:118`); everything else it returns
(`cycles`, `messages`, `riskState`, `lessons`) is ignored here.

`convex/memory.ts:628-639`, the exemplar for the new query:

```ts
export const openBuys = query({
  args: { token: v.string(), env: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    return ctx.db
      .query("trades")
      .withIndex("by_env_side_status", (q) =>
        q.eq("env", args.env).eq("side", "BUY").eq("status", "placed"),
      )
      .collect();
  },
});
```

`agent/lib/positions.ts:128-134`, the shared definition of an outcome:

```ts
export function outcomeKind(t: { status?: string; pnl?: number }): OutcomeKind {
  if (t.status === "closed-unknown") return "unknown";
  const hasPnl = typeof t.pnl === "number" && Number.isFinite(t.pnl);
  if (t.status === "closed" && hasPnl) return "real";
  if (t.status === "closed-estimated" && hasPnl) return "estimated";
  return "open";
}
```

**There are three closed statuses, not one.** `closed`, `closed-estimated` and
`closed-unknown` are all written by `agent/lib/order-bookkeeping.ts:105-111`,
and `realizedStats` (`agent/lib/positions.ts:146-147`) reports
`closedUnknown` and `closedEstimated` as separate counts. A query that returns
only `status === "closed"` would silently zero those two figures, which is the
exact class of bug the `outcomeKind` doc comment at `agent/lib/positions.ts:105-117`
was written to end. All three must be returned; the filtering stays where it is,
in `outcomeKind`.

Repo conventions that apply here:

- Pure, unit-tested functions with IO at the edges. `agent/lib/positions.ts`,
  `attribution.ts` and `calibration.ts` are pure and take rows as arguments.
  This plan changes only which rows reach them.
- Comments explain WHY, at length, and are not on every line. The doc comment
  above `outcomeKind` is the house voice.
- No em-dashes.
- `node:test` with `node:assert/strict`, plain fixtures, no mocking framework.
- Reading a source file as text to pin a structural fact is established here:
  `agent/lib/hold-floor.test.ts:81`, `agent/lib/funnel.test.ts:282`.
- Convex functions in this repo use the object form with `args` and a
  `handler`, and start with `assertSecret(args.token)` (imported from
  `./auth`). Neighbouring queries such as `openBuys` and `getBenchmark` omit a
  `returns` validator; the Convex guidelines prefer one, but adding it here
  would mean enumerating the whole `trades` document while its siblings do not.
  Match the neighbours.
- NEVER use TypeScript parameter properties (`constructor(private readonly x)`).
  `--experimental-strip-types` cannot erase them and the whole test file dies
  with a bare "test failed".

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck (app) | `pnpm typecheck` | exit 0 |
| Typecheck (convex) | `npx tsc -p convex/tsconfig.json` | exit 0 |
| Convex validation | `npx convex deploy --dry-run` | exit 0, no schema or function errors |
| Memory facade tests | `node --test --experimental-strip-types agent/lib/memory.test.ts` | all pass |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |

Note on the summary prefix: Node 24 prints `ℹ pass N` / `ℹ fail N`, Node 22
prints `# pass N` / `# fail N`. Plan 001 puts this repo on Node 24. If you see
`#`, you are on the wrong Node and plan 001 is not done; a grep pinned to one
prefix will silently match nothing.

The app typecheck (`pnpm typecheck` runs plain `tsc`) does **not** validate
`convex/`. Deploys use a stricter config with no Node types. Run
`npx tsc -p convex/tsconfig.json` separately; skipping it is how a Convex change
passes locally and fails on deploy.

## Scope

**In scope**:

- `convex/memory.ts`: add one query, `closedBuys`
- `agent/lib/memory.ts`: add the matching facade method
- `agent/tools/review_performance.ts`: use it, and drop the `recallRecent` call
- `agent/lib/memory.test.ts`: facade coverage for the new method
- `agent/lib/review-performance.test.ts` (create): the structural wiring test

**Out of scope** (do NOT touch, even though they look related):

- **`recallRecent` itself, and its `tradeLimit ?? 20` default.**
  `agent/tools/recall_memory.ts:55` is its other caller and wants exactly what
  it does: the most recent activity of every kind, for narrative recall at the
  top of a cycle. Recency is correct there. Changing the shared query to serve
  this tool would break that one.
- `agent/lib/positions.ts`, `agent/lib/attribution.ts`,
  `agent/lib/calibration.ts`. All three are pure, tested, and correct. They are
  starved of rows, not wrong about the rows they get. If a test in any of them
  fails after this change, something went wrong in the query, not in them.
- `convex/schema.ts`. `by_env_side_status` already exists and is exactly the
  index needed. Adding an index is a change against a populated table and is not
  required here. Confirm the index is there before writing the query, and if it
  is not, STOP.
- Making `trades.status` a `v.union` of literals. It is real debt, it is
  recorded as deferred in `plans/README.md`, and it is a schema change on the
  money path. Not here.
- The benchmark and alpha logic (`agent/tools/review_performance.ts:115-141`).
  It reads one row and is unaffected by the sample size.

## Git workflow

- Branch: `advisor/013-measure-the-whole-record`
- One commit. Message style from `git log`: conventional commits, subject in the
  imperative, body explaining the mechanism. For example:
  `fix(review): measure the whole closed record, not 50 mixed rows`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Measure the gap before closing it

Establish the real numbers on the live account rather than trusting this plan's.
You need them again in step 6 to prove the fix did something.

Write a throwaway script outside the repo, for example at
`/tmp/measure-record.ts`, that uses the existing facade. It reads
`CONVEX_APP_SECRET` and `CONVEX_URL` from the environment; never print either.

```ts
import { memoryFromEnv } from "/absolute/path/to/poof/agent/lib/memory.ts";
import { outcomeKind } from "/absolute/path/to/poof/agent/lib/positions.ts";

const m = memoryFromEnv();
const recall = (await m.recallRecent("live", { tradeLimit: 50 })) as { trades: any[] };
const window = recall.trades ?? [];
const closedInWindow = window.filter((t) => t.side === "BUY" && outcomeKind(t) !== "open");
console.log("rows in the 50-row window:", window.length);
console.log("closed BUYs visible today:", closedInWindow.length);
console.log("statuses in the window:", [...new Set(window.map((t) => t.status))]);
```

Run it with Node's own env loader, not the `export $(grep ...)` shell trick,
which mangles values containing spaces or `#`:

```
node --env-file=.env.local --experimental-strip-types /tmp/measure-record.ts
```

**Verify**: it prints three lines. Record all three verbatim; they are the
"before" half of step 6's evidence. Expect the window to contain a mix of
statuses including `placed`, `skipped` and `dry-run`, and the closed-BUY count
to be materially below the account's true closed count.

If `TRADING212_ENV` in your shell points at `demo`, pass `"live"` explicitly as
above anyway. This measurement is about the real account.

### Step 2: Add the `closedBuys` query

In `convex/memory.ts`, beside `openBuys` (line 628) so the pair reads together,
add:

```ts
/**
 * Statuses that mean a BUY is no longer open. All three exist and all three matter:
 * `closed` is an exit we executed and priced, `closed-estimated` was reconciled from the last
 * price actually observed, and `closed-unknown` closed with no outcome at all. realizedStats
 * reports the latter two as separate counts, so returning only `closed` would silently zero
 * them. The meaning of each is defined once, in outcomeKind (agent/lib/positions.ts).
 */
const CLOSED_BUY_STATUSES = ["closed", "closed-estimated", "closed-unknown"] as const;

/** Upper bound on rows returned. See the comment in the handler for why this number. */
const CLOSED_BUYS_LIMIT = 500;

/**
 * The whole closed BUY record for an account, newest first.
 *
 * WHY THIS EXISTS RATHER THAN A BIGGER tradeLimit. review_performance used to take the 50 most
 * recent rows of ANY kind from recallRecent and call them closed trades. BUYs still open, SELLs,
 * skipped proposals and dry-run rows all consumed slots, so the closed record it could actually
 * see shrank every time the account traded, while every figure it reported looked normal. Raising
 * a limit only moves that cliff further out; filtering at the index removes it.
 */
export const closedBuys = query({
  args: { token: v.string(), env: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    // Bounded on purpose. Convex caps how many documents one query may read, and this repo's own
    // guideline (convex/_generated/ai/guidelines.md) is to bound a growing table with .take(n)
    // rather than .collect(). Three index reads of 500 is at most 1,500 documents, comfortably
    // inside that cap. 500 closed BUYs is years of history at the risk gate's ceiling of four new
    // positions a day, and the account has tens of closed rows today, so the bound is not reached
    // in any realistic future. If it ever is, the right answer is pagination, not a bigger number.
    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? CLOSED_BUYS_LIMIT)), CLOSED_BUYS_LIMIT);
    const rows = [];
    for (const status of CLOSED_BUY_STATUSES) {
      const batch = await ctx.db
        .query("trades")
        .withIndex("by_env_side_status", (q) =>
          q.eq("env", args.env).eq("side", "BUY").eq("status", status),
        )
        .order("desc")
        .take(limit);
      rows.push(...batch);
    }
    // Merge the three status streams back into one chronology. closedAt is absent on rows that
    // were never given one, so fall back to createdAt rather than dropping them.
    rows.sort((a, b) => (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt));
    return rows.slice(0, limit);
  },
});
```

Adjust to match the surrounding file if anything differs (import style,
`assertSecret` call, formatting). Do not add a `returns` validator; `openBuys`
and `getBenchmark` beside it have none.

**Verify**:

- `npx tsc -p convex/tsconfig.json` → exit 0
- `npx convex deploy --dry-run` → exit 0, no errors

### Step 3: Add the facade method

In `agent/lib/memory.ts`, beside `openBuys` (line 297), add:

```ts
  /** The whole closed BUY record, newest first. Bounded server-side; see convex/memory.ts. */
  closedBuys(env: Env, limit?: number): Promise<unknown> {
    return this.query("closedBuys", { env, limit });
  }
```

Return `Promise<unknown>` to match `openBuys`. The caller casts once, which is
the existing pattern.

Add coverage in `agent/lib/memory.test.ts`:

- A test in the style of `agent/lib/memory.test.ts:40` asserting `closedBuys`
  issues a **query** (not a mutation) with `{ token, env }`.
- Add a `closedBuys` call to the existing "every Memory method includes the
  token in its args" test at `agent/lib/memory.test.ts:108`, so the new method
  is inside that guarantee rather than beside it.

**Verify**: `node --test --experimental-strip-types agent/lib/memory.test.ts`
→ all pass.

### Step 4: Point the tool at it

In `agent/tools/review_performance.ts`, replace lines 40-64.

`recallRecent` was fetching two things this tool uses: the trade rows and the
benchmark row. The trades move to `closedBuys`. The benchmark has its own query
already, `getBenchmark` (`convex/memory.ts:614`, facade at
`agent/lib/memory.ts:307`), so `recallRecent` can go entirely and the tool stops
pulling cycles, messages, risk state and lessons it never reads.

Target shape:

```ts
    const memory = memoryFromEnv();
    const env = tradingEnv();
    const [openBuysRaw, closedBuysRaw, benchmarkRaw] = await Promise.all([
      memory.openBuys(env),
      // The WHOLE closed record, not a recency window. Every figure below (realised stats,
      // per-tag expectancy, failure attribution, calibration) is only as honest as its sample,
      // and a mixed 50-row window shrank that sample every time the account traded.
      memory.closedBuys(env),
      memory.getBenchmark(env),
    ]);
    const openBuys = (openBuysRaw ?? []) as OpenBuyTrade[];
    // Full trade rows, not a narrow projection: attribution needs the entry price, the timestamps
    // and the exit levels to tell a stop-loss exit from a time exit, and calibration needs the
    // confidence claimed at entry. These come straight from Convex, so the fields are present.
    const closedTrades = (closedBuysRaw ?? []) as {
      ticker: string;
      status: string;
      price: number;
      createdAt: number;
      closedAt?: number;
      pnl?: number;
      strategyTag?: string;
      redTeamVerdict?: string;
      exitPrice?: number;
      stopLossPct?: number;
      maxHoldDays?: number;
      predictedConfidence?: number;
    }[];
```

Then update the benchmark binding further down. Line 118 currently reads:

```ts
    let benchmark = (recall as { benchmark?: Benchmark | null })?.benchmark ?? null;
```

It becomes a read of `benchmarkRaw` with a single cast to `Benchmark | null`.
Nothing else in the benchmark block changes.

Keep the field name `closedTrades` and keep every consumer call site
(`realizedStats`, `realizedStatsByTag`, `attributeFailures`, `calibrationFrom`
twice) exactly as it is. This plan changes the rows, not the arithmetic.

**Verify**:

- `grep -n 'recallRecent' agent/tools/review_performance.ts` → no output, exit 1
- `grep -n 'tradeLimit' agent/tools/review_performance.ts` → no output, exit 1
- `pnpm typecheck` → exit 0

### Step 5: Add the structural wiring test

Create `agent/lib/review-performance.test.ts`. The `pnpm test` glob is
`agent/**/*.test.ts`, so a file here is picked up automatically.

`review_performance.ts` is an IO edge and is not directly unit-testable, which
is why this is a source-text assertion. Model it on
`agent/lib/hold-floor.test.ts:81`, including a comment recording why. Assert:

1. `review_performance.ts` calls `memory.closedBuys(`.
2. It does **not** contain `recallRecent` or `tradeLimit`. These two are the
   regression: the bug was a recency window standing in for a record, and both
   tokens are its fingerprint.
3. `closedTrades` is derived from the `closedBuys` result, not from a `.trades`
   field. Assert the source does not match `/\.trades/`.
4. `convex/memory.ts`'s `closedBuys` handler names all three closed statuses.
   Read `convex/memory.ts` as text and assert it contains `"closed-estimated"`
   and `"closed-unknown"` within the `CLOSED_BUY_STATUSES` declaration. This is
   the assertion that stops someone "simplifying" the query to `status ===
   "closed"` and silently zeroing two of `realizedStats`' counts.
5. The query is bounded: `convex/memory.ts` contains `.take(` inside the
   `closedBuys` handler and does not use `.collect()` there.

Write the comment in the house voice:

```ts
test("review_performance measures the whole closed record (structural)", () => {
  // The pure modules downstream (realizedStats, attributeFailures, calibrationFrom) are all
  // tested on fixtures they are handed, so every one of them stays green while the tool feeds
  // them a 50-row window of mixed BUYs, SELLs, skips and dry-runs. The sample is only visible
  // here, in the tool's source, so it is asserted here.
  const src = readFileSync(new URL("../tools/review_performance.ts", import.meta.url), "utf8");
  // ... assertions
});
```

**Verify**: `node --test --experimental-strip-types agent/lib/review-performance.test.ts`
→ all pass.

### Step 6: Prove it against the live data

Re-run step 1's script, extended to call the new path, and compare.

```ts
const before = closedInWindow.length;                       // from step 1
const after = ((await m.closedBuys("live")) ?? []) as any[];
console.log("closed BUYs visible before:", before);
console.log("closed BUYs visible now:", after.length);
console.log("statuses returned:", [...new Set(after.map((t) => t.status))]);
console.log("every row is a closed BUY:", after.every((t) => t.side === "BUY" && String(t.status).startsWith("closed")));
```

**Verify**: all four hold.

- `after.length` is strictly greater than `before`.
- Every returned status starts with `closed`; no `placed`, `skipped` or
  `dry-run` appears.
- Every returned row has `side === "BUY"`.
- `after.length` is at or below 500.

Record the before and after numbers in the commit body. A fix to a measurement
whose effect on the measurement is not stated is not evidence of anything.

Delete `/tmp/measure-record.ts` afterwards. It must not be committed.

### Step 7: Confirm nothing else moved

**Verify**:

- `pnpm typecheck` → exit 0
- `npx tsc -p convex/tsconfig.json` → exit 0
- `npx convex deploy --dry-run` → exit 0
- `pnpm test` → exit 0, `ℹ fail 0`, and at least 4 more tests than the plan-001
  baseline. Existing tests for `positions.ts`, `attribution.ts` and
  `calibration.ts` must pass unchanged; if one fails, the query is returning the
  wrong rows, not the module being wrong.

### Step 8: Mutation-check your own tests

This repo has shipped vacuous tests four times: a constant compared against
itself, a mutation that landed in the wrong function, and unit tests with no
wiring test. Prove the new tests bite. Three mutations, one per property.

For every mutation: back up with `/bin/cp -f`, make the change, **grep to
confirm the change actually landed and read the line**, run the tests, restore
with `/bin/cp -f`, then verify the restore with `git diff` and a green run. `cp`
is aliased to `cp -i` in this environment and has silently refused to overwrite
before, producing a false green off a change that never happened.

**Mutation A, the regression itself.** In `agent/tools/review_performance.ts`,
revert step 4 by hand: put `memory.recallRecent(env, { tradeLimit: 50 })` back
and derive `closedTrades` from its `.trades`.
→ step 5's structural test must go RED on assertions 1, 2 and 3.

**Mutation B, the silent-zero trap.** In `convex/memory.ts`, cut
`CLOSED_BUY_STATUSES` down to `["closed"]`.
→ step 5's structural test must go RED on assertion 4. Confirm the mutation
landed with `grep -n 'CLOSED_BUY_STATUSES' convex/memory.ts`.

**Mutation C, the facade.** In `agent/lib/memory.ts`, change `closedBuys` from
`this.query(...)` to `this.mutation(...)`.
→ step 3's facade test must go RED. This one matters because a method that
issues the wrong verb would fail only at runtime against a real deployment.

**Verify**: you observed each mutation turn its own named test red, and the
suite green after each restore. If a mutation leaves the suite green, that test
is not testing what it claims and it is a STOP condition.

## Test plan

- `agent/lib/memory.test.ts`: 1 new test that `closedBuys` issues a query with
  the token and env, in the style of the test at line 40, plus `closedBuys`
  added to the token-coverage loop at line 108.
- `agent/lib/review-performance.test.ts` (new): 1 structural test with the five
  assertions in step 5, modelled on `agent/lib/hold-floor.test.ts:81`.
- No new tests for `realizedStats`, `attributeFailures` or `calibrationFrom`.
  They are already covered and this plan does not change them. Adding tests
  there would look like coverage of this fix and would not be.
- The Convex handler itself has no unit test, matching the rest of
  `convex/memory.ts` (only the pure modules `convex/memoryPolicy.ts` and
  `convex/traceAppend.ts` are unit-tested in this repo). Its verification is
  `npx convex deploy --dry-run` plus step 6's live read, which is stronger
  evidence than a fake `ctx.db` would be.

Verification: `pnpm test` → all pass, at least 4 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `npx convex deploy --dry-run` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0` and at least 4 more tests than the plan-001 baseline
- [ ] `grep -n 'recallRecent\|tradeLimit' agent/tools/review_performance.ts` returns no output (exit 1)
- [ ] `grep -n 'closedBuys' convex/memory.ts agent/lib/memory.ts agent/tools/review_performance.ts` matches in all three
- [ ] `grep -n 'closed-estimated' convex/memory.ts` and `grep -n 'closed-unknown' convex/memory.ts` both match
- [ ] `grep -n 'recallRecent' agent/tools/recall_memory.ts` still matches: the other caller is untouched
- [ ] Step 6 printed a strictly larger closed-BUY count than step 1, with no
      `placed`, `skipped` or `dry-run` status in the result
- [ ] Mutations A, B and C each turned their own named test red, and all three
      restores were confirmed with `git diff`
- [ ] `git status --short` shows only `convex/memory.ts`, `agent/lib/memory.ts`,
      `agent/lib/memory.test.ts`, `agent/tools/review_performance.ts` and
      `agent/lib/review-performance.test.ts`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the live files.
- `convex/schema.ts` does not have `by_env_side_status` on `["env", "side",
  "status"]`. Adding an index to a populated table on the money path is a
  decision, not an executor's call.
- `npx convex deploy --dry-run` reports a schema error. This plan adds no field
  and no index, so it should not; if it does, something else is wrong and
  deploying past it risks the live deployment.
- Step 6 shows `after.length` at or below `before`. That means the query is not
  finding rows it should, most likely a status vocabulary mismatch, and the fix
  is not doing what it claims.
- Step 6 returns any row whose `side` is not `BUY` or whose `status` does not
  start with `closed`.
- An existing test in `positions.test.ts`, `attribution.test.ts` or
  `calibration.test.ts` fails. Those modules are out of scope and correct; a
  failure there means the query is returning the wrong rows. Fix the query, do
  not edit those tests.
- A mutation in step 8 leaves the suite green.
- You conclude the right fix is a larger `tradeLimit`. It is not: a limit on a
  mixed stream still shrinks as the account trades, which is the actual defect.

## Maintenance notes

For whoever owns this next:

- **Expect the reported numbers to move on the next cycle, and that is the
  point.** Win rate, per-tag expectancy, Brier score and the failure patterns
  are all computed on a larger and differently composed sample afterwards. The
  new figures are not "worse results", they are the first honest ones. Note the
  before and after in the commit body so nobody later reads the shift as a
  strategy regression.
- **`calibrationFrom` may cross its threshold for the first time.**
  `MIN_CALIBRATION_SAMPLE` is 10 (`agent/lib/calibration.ts:42`), and a fuller
  closed record may turn "insufficient-data" into an actual verdict. A verdict
  appearing where there was none is the expected consequence, not a bug.
- The 500-row bound is generous today and finite forever. `closedBuys` takes an
  optional `limit` so a caller can ask for less, but nothing can ask for more.
  If the account ever approaches 500 closed BUYs, the answer is pagination or a
  server-side aggregate, not a bigger constant; the whole point of this plan is
  that a bigger constant only moves the cliff.
- A reviewer should check three things: that all three closed statuses are in
  `CLOSED_BUY_STATUSES`, that `recall_memory.ts` still calls `recallRecent`
  (the other caller genuinely wants recency and must not have been swept up),
  and that no arithmetic in `review_performance.ts` changed.
- Deliberately deferred: `trades.status` is a bare `v.string()` with four
  vocabularies in play, recorded as deferred debt in `plans/README.md`. This
  plan hardcodes three of those strings in `convex/memory.ts`, which adds one
  more place that would need updating if a fifth status ever appears. Step 5's
  assertion 4 makes that omission loud rather than silent, but a `v.union` of
  literals shared by the schema and this query is the real answer.
