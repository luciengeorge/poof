# Plan 002: Arm the trailing stop off the peak, and only at breakeven

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e921a44..HEAD -- agent/lib/exits.ts agent/lib/exits.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpt against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-reinstall-dependency-tree.md (DONE 2026-09-30)
- **Category**: bug
- **Planned at**: commit `e921a44`, 2026-09-30 (revised from the `0859c96` version)

## Why this matters

The trailing stop is documented in `agent/lib/exits.ts` as "the primary exit
on winners". In 52 closed live trades it fired **zero** times and 45 of 52
positions (87%) exited on the max-hold timer.

Two separate problems, and this plan fixes both.

**Problem 1, the bug.** The stop *price* is computed from the peak, but the
*arming condition* is checked against the current price:

```
trailStopPrice = peak * (1 - trailingStopPct)      // peak-based
trailActive    = pnlPct >= activateTrailAtPct      // current-price-based
```

With the defaults (`activateTrailAtPct: 0.05`, `defaultTrailingStopPct: 0.08`)
both conditions only hold together when `peak >= entry * 1.05 / 0.92`, i.e. a
peak of **+14.13%**. Below that they are mutually exclusive: by the time the
price has fallen 8% off the peak it is already under the +5% line, so the trail
disarms itself at the moment it should trigger.

**Problem 2, the arithmetic of simply fixing the bug.** If arming used the peak
but kept `activateTrailAtPct: 0.05`, any trade that touched +5% and pulled back
would be stopped at `1.05 * 0.92 = 0.966` of entry: a **-3.4% realised loss**.
The trail would convert small winners into losers. For the exit to be at or
above entry, the peak must satisfy `peak * (1 - trail) >= entry`, so:

```
breakeven activation = 1 / (1 - trailingStopPct) - 1
                     = 1 / 0.92 - 1 = 0.0870 for the default 8% trail
```

The owner decided on 2026-09-30 that the trail should **only ever lock in a
gain**, so it must arm at the breakeven point, not at +5%. Published basis for
not wanting a stop that realises losses: Kaminski & Lo (2014) find stop rules
lower expected return unless returns trend at that horizon, and 1-month
reversal (Jegadeesh 1990) points the other way at roughly this hold length.

**This is a correctness fix, not a return improvement.** Nobody should expect
it to make money. It makes the trail do what its own comment says, and makes it
unable to turn a winner into a loser at the observed price.

## Current state

`agent/lib/exits.ts`, `checkExits`, as of `e921a44`:

```ts
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
```

Note `trailingStopPct` comes from `effectiveLevels`, which clamps a
per-position value into `[minTrailingStopPct 0.03, maxTrailingStopPct 0.2]`.
So the trail width **varies per position**, and the breakeven activation must
be derived from **that position's** width, not from the 8% default. A position
with a 15% trail needs a peak of `1/0.85 - 1 = +17.6%` before its trail can
exit at or above entry.

Conventions: this module is pure and unit-tested; IO lives in the caller.
Comments explain *why*, at length, and are not on every line.
`agent/lib/exits.test.ts` is the exemplar: `node:test` plus
`node:assert/strict`, plain object fixtures, no mocking framework. Read it
before writing tests.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Node | `source ~/.nvm/nvm.sh && nvm use` | `v24.x` |
| Typecheck | `pnpm typecheck` | exit 0 |
| Convex typecheck | `npx tsc -p convex/tsconfig.json` | exit 0 |
| This file's tests | `node --test --experimental-strip-types agent/lib/exits.test.ts` | all pass |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |

The verified baseline on 2026-09-30 is **633 tests** on Node 24. The count
prefix is `ℹ` on Node 24 and `#` on Node 22; seeing `#` means the wrong Node.

## Scope

**In scope:**
- `agent/lib/exits.ts`: the arming condition, and nothing else in the function
- `agent/lib/exits.test.ts`: new tests

**Out of scope** (do NOT touch, even though they look related):
- The numeric values in `DEFAULT_EXITS`. Leave `activateTrailAtPct: 0.05` in
  place as a floor; the derived breakeven will dominate it for every legal
  trail width. Changing the constants is plan 016's subject and needs plan
  015's replay harness.
- Stop-loss, take-profit and max-hold logic, and the precedence order.
- Whether the trail should refuse to fire once the price is below entry after
  an overnight gap. That is a further behaviour change with no evidence behind
  it; see Maintenance notes.
- `agent/tools/manage_positions.ts`, `agent/lib/backtest.ts`, `hold-floor.ts`.

## Git workflow

- Branch: `fix/trailing-stop-breakeven` (already created by the reviewer; work on it)
- One commit. Conventional commits, imperative subject, body explaining the
  mechanism, e.g. `fix(exits): arm the trailing stop off the peak, at breakeven`.
- Do NOT push or open a PR. The reviewer does that.

## Steps

### Step 1: Write the failing tests first

Add to `agent/lib/exits.test.ts`, using `DEFAULT_EXITS` and a position with
`entryPrice: 100`, an explicit `trailingStopPct: 0.08`, and no stop-loss or
take-profit crossing:

1. **Peak +9%, current 100.2.** Trail stop is `109 * 0.92 = 100.28`, current is
   below it, peak is above breakeven (+8.70%). Must return `"trailing-stop"`.
   Today this returns null or `max-hold`, because current P&L (+0.2%) is under
   the +5% arming line.
2. **Peak +8%, current 99.3.** Trail stop is `108 * 0.92 = 99.36`, current is
   below it, but +8% is under breakeven. Must **NOT** return `"trailing-stop"`.
   This is the test that proves the trail can no longer realise a loss at the
   observed price.
3. **Peak +5%, current 96.6.** The exact case the owner rejected: without the
   breakeven rule this would exit at -3.4%. Must **NOT** return `"trailing-stop"`.

**Verify**: `node --test --experimental-strip-types agent/lib/exits.test.ts`
shows test 1 FAILING and tests 2 and 3 passing (they pass today only because
the trail never arms at all). Everything else passes. A new test 1 that passes
before the fix is not testing the fix.

### Step 2: Arm off the peak, at the position's breakeven

In `checkExits`, replace the arming line with an activation derived from the
peak and from this position's own trail width:

```ts
const peakPnlPct = (peak - p.entryPrice) / p.entryPrice;
const breakevenActivation = 1 / (1 - trailingStopPct) - 1;
const activation = Math.max(defaults.activateTrailAtPct, breakevenActivation);
const trailActive = peakPnlPct >= activation;
```

Leave `pnlPct` exactly as it is: stop-loss, take-profit and the `detail` string
must keep using the current price.

Add a comment recording why, in this repo's style: arming on current P&L made
the two conditions mutually exclusive below a +14.13% peak, which is why no
trailing stop fired in the first 52 live trades; and arming at a fixed +5% would
have stopped a +5% winner out at -3.4%, so activation is the breakeven point for
this position's trail width, making the trail unable to exit below entry at the
observed price.

**Verify**: all three step-1 tests pass.

### Step 3: Width-dependence test

Add a fourth test: a position with `trailingStopPct: 0.15` and peak +12%.
Breakeven for a 15% trail is +17.6%, so even with current below the trail stop
it must **NOT** fire. Then peak +20% with current at or below `120 * 0.85 =
102` must fire.

This proves the activation is derived per position and not hard-coded to 8.7%.

**Verify**: passes.

### Step 4: Nothing else moved

**Verify**: `pnpm test` exits 0 with `ℹ fail 0`. If an existing exit test now
fails, read it carefully: it may have been asserting the buggy behaviour, in
which case fix the test and say so in the commit body. If it asserts something
else, STOP.

### Step 5: Mutation-check

This repo has shipped vacuous tests several times, and twice in one session a
mutation "passed" because it had not actually landed.

For each mutation: back the file up, apply the mutation, **confirm with `grep`
that it landed on the intended line** (two lines can share an expression; `perl`
without `/g` takes the first), run the tests, confirm RED, restore with
`/bin/cp -f`, confirm `git diff` shows only the intended change, confirm green.

Mutations to run:
- A: revert arming to `pnlPct >= defaults.activateTrailAtPct` → test 1 goes red.
- B: drop the breakeven term, arming at `peakPnlPct >= defaults.activateTrailAtPct`
  → tests 2 and 3 go red.
- C: hard-code `breakevenActivation = 0.087` → the step-3 width test goes red.

Do not chain `grep -c` into `&&`; it exits non-zero when the count is 0 and
silently skips the next command.

**Verify**: each of A, B, C observed red, and the suite green after restore.

## Test plan

New tests in `agent/lib/exits.test.ts` (steps 1 and 3), plus:
- **Stop-loss still wins**: a position both below the hard stop and below the
  trail stop reports `"stop-loss"`.
- **No peak, no arm**: a position with no `peakPrice` that has never risen does
  not arm the trail.

Verification: `pnpm test` → all pass, 6 new tests, 639 total.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0` and 6 more tests than the 633 baseline
- [ ] `grep -n "breakevenActivation" agent/lib/exits.ts` matches
- [ ] `grep -n "activateTrailAtPct: 0.05" agent/lib/exits.ts` still matches (constant unchanged)
- [ ] Mutations A, B, C each observed red
- [ ] `git status` shows only `agent/lib/exits.ts` and `agent/lib/exits.test.ts` modified
- [ ] One commit on `fix/trailing-stop-breakeven`, not pushed

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpt does not match the live code.
- An existing test fails and is not obviously asserting the old buggy behaviour.
- You find another caller of `checkExits` besides `agent/tools/manage_positions.ts`
  and `agent/lib/backtest.ts`.
- You are tempted to change `DEFAULT_EXITS` values or the precedence order.
- Any mutation fails to turn its test red after you have confirmed it landed.

## Maintenance notes

- **This changes live trading behaviour from the next cycle.** A position must
  now have been at least +8.7% (default trail) before the trail can arm, and the
  first exit it can produce is at or above entry at the price observed by the
  daily cycle.
- **Gap risk is not eliminated.** The trail is checked once a day. If a stock
  peaks at +10% and gaps overnight to -5%, the check `current <= trailStop`
  fires and the market order realises about -5%. "Only locks in a gain" holds at
  the price the cycle observes, not against gaps between cycles. Nothing short
  of intraday monitoring fixes that.
- Deliberately not done: refusing to fire the trail once the price is below
  entry and deferring to the hard stop-loss instead. It is defensible either
  way and there is no evidence to choose, so the existing semantics are kept.
- `agent/lib/backtest.ts` also calls `checkExits`, so backtests before and after
  this change are not comparable. Plan 015 depends on this landing first.
