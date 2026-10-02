# Plan 007: Stop one empty portfolio read from closing every open position

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- agent/lib/positions.ts agent/lib/positions.test.ts agent/tools/manage_positions.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpt against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (changes what the exit path does with an unexpected broker response)
- **Depends on**: plans/001-reinstall-dependency-tree.md
- **Category**: bug
- **Planned at**: commit `0859c96`, 2026-09-30

## Amendment 2026-10-02 (read before the steps; it overrides them where they conflict)

Planned against `0859c96`; amended against `942206f`. The drift check WILL show `agent/tools/manage_positions.ts`
changed: that is PR #84 (index core), expected, and described here. It is not a STOP.

**What #84 changed.** `manage_positions.ts` now loads its inputs through an exported
`loadExitScope(client, memory, env)` that FILTERS OUT the index core (`VUAGl_EQ`, see `agent/lib/core.ts`
`isCore`) from both the portfolio and the open BUYs, so the exit engine never sells the index. The orphan
call is now around line 113: `const orphans = orphanedOpenBuys(openBuys, positions);` using the filtered
lists. `agent/lib/core-exits.test.ts` also calls `orphanedOpenBuys(scope.openBuys, scope.positions)` and
must be updated to the new return shape (it is in scope). The account now holds four stocks (VRT, ALK,
LLY, GE) plus the index core.

**A1. The empty-read guard must test the UNFILTERED portfolio.** If it tested the filtered list, an
account where every stock was sold outside poof while the index core is still held would look empty, be
refused every cycle, alert every cycle, and never reconcile. Since #84 the core is always held (a small
floor is never sold), so an empty RAW broker read is an even clearer sign of a failed read. Change
`loadExitScope` to also return the raw portfolio (for example `rawPositions`, or a `brokerHeldAnything:
boolean`), keep returning the filtered `positions` and `openBuys` exactly as now, and pass the raw
portfolio (or its emptiness) into the guard. Refuse only when the raw portfolio is empty AND there is at
least one open (non-core) BUY.

**A2. Pending orders: you are authorised to add ONE broker call.** `client.getPendingOrders()` (uncached,
read-only, `agent/lib/t212.ts`) is not otherwise called in `manage_positions` before reconciliation
(`evaluateAndExecute` calls it only when there are exit proposals). Call it once in `manage_positions`
(alongside or inside `loadExitScope`). Pass the set of tickers with a pending order into
`orphanedOpenBuys`; an open BUY whose ticker has a pending order is NOT an orphan. If
`getPendingOrders()` throws, do not reconcile this cycle: treat it as not reconcilable with a reason such
as "pending orders could not be read", close nothing, alert. Do not add any other broker call. (This
replaces the step 2 STOP condition.)

**A3. Make the caller testable, and test it behaviourally.** Extract the reconciliation step from the
tool body into an exported function in `manage_positions.ts`, next to `loadExitScope` and in the same
style, e.g. `reconcileOrphans({ openBuys, rawPositions, pendingTickers, fxRate, closeTrade, alert })`
returning `{ status: "reconciled", closed: number } | { status: "refused", reason: string }`. It calls
`orphanedOpenBuys`, books each orphan through `buildOrphanCloseTradeArgs` + `closeTrade` exactly as now,
and on refusal closes nothing and calls `alert` (from `agent/lib/alert.ts`, which never throws) with the
reason. The tool calls it and adds its result to the returned object as `reconciliation`, so the cycle
report shows it. Keep it inside the existing try/catch so a memory failure stays non-fatal.

**A4. Tests (replace the "Test plan" list).** In `agent/lib/positions.test.ts`:
1. 3 open BUYs, empty raw portfolio -> refused, zero orphans (the regression).
2. Empty raw portfolio, zero open BUYs -> reconcilable, no orphans, no refusal.
3. Raw portfolio holds only the index core, 2 open stock BUYs -> reconcilable, both orphaned (proves A1).
4. 2 held, 3 recorded -> exactly the missing one is orphaned.
5. A recorded BUY whose ticker has a pending order and is not held -> not an orphan (A2).
In a test file for the tool seam (extend `agent/lib/core-exits.test.ts` or add
`agent/lib/reconcile-orphans.test.ts`), using plain fakes:
6. `reconcileOrphans` on a refused read calls `closeTrade` zero times and `alert` once with the reason.
7. `reconcileOrphans` on a good read closes exactly the orphan and does not alert.
8. `reconcileOrphans` when pending orders could not be read closes nothing and alerts.
Update the existing `core-exits.test.ts` assertion to the new return shape without weakening it.

**A5. Mutation checks (replace step 4).** For each: back up with `/bin/cp -f`, change, confirm with grep
that it landed, run the tests, restore with `/bin/cp -f`, confirm `git diff` shows only intended changes
and the suite is green. (a) Remove the empty-read guard: test 1 must go red. (b) Make the guard use the
filtered list: test 3 must go red. (c) Drop the pending-ticker exclusion: test 5 must go red. (d) Make
`reconcileOrphans` close even when refused: test 6 must go red.

**A6. Environment.** Run `source ~/.nvm/nvm.sh && nvm use` in every shell (the repo needs Node 24; the
default shell is 22). `convex/_generated` is gitignored: copy it from the main checkout
(`/bin/cp -R /Users/lucien/src/luciengeorge/poof/convex/_generated convex/`) before the convex typecheck.
In-scope files are now: `agent/lib/positions.ts`, `agent/lib/positions.test.ts`,
`agent/tools/manage_positions.ts`, `agent/lib/core-exits.test.ts`, and optionally a new
`agent/lib/reconcile-orphans.test.ts`. Never place orders or call the live broker.

## Why this matters

`orphanedOpenBuys` answers "which BUYs do we have a record of that the broker
no longer holds?", and the caller books each answer as closed. It has no guard
against the degenerate input.

If Trading 212 returns an empty portfolio for any reason (a transient API
fault, a partial outage, an auth blip, a schema change that makes parsing yield
nothing) then `held` is an empty set, **every** open BUY is classified as
orphaned, and the whole open book is force-closed as `closed-estimated` in a
single cycle. Those positions are still held in reality, with real money, but
poof no longer has a `placed` row for any of them, so the exit engine will
never manage them again. No stop-loss, no trailing stop, no time limit, for the
rest of their life.

There is a smaller sibling defect in the same logic: a **pending, unfilled** BUY
is legitimately absent from the portfolio, so even on a perfectly good read it
is misclassified as orphaned and booked closed. When it later fills, the
position is invisible.

The account currently holds 3 positions worth about £146. The failure is
cheap to guard against and expensive to experience.

## Current state

`agent/lib/positions.ts`, as of `0859c96`:

```ts
/** Open BUY trades whose ticker is no longer held -> the position was closed elsewhere. */
export function orphanedOpenBuys(
  openBuys: OpenBuyTrade[],
  positions: T212Position[],
): OpenBuyTrade[] {
  const held = new Set(positions.map((p) => p.ticker));
  return openBuys.filter((b) => !held.has(b.ticker));
}
```

The caller, `agent/tools/manage_positions.ts` (around line 95):

```ts
      // Reconcile: BUYs whose position is no longer held were closed elsewhere.
      const orphans = orphanedOpenBuys(openBuys, positions);
```

Conventions: `agent/lib/positions.ts` is pure and unit-tested; `agent/lib/
positions.test.ts` is the exemplar for test style. This repo's house pattern for
"the instrument cannot measure right now" is to refuse to emit a conclusion
rather than emit a wrong one, see `snapshot-not-atomic` in
`agent/lib/execution.ts`, which skips a divergence check rather than publishing
a bogus one, and the `UNJUDGEABLE` path in the report judge. **Follow that
pattern here.** The right behaviour for an empty portfolio read is not "close
everything" and not "close nothing silently"; it is "refuse to reconcile, and
say so loudly".

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Position tests | `node --test --experimental-strip-types agent/lib/positions.test.ts` | all pass |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |

Note: the count prefix is `ℹ` on Node 24 and `#` on Node 22. Seeing `#` means
the wrong Node; plan 001 is a dependency for that reason.

## Scope

**In scope:**
- `agent/lib/positions.ts`, `orphanedOpenBuys` and its return shape
- `agent/lib/positions.test.ts`, new tests
- `agent/tools/manage_positions.ts`, handle the refusal, and alert on it

**Out of scope** (do NOT touch, even though they look related):
- `outcomeKind` and `realizedStats` in the same file. They have their own
  status-vocabulary problem which is recorded in `plans/README.md` as deferred.
- `buildCloseTradeArgs` and the normal close path. A genuinely orphaned
  position must still be reconciled; this plan only stops the degenerate case.
- The `closed-estimated` / `closed-unknown` status values themselves.
- Any change to how `positions` is fetched.

## Git workflow

- Branch: `advisor/007-guard-orphan-reconciliation`
- One or two commits. Conventional commits, imperative subject, body naming the
  failure mode.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Decide and document the contract, in the code

`orphanedOpenBuys` currently cannot distinguish "the broker holds nothing
because everything was sold" from "the read failed and returned nothing". Those
require opposite responses and the function has no way to tell them apart from
its arguments alone.

Change it to return a discriminated result rather than a bare array, so the
caller must handle the refusal. Something in the shape of:

```ts
{ reconcilable: true; orphans: OpenBuyTrade[] }
| { reconcilable: false; reason: string }
```

Refuse when `positions.length === 0` **and** `openBuys.length > 0`, which is
the only genuinely ambiguous case. An empty portfolio with no open BUYs is
consistent and fine. A non-empty portfolio is fine.

Add a comment explaining why refusing beats guessing, referencing the
`snapshot-not-atomic` precedent in `agent/lib/execution.ts`.

**Verify**: `pnpm typecheck` → it will fail at the call site. That is expected;
step 3 fixes it.

### Step 2: Exclude pending BUYs from the orphan test

A BUY whose order is still pending has not appeared in the portfolio yet and
must not be treated as orphaned. Determine from `agent/lib/t212.ts` how pending
orders are exposed and whether `manage_positions.ts` already has them in scope
(`submit_orders` uses a `pending` list, so the client can supply one).

If pending orders are available at the call site, pass them in and exclude
those tickers. If they are genuinely not available without an extra broker
call, **STOP and report** rather than adding an unplanned API call inside the
exit path.

**Verify**: a test proving a ticker with a pending order is not reported as an
orphan.

### Step 3: Make the caller handle the refusal loudly

In `agent/tools/manage_positions.ts`, when the result is not reconcilable:

- do not close anything,
- emit an alert through the existing helper in `agent/lib/alert.ts`, the same
  way other account-value anomalies are surfaced,
- include the reason in whatever the tool returns, so the cycle report says it
  happened.

A silent skip here would reproduce the exact failure this audit is about: an
instrument that stops working and reports nothing.

**Verify**: `pnpm typecheck` → exit 0. `pnpm test` → all pass.

### Step 4: Mutation-check

1. Back up `agent/lib/positions.ts`.
2. Remove the empty-read guard so it always reconciles.
3. **Confirm the mutation landed**: `grep -n "reconcilable" agent/lib/positions.ts`.
   `cp` is aliased to `cp -i` here and has silently refused to overwrite before,
   producing a false green.
4. Run tests → the wipe-the-book test must go RED.
5. Restore with `/bin/cp -f`; confirm `git diff` shows only intended changes and
   the suite passes.

**Verify**: observed red under mutation, green after restore.

## Test plan

New tests in `agent/lib/positions.test.ts`, modelled on the existing tests
there:

1. **The regression**: 3 open BUYs, empty `positions` array → not reconcilable,
   and crucially **zero orphans returned**. This is the test that matters.
2. Empty `positions` with zero open BUYs → reconcilable, no orphans. The
   consistent case must not trip the guard.
3. A genuinely orphaned BUY (2 held, 3 recorded) → reconcilable, exactly one
   orphan, the right one.
4. A BUY with a pending order → not an orphan (from step 2).
5. A structural or behavioural test that `manage_positions.ts` closes nothing
   when the result is not reconcilable. A unit test of the function alone does
   not prove the caller honours it, and this repo has shipped that exact gap
   four times.

Verification: `pnpm test` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0`
- [ ] An empty portfolio read with open BUYs returns zero orphans and an
      explicit refusal
- [ ] The caller closes nothing and alerts on that refusal
- [ ] A test fails if the guard is removed
- [ ] `git status` shows only the three in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpt does not match the live code.
- Pending orders are not reachable at the call site without an extra broker
  API call (step 2).
- Changing the return type ripples into more than the one call site. If
  `orphanedOpenBuys` has other callers, report them before proceeding.
- You are tempted to make the guard a threshold ("refuse if more than N% would
  be orphaned"). Do not. A threshold is a guess; the ambiguity is binary and
  the honest answer is to refuse on it.

## Maintenance notes

- A reviewer should check the *consistent* empty case still works: an account
  that genuinely holds nothing and has no open BUY records must not start
  alerting every cycle. That is the way this fix would most plausibly annoy
  someone into reverting it.
- If the alert from step 3 turns out to fire routinely, that is information:
  it means empty portfolio reads are common, which would be worth knowing
  before trusting any reconciliation at all.
- Related and deliberately separate: `agent/lib/execution.ts` has a
  `snapshot-not-atomic` guard whose 1000ms tolerance fires on about 30% of
  cycles (and 10 of the last 12), which means the account-value divergence
  check it protects is usually skipped. Same family of problem, different fix,
  not in this plan.
