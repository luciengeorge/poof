# Plan 012: Pin the fail-closed branches that tests do not reach

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 0859c96..HEAD -- agent/tools/submit_orders.ts agent/lib/state.ts agent/lib/external-holdings.test.ts agent/lib/state.test.ts`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-reinstall-dependency-tree.md (so a green test run is evidence)
- **Category**: tests
- **Planned at**: commit `0859c96`, 2026-09-30

## Amendment 2026-10-02 (read before the steps; it overrides them where they conflict)

Planned against `0859c96`; amended against `cab1f14`. The drift check shows `agent/tools/submit_orders.ts`
changed: PR #84 moved the tool body into an exported `submitOrders(proposals, deps)` (with injectable
`client`, `memory`, `env`, `fx`, `dryRun`). The fail-closed external-holdings branch is unchanged in
substance and now sits around lines 122-139; the `approval` predicate with the raw
`process.env.DRY_RUN === "false"` read is around line 255. Not a STOP.

**A1. Prefer a behavioural test for the fail-closed branch.** Because `submitOrders` is now exported
with injected dependencies, test the policy directly: a fake `memory` whose `listExternalHoldings`
throws, with `env: "live"`, must skip every BUY (reported as skipped with the fail-closed reason) and
still let SELLs through; with `env: "demo"`, BUYs proceed. Model the fakes on the existing
`submitOrders` tests in `agent/lib/orders.test.ts` (they drive the real `submitOrders` with fakes).
Keep a structural assertion only if it pins something the behavioural test cannot. Mutation-check:
make the catch set `blockAllBuys = false` on live; the live test must go red.

**Environment.** Run `source ~/.nvm/nvm.sh` and `nvm use` as separate commands in every shell, never
chained after a command that can fail (test output must show `ℹ tests N`, i.e. Node 24).
`convex/_generated` is now committed (PR #91), so no copy is needed. Never call live services, place
orders or run `npx convex deploy`. Stage explicit paths only.

## Why this matters

poof places real orders on a Trading 212 UK ISA holding roughly £250. Two
decisions inside `agent/tools/submit_orders.ts` decide whether real money moves,
and neither is covered by a test that would notice if it changed.

**One.** When the external-holdings lookup throws (a Convex outage), the tool
must fail closed on live: block every new BUY, keep allowing SELLs, because
de-risking is always permitted and opening fresh exposure with the exclusion
list blind is not. That decision is one character-comparison at
`agent/tools/submit_orders.ts:121`. **Change `"live"` to `"demo"` and the entire
647-test suite still passes.** Under that mutation the live account would open
new positions during a Convex outage, in names the operator's separate advisory
account already holds, which is the exact scenario the guard exists to prevent.

The tool has a test that looks like it covers this. `agent/lib/external-holdings.test.ts:284`
("guard blocks every BUY when told to fail closed, still allowing SELLs") passes
`{ blockAllBuys: true }` straight into the pure function. It proves the function
is correct. It says nothing about whether anything ever sets that flag, or on
which environment.

**Two.** `DRY_RUN` is the kill switch. Two places read it independently:
`agent/lib/state.ts:146` (`isDryRun()`) and `agent/tools/submit_orders.ts:97`
(the approval predicate, reading `process.env.DRY_RUN` directly). They happen to
agree today. Nothing makes them agree tomorrow, and neither read is covered.
`isDryRun()`'s polarity in particular is a single `!==` that inverts the kill
switch if it is ever written as `===`, and no test would catch it.

This is the repo's recurring failure, not a new one. `agent/lib/hold-floor.test.ts:82-84`
records it in its own words: "Mutation testing showed the unit tests above stay
green if submit_orders never calls applyHoldFloor." Same tool, same gap, and the
fix shape is already sitting in the codebase.

After this plan, mutating either decision turns the suite red.

## Current state

Files involved:

- `agent/tools/submit_orders.ts`: the order-placing tool. The fail-closed
  branch is at line 121, the second `DRY_RUN` read at line 97.
- `agent/lib/state.ts`: `isDryRun()` at lines 144-147, the single intended
  reader of `DRY_RUN`.
- `agent/lib/external-holdings.test.ts`: has the pure-function test at line
  284 and already imports `readFileSync`, so it is the natural home for the
  structural tests.
- `agent/lib/hold-floor.test.ts:81-95`: the exemplar. Read it before writing
  anything.
- `agent/lib/risk-runtime.ts:31-72`: `resolveRiskState`, the sibling
  fail-closed branch this one deliberately mirrors. Its module doc at lines 6-14
  states the live/demo split as policy.

`agent/tools/submit_orders.ts:96-97`, the second `DRY_RUN` reader:

```ts
  approval: () =>
    process.env.REQUIRE_APPROVAL === "true" && process.env.DRY_RUN === "false",
```

`agent/tools/submit_orders.ts:109-129`, the fail-closed branch:

```ts
    let excludedSymbols: ReadonlySet<string> = new Set<string>();
    let blockAllBuys = false;
    try {
      excludedSymbols = externalHoldingSymbols(
        await memory.listExternalHoldings(env),
      );
    } catch (err) {
      // Without the list we cannot tell which names are excluded. On live, open no new
      // exposure (same fail-closed stance resolveRiskState takes on a Convex outage:
      // halt BUYs, allow SELLs). On demo, warn and continue.
      blockAllBuys = env === "live";
      console.warn(
        `[external] holding lookup FAILED${
          blockAllBuys ? " on LIVE; failing closed (skip BUYs, allow SELLs)" : ""
        }:`,
        err,
      );
    }
```

`env` comes from `tradingEnv()` (`agent/lib/risk-runtime.ts:28-29`):

```ts
export const tradingEnv = (): Env =>
  (process.env.TRADING212_ENV ?? "demo") as Env;
```

`agent/lib/state.ts:144-147`:

```ts
/** DRY_RUN defaults ON (safe). Only `DRY_RUN=false` enables real order placement. */
export function isDryRun(): boolean {
  return process.env.DRY_RUN !== "false";
}
```

The exemplar, `agent/lib/hold-floor.test.ts:81-95`, verbatim:

```ts
test("submit_orders applies the hold floor before the gate (structural)", () => {
  // Mutation testing showed the unit tests above stay green if submit_orders never calls
  // applyHoldFloor. The tool is the only place the floor can take effect, so its source must
  // show the call, on the proposals, before the external-holdings partition and the gate.
  const src = readFileSync(new URL("../tools/submit_orders.ts", import.meta.url), "utf8");
  const call = src.indexOf("applyHoldFloor(proposals)");
  const partition = src.indexOf("partitionExternalHoldingBuys(");
  const gate = src.indexOf("evaluateAndExecute(");
  assert.ok(call > 0, "submit_orders must call applyHoldFloor on the incoming proposals");
  assert.ok(call < partition && partition < gate, "the floor must run before partition and gate");
  assert.match(src, /floored\.proposals/, "the floored proposals, not the raw ones, must flow on");
});
```

Repo conventions that apply here:

- Pure, unit-tested functions with IO at the edges. `submit_orders.ts` is the
  IO edge and is not directly unit-testable, which is why structural tests exist
  for it.
- Comments explain WHY, at length, and are not on every line. The comment in the
  exemplar above is the house voice: it records what the mutation test showed.
- No em-dashes.
- `node:test` with `node:assert/strict`, plain object fixtures, no mocking
  framework.
- NEVER use TypeScript parameter properties (`constructor(private readonly x)`).
  `--experimental-strip-types` cannot erase them and the whole test file dies
  with a bare "test failed".

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck (app) | `pnpm typecheck` | exit 0 |
| Typecheck (convex) | `npx tsc -p convex/tsconfig.json` | exit 0 |
| External-holdings tests | `node --test --experimental-strip-types agent/lib/external-holdings.test.ts` | all pass |
| State tests | `node --test --experimental-strip-types agent/lib/state.test.ts` | all pass |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |

Note on the summary prefix: Node 24 prints `ℹ pass N` / `ℹ fail N`, Node 22
prints `# pass N` / `# fail N`. Plan 001 puts this repo on Node 24. If you see
`#`, you are on the wrong Node and plan 001 is not done; a grep pinned to one
prefix will silently match nothing.

## Scope

**In scope**:

- `agent/lib/external-holdings.test.ts`: add the fail-closed structural test
- `agent/lib/state.test.ts`: add the `isDryRun()` polarity tests. The file
  exists and covers `deriveRiskState` and `resolveLimits`; it has no `isDryRun`
  test today (`grep -n isDryRun agent/lib/state.test.ts` returns nothing)
- `agent/tools/submit_orders.ts`: the approval predicate only, to route its
  `DRY_RUN` read through `isDryRun()`

**Out of scope** (do NOT touch, even though they look related):

- **The fail-closed policy itself.** `blockAllBuys = env === "live"` stays
  exactly as it is. This plan pins the behaviour, it does not change it. If you
  find yourself arguing that demo should also fail closed, that is a trading
  decision for the operator and it belongs in its own change.
- `agent/lib/risk-runtime.ts`. `resolveRiskState` has the same live/demo split
  and the same coverage question. It is a sibling of this bug and worth pinning,
  but it is a different code path with a different failure mode, and doing both
  in one change makes a review harder than it needs to be. Recorded in
  Maintenance notes.
- `agent/lib/external-holdings.ts`. `partitionExternalHoldingBuys` is correct and
  already tested. The gap is the caller, not the function.
- The `REQUIRE_APPROVAL` semantics. Step 3 changes how the predicate reads
  `DRY_RUN` and nothing else. The truth table must come out identical.
- Anything about the risk gate, sizing, or the external advisory holding's
  value. The comment at `agent/tools/submit_orders.ts:105-108` explains why only
  ticker strings cross that boundary; keep it that way.

## Git workflow

- Branch: `advisor/012-pin-fail-closed-branches`
- One commit. Message style from `git log`: conventional commits, subject in the
  imperative, body explaining the mechanism. For example:
  `test(orders): pin the live fail-closed branch and the DRY_RUN polarity`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Reproduce the gap before fixing it

Prove to yourself that the suite is blind here. This is the evidence the whole
plan rests on, and it takes one minute.

1. Back up: `/bin/cp -f agent/tools/submit_orders.ts /tmp/submit_orders.bak`
2. Edit line 121: change `blockAllBuys = env === "live";` to
   `blockAllBuys = env === "demo";`
3. **Confirm the mutation actually landed**:
   `grep -n 'blockAllBuys = env' agent/tools/submit_orders.ts` and read it. Do
   not skip this. `cp` is aliased to `cp -i` in this environment and has
   silently refused to overwrite before, producing a false green off a change
   that never happened.
4. Run `pnpm test`.
5. Restore: `/bin/cp -f /tmp/submit_orders.bak agent/tools/submit_orders.ts`
6. **Verify the restore**: `git diff agent/tools/submit_orders.ts` is empty, and
   `grep -n 'blockAllBuys = env' agent/tools/submit_orders.ts` shows `"live"`
   again. A restore that silently no-ops turns an unrelated failure into false
   proof later on.

**Verify**: step 4's `pnpm test` exited 0 with `ℹ fail 0`, on a live account that
would now open new BUYs during a Convex outage. If the suite went red, the gap
has already been closed by someone else and this half of the plan is moot; STOP
and report which test caught it.

### Step 2: Pin the fail-closed branch

Add a structural test to `agent/lib/external-holdings.test.ts`, directly after
the existing test at line 284 so the pair reads together: the function, then the
wiring. The file already imports `readFileSync` (line 3), so no new import is
needed.

It must assert all of:

1. `submit_orders.ts` contains the assignment `blockAllBuys = env === "live"`.
   Match the literal `"live"`, not a variable. This is the assertion that kills
   the step 1 mutation.
2. That assignment appears inside a `catch` block, after the
   `memory.listExternalHoldings(` call. Locate both with `indexOf` and compare
   positions, exactly as the exemplar does with `applyHoldFloor`.
3. `blockAllBuys` is initialised to `false` before the `try`, so the happy path
   never blocks.
4. `blockAllBuys` is actually passed through to `partitionExternalHoldingBuys(`.
   Without this, the flag could be computed correctly and dropped on the floor.

Write the comment in the exemplar's voice. Record what the mutation showed,
because the next person to read the test needs to know why a source-text
assertion is here rather than a behavioural one:

```ts
test("submit_orders fails closed on LIVE when the external-holding lookup throws (structural)", () => {
  // The test above proves partitionExternalHoldingBuys honours blockAllBuys. It passes the flag
  // in by hand, so it stays green even if nothing ever sets it: changing `env === "live"` to
  // `env === "demo"` in submit_orders left all 647 tests passing. The tool is the only place
  // the live/demo split can take effect, so its source is asserted here.
  const src = readFileSync(new URL("../tools/submit_orders.ts", import.meta.url), "utf8");
  // ... assertions
});
```

**Verify**:

- `node --test --experimental-strip-types agent/lib/external-holdings.test.ts`
  → all pass, including the new one
- Redo step 1's mutation (change `"live"` to `"demo"`, grep to confirm it
  landed) → this test goes RED. Restore and confirm with `git diff` plus a green
  run.

### Step 3: Give `DRY_RUN` one reader

`agent/tools/submit_orders.ts:97` reads `process.env.DRY_RUN` directly, so two
pieces of code independently decide whether real money moves. They agree today
(`process.env.DRY_RUN === "false"` is exactly `!isDryRun()`), but agreement by
coincidence is not a property, and the duplicate read is uncovered.

Route the approval predicate through the existing helper. `isDryRun` is already
imported at `agent/tools/submit_orders.ts:5`:

```ts
  approval: () => process.env.REQUIRE_APPROVAL === "true" && !isDryRun(),
```

Leave the explanatory comment above `approval:` in place and extend it in the
house voice to say why the negation goes through `isDryRun()`: one reader of the
kill switch, so the tool cannot drift from `state.ts`.

This must not change behaviour. Satisfy yourself with the truth table before
moving on: `DRY_RUN` unset, `""`, `"true"`, `"false"`, `"FALSE"`. In every case
`process.env.DRY_RUN === "false"` and `!isDryRun()` give the same answer, because
they are the same comparison with the same string.

**Verify**: `grep -n 'process.env.DRY_RUN' agent/tools/submit_orders.ts` → no
output, exit 1. Then `grep -rn 'process.env.DRY_RUN' agent convex --include='*.ts'`
→ exactly one match, `agent/lib/state.ts:146`. Then `pnpm typecheck` → exit 0.

### Step 4: Pin the kill switch's polarity and its single reader

Add to `agent/lib/state.test.ts`. It already exists and covers `deriveRiskState`
and `resolveLimits`; match its style and put the new tests at the end.

Two tests.

**A behavioural test on `isDryRun()`.** It reads `process.env` at call time, so
set and restore the variable around each case. `agent/lib/tiingo.test.ts:151-158`
shows the established save-and-restore pattern in this repo; follow it, including
restoring in a `finally` so one failing assertion does not poison later tests.

Cases, all four:

| `DRY_RUN` | `isDryRun()` | why |
|---|---|---|
| unset | `true` | the safe default; absence must never enable real orders |
| `""` | `true` | a blank in a `.env` file is not consent |
| `"true"` | `true` | |
| `"false"` | `false` | the only value that arms real orders |

Add one more that matters more than it looks: `"False"` must give `true`. The
comparison is case-sensitive by design, and a test that states so stops a
future "helpful" `.toLowerCase()` from widening the only string that arms real
money.

**A structural test that `state.ts` owns the read.** Assert that
`process.env.DRY_RUN` appears exactly once across `agent/` source, in
`agent/lib/state.ts`. Implementation: read `agent/lib/state.ts` and
`agent/tools/submit_orders.ts` with `readFileSync(new URL(...), import.meta.url)`,
assert the first contains `process.env.DRY_RUN` and the second does not, and
assert `submit_orders.ts` matches `/!isDryRun\(\)/`. Do not shell out or walk the
directory tree; two named files is the property that matters and it stays
readable.

**Verify**: `node --test --experimental-strip-types agent/lib/state.test.ts`
→ all pass.

### Step 5: Confirm nothing else moved

**Verify**:

- `pnpm typecheck` → exit 0
- `npx tsc -p convex/tsconfig.json` → exit 0
- `pnpm test` → exit 0, `ℹ fail 0`, and at least 6 more tests than the plan-001
  baseline

### Step 6: Mutation-check every new test

Three mutations, one per property. Each needs its own run, because a single
mutation cannot exercise three independent assertions, and "the suite went red"
is not evidence that the *right* test went red. Read which test failed each time.

For every mutation: back up with `/bin/cp -f`, make the change, **grep to confirm
the change actually landed and read the line**, run the tests, restore with
`/bin/cp -f`, then verify the restore with `git diff` and a green run. `cp` is
aliased to `cp -i` here and has silently refused to overwrite before, producing a
false green.

**Mutation A, the fail-closed branch.** `agent/tools/submit_orders.ts:121`,
`"live"` to `"demo"`.
→ step 2's structural test must go RED. Nothing else needs to.

**Mutation B, the flag is dropped.** In `agent/tools/submit_orders.ts`, change
the `partitionExternalHoldingBuys(...)` call to pass `{ blockAllBuys: false }`
instead of `{ blockAllBuys }`.
→ step 2's structural test must go RED on assertion 4. This is the mutation that
proves assertion 4 earns its place; a correct flag that never reaches the
partition is the same outage with extra steps.

**Mutation C, the kill switch inverts.** `agent/lib/state.ts:146`, change
`!==` to `===`.
→ step 4's behavioural test must go RED on the unset case and on `"false"`.

**Verify**: you observed each mutation turn its own test red, by name, and the
suite green after each restore. If a mutation leaves the suite green, that test
is not testing what it claims and it is a STOP condition.

## Test plan

- `agent/lib/external-holdings.test.ts`: 1 new structural test, sitting
  immediately after the existing pure-function test at line 284, modelled on
  `agent/lib/hold-floor.test.ts:81`. Four assertions: the `"live"` literal, its
  position inside the catch after `listExternalHoldings`, the `false`
  initialiser, and the flag reaching `partitionExternalHoldingBuys`.
- `agent/lib/state.test.ts`: 5 behavioural cases for `isDryRun()` (unset, `""`,
  `"true"`, `"false"`, `"False"`) plus 1 structural test that `state.ts` is the
  only reader of `process.env.DRY_RUN` and that `submit_orders.ts` goes through
  `isDryRun()`. Env-var save-and-restore pattern from
  `agent/lib/tiingo.test.ts:151-158`.
- Do not modify the existing test at `agent/lib/external-holdings.test.ts:284`.
  It is correct and it is the reason the new one is structural rather than
  behavioural; the pair is the point.

Verification: `pnpm test` → all pass, at least 6 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0` and at least 6 more tests than the plan-001 baseline
- [ ] `grep -n 'blockAllBuys = env === "live"' agent/tools/submit_orders.ts`
      matches: the policy did not change
- [ ] `grep -rn 'process.env.DRY_RUN' agent convex --include='*.ts'` returns
      exactly one line, in `agent/lib/state.ts`
- [ ] `grep -n '!isDryRun()' agent/tools/submit_orders.ts` matches
- [ ] Mutations A, B and C each turned their own named test red, and all three
      restores were confirmed with `git diff`
- [ ] `git status --short` shows only `agent/tools/submit_orders.ts`,
      `agent/lib/external-holdings.test.ts` and `agent/lib/state.test.ts`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the live files.
- Step 1's mutation turns the suite red. Somebody already closed this gap and
  this plan needs rewriting rather than executing.
- Any mutation in step 6 leaves the suite green, or turns a different test red
  than the one named.
- You conclude the fail-closed policy is wrong and demo should also block. It
  may well be, but it is a trading decision and changing it here would land
  unreviewed inside a plan whose stated purpose is to change nothing.
- The step 3 change alters the approval truth table for any of the five
  `DRY_RUN` values. It must not; if it appears to, you have mis-transcribed the
  negation.
- You find yourself making `submit_orders.ts` importable or refactoring the tool
  so it can be unit-tested directly. That is a real improvement and it is not
  this plan; the structural pattern already in the repo is the cheap answer here.

## Maintenance notes

For whoever owns this next:

- **`resolveRiskState` has the identical shape and is not covered either.**
  `agent/lib/risk-runtime.ts:57-71` fails closed on live and fails open on demo,
  by the same `tradingEnv() === "live"` test, and the same mutation would very
  likely survive the suite. It is deliberately out of scope here because it is a
  distinct code path with a distinct failure mode, and because one small,
  reviewable diff is worth more than a broad one. Pin it next, with the same
  three-part recipe: reproduce the gap, add the structural test, mutate to
  confirm.
- **A structural test is a proxy, not a proof.** It asserts that the source says
  the right thing, which is why each one here has a comment recording the
  mutation that motivated it. When `submit_orders.ts` is eventually refactored,
  these tests will fail on text that moved rather than behaviour that broke. The
  correct response is to re-point them at the new shape, never to delete them
  because "the code is obviously fine".
- A reviewer should check two things: that `git diff agent/tools/submit_orders.ts`
  touches only the `approval:` predicate and its comment, and that each new test
  would actually fail under the mutation its comment names. Re-run one of them
  rather than taking it on trust.
- Deliberately deferred: making the tool's body a pure function that takes its
  dependencies as an argument, the way `agent/lib/orders.ts` already does, so
  the fail-closed path could be tested behaviourally. That is the right long-term
  shape and it is a refactor of the money path, which is not something to bundle
  into a test-coverage change.
