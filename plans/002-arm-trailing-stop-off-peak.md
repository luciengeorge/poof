# Plan 002: Arm the trailing stop off the peak, so it can actually fire

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- agent/lib/exits.ts agent/lib/exits.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpt against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001 (so the test run is evidence)
- **Category**: bug
- **Planned at**: commit `0859c96`, 2026-09-30

## Why this matters

The trailing stop is documented as "the primary exit on winners", and
take-profit was deliberately loosened to `0.4` so it would not front-run the
trail. In 52 closed live trades the trailing stop fired **zero** times and 45 of
52 positions (87%) exited on the max-hold timer instead. Winners of +15%, +11%
and +10% were sold by a clock.

The cause is a one-line mismatch. The stop *price* is computed from the peak,
but the *arming condition* is checked against the current price:

```
trailStopPrice = peak * (1 - trailingStopPct)      // peak-based
trailActive    = pnlPct >= activateTrailAtPct      // current-price-based
```

With the shipped defaults (`activateTrailAtPct: 0.05`, `defaultTrailingStopPct:
0.08`) the trail can only fire when both hold at once:

```
current <= peak * 0.92   AND   current >= entry * 1.05
⇒ peak * 0.92 >= entry * 1.05
⇒ peak >= entry * 1.1413
```

**A position must peak at +14.13% before the trailing stop can ever fire.**
Below that, the conditions are mutually exclusive: by the time price has fallen
8% off the peak it is already under the +5% arming line, so `trailActive` flips
false and the trail disarms itself at precisely the moment it should trigger.
The measured average win is +4.92%, so in practice it never armed.

After this change, a position that runs to +9% and gives back 8% exits at about
+0.3% instead of riding the timer back to breakeven or worse.

## Current state

`agent/lib/exits.ts`, lines 120-140 as of `0859c96`:

```ts
export function checkExits(
  positions: OpenPosition[],
  defaults: ExitDefaults,
  now: number,
): ExitSignal[] {
  const signals: ExitSignal[] = [];
  for (const p of positions) {
    if (!(p.entryPrice > 0)) continue;
    const pnlPct = (p.currentPrice - p.entryPrice) / p.entryPrice;
    const { stopLossPct, takeProfitPct, trailingStopPct, maxHoldDays } =
      effectiveLevels(p, defaults);

    const peak = Math.max(p.peakPrice ?? p.entryPrice, p.currentPrice);
    const trailStopPrice = peak * (1 - trailingStopPct);
    const trailActive = pnlPct >= defaults.activateTrailAtPct;

    let reason: ExitReason | null = null;
    if (pnlPct <= -stopLossPct) reason = "stop-loss";
    else if (trailActive && p.currentPrice <= trailStopPrice) reason = "trailing-stop";
    else if (pnlPct >= takeProfitPct) reason = "take-profit";
    else if (p.openedAt > 0) {
      const ageDays = (now - p.openedAt) / 86_400_000;
      if (ageDays >= maxHoldDays) reason = "max-hold";
    }
```

The relevant defaults, `agent/lib/exits.ts:30-52`:

```ts
export const DEFAULT_EXITS: ExitDefaults = {
  defaultStopLossPct: 0.1,
  defaultTakeProfitPct: 0.4,
  defaultMaxHoldDays: 20,
  ...
  defaultTrailingStopPct: 0.08,
  minTrailingStopPct: 0.03,
  maxTrailingStopPct: 0.2,
  activateTrailAtPct: 0.05,
};
```

Conventions to match: this module is pure and unit-tested, IO lives in the
caller. Comments in this repo explain *why*, at length, and are not written on
every line. `agent/lib/exits.test.ts` is the exemplar for test style, read it
before writing tests; it uses `node:test` with `node:assert/strict` and builds
plain object fixtures, no mocking framework.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| This file's tests | `node --test --experimental-strip-types agent/lib/exits.test.ts` | all pass |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |

## Scope

**In scope:**
- `agent/lib/exits.ts`, the arming condition only
- `agent/lib/exits.test.ts`, new tests

**Out of scope** (do NOT touch, even though they look related):
- The *values* in `DEFAULT_EXITS`. `activateTrailAtPct: 0.05` and
  `defaultTrailingStopPct: 0.08` may well be wrong for this strategy, but
  re-deriving them is plan 016 and it depends on plan 015's replay harness.
  Changing both the mechanism and the constants at once makes the result
  unattributable. **Fix the mechanism here; leave the numbers alone.**
- The exit *precedence* order (stop-loss → trailing → take-profit → max-hold).
- `agent/lib/hold-floor.ts` and anything about `maxHoldDays`.
- `agent/tools/manage_positions.ts`. It has its own problems (plan 012) but is
  not part of this fix.

## Git workflow

- Branch: `advisor/002-arm-trailing-stop-off-peak`
- One commit. Message style from `git log`: conventional commits, subject in the
  imperative, body explaining the mechanism, e.g.
  `fix(exits): arm the trailing stop off the peak, not the current price`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing test first

Add to `agent/lib/exits.test.ts` a test that fails against today's code:

A position with `entryPrice: 100`, `peakPrice: 109`, `currentPrice: 100.2`,
`trailingStopPct: 0.08`, using `DEFAULT_EXITS`. The peak is +9%, so the trail
should be armed; price has fallen to `109 * 0.92 = 100.28`, i.e. below the trail
stop, so the reason must be `"trailing-stop"`.

Today this returns `max-hold` or `null`, because `pnlPct` is +0.2% which is
under `activateTrailAtPct`.

**Verify**: `node --test --experimental-strip-types agent/lib/exits.test.ts`
→ the new test FAILS, everything else passes. A new test that passes before the
fix is not testing the fix.

### Step 2: Arm off the peak

In `agent/lib/exits.ts`, compute the arming condition from the peak rather than
the current price. The peak is already in scope on the line above:

```ts
const peakPnlPct = (peak - p.entryPrice) / p.entryPrice;
const trailActive = peakPnlPct >= defaults.activateTrailAtPct;
```

Leave `pnlPct` exactly as it is: stop-loss and take-profit must keep using the
current price, and the `detail` string reports current P&L.

Add a short comment recording why, in this repo's style: that arming on current
P&L made the two conditions mutually exclusive below a +14.13% peak, which is
why no trailing stop fired in the first 52 live trades.

**Verify**: `node --test --experimental-strip-types agent/lib/exits.test.ts`
→ all pass, including step 1's test.

### Step 3: Confirm nothing else moved

**Verify**: `pnpm test` → exit 0, `ℹ fail 0`. Existing exit tests must still
pass unchanged. If an existing test now fails, read it carefully before editing
it: it may have been asserting the buggy behaviour, in which case fix the test
and say so in the commit body. If it is asserting something else, STOP.

### Step 4: Mutation-check your own tests

This repo has shipped vacuous tests four times. Verify the new test bites:

1. Back up: `cp agent/lib/exits.ts /tmp/exits.bak`
2. Revert the fix by hand (`peakPnlPct` → `pnlPct` in the arming line only).
3. **Confirm the mutation actually landed**: `grep -n "trailActive" agent/lib/exits.ts`
   and read it. `cp` is aliased to `cp -i` in some shells here and has silently
   refused to overwrite before, producing a false green.
4. Run the tests → step 1's test must go RED.
5. Restore: `/bin/cp -f /tmp/exits.bak agent/lib/exits.ts`
6. **Verify the restore**: `git diff agent/lib/exits.ts` should show only your
   intended fix, and `pnpm test` must pass again.

**Verify**: you observed the test go red under mutation and green after restore.

## Test plan

New tests in `agent/lib/exits.test.ts`, modelled on the existing tests there:

1. **The regression** (step 1): peak +9%, current +0.2% → `"trailing-stop"`.
2. **Arming boundary**: peak exactly at `entry * (1 + activateTrailAtPct)` with
   current below the trail stop → fires. Peak just under → does not fire.
3. **The old threshold is gone**: a position whose peak is +9% and whose current
   price is above the trail stop must NOT exit as `"trailing-stop"` (proves the
   fix did not simply arm it always).
4. **Stop-loss still wins**: a position that is both below the hard stop and
   below the trail stop reports `"stop-loss"`, preserving precedence.
5. **Peak defaults to entry**: a position with no `peakPrice` that has never
   risen must not arm the trail.

Verification: `pnpm test` → all pass, 5 new tests.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0` and 5 more tests than the plan-001 baseline
- [ ] `grep -n "trailActive" agent/lib/exits.ts` shows the arming condition derived from `peak`, not from `pnlPct`
- [ ] `grep -n "activateTrailAtPct: 0.05" agent/lib/exits.ts` still matches, the constants did NOT change
- [ ] You observed the step-1 test go red under mutation and green after restore
- [ ] `git status` shows only `agent/lib/exits.ts` and `agent/lib/exits.test.ts` modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpt does not match the live `agent/lib/exits.ts`.
- An existing test fails and it is not obviously asserting the old buggy
  behaviour.
- You conclude the constants also need changing to make a test pass. They do
  not, for this fix, and changing them here makes plan 016 unattributable.
- The mutation in step 4 does not turn your new test red.
- You discover `checkExits` has another caller besides
  `agent/tools/manage_positions.ts` and `agent/lib/backtest.ts` that assumes the
  old behaviour.

## Maintenance notes

- **This changes live trading behaviour on the next cycle.** Positions that
  would previously have ridden to the 20-day timer will now exit on an 8%
  pullback from peak once they have been +5% at any point. Expect exit-reason
  distribution to shift immediately; that is the point, but it is worth watching
  the first week.
- A reviewer should check that `pnlPct` is still used for stop-loss,
  take-profit, and the `detail` string, and that only the arming line changed.
- Deliberately deferred: whether `activateTrailAtPct: 0.05` and
  `defaultTrailingStopPct: 0.08` are the right numbers for a strategy whose
  average win is +4.92%. Even armed correctly, a trail that arms at +5% and
  gives back 8% exits at `1.05 * 0.92 = 0.966`, i.e. a **-3.4% realised loss**.
  That is plan 016, and it needs plan 015's replay harness to answer with data
  rather than intuition.
- `agent/lib/backtest.ts` also calls `checkExits`, so backtest results before
  and after this change are not comparable. Plan 015 depends on this landing
  first for exactly that reason.
