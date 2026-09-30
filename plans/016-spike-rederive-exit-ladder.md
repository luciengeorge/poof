# Plan 016 (SPIKE): Re-derive the exit ladder from poof's own win distribution

> **Executor instructions**: This is a SPIKE with a decision at the end. The
> deliverable is a recommendation backed by numbers, and only then a small
> constants change if the numbers support one. Follow the steps, run every
> verification command, and stop at the STOP conditions rather than
> improvising. When done, update the status row in `plans/README.md` and write
> `plans/016-findings.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- agent/lib/exits.ts`
> If it changed beyond plan 002's arming fix, compare against "Current state"
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (this one does change live trading behaviour)
- **Depends on**: plans/015-spike-replay-live-trades.md (hard dependency)
- **Category**: direction
- **Planned at**: commit `0859c96`, 2026-09-30

## Why this matters

Plan 002 fixed the *mechanism*: the trailing stop now arms off the peak, so it
can fire. This plan asks whether the *numbers* are right, and there is good
reason to think they are not.

The measured average win on 52 closed trades is **+4.92%**. The trail arms at
`activateTrailAtPct: 0.05`. So the median winner never arms it even after the
fix. And when it does arm, at exactly +5%, the exit fires at
`peak × (1 - 0.08)` = `1.05 × 0.92` = **0.966 of entry, a -3.4% realised loss**.

A "primary exit for winners", per the comment in `agent/lib/exits.ts`, that
converts a +5% winner into a -3.4% loser is not obviously the right ladder for
a strategy whose wins average +4.92% and whose losses average -3.98%.

These constants were not fitted to this strategy. Until plan 015 existed there
was no way to fit them, because every sweep the project had run measured a
different signal process entirely.

## Current state

`agent/lib/exits.ts`, `DEFAULT_EXITS` as of `0859c96`:

```ts
export const DEFAULT_EXITS: ExitDefaults = {
  defaultStopLossPct: 0.1,
  defaultTakeProfitPct: 0.4,
  defaultMaxHoldDays: 20,
  minStopLossPct: 0.03,
  maxStopLossPct: 0.25,
  minTakeProfitPct: 0.05,
  maxTakeProfitPct: 0.6,
  defaultTrailingStopPct: 0.08,
  minTrailingStopPct: 0.03,
  maxTrailingStopPct: 0.2,
  activateTrailAtPct: 0.05,
};
```

The comment above it records the reasoning for `defaultMaxHoldDays: 20`,
including that a parameter sweep found 10 was the worst value on the curve.
**Read that comment before changing anything.** It also records that the sweep
was run across four non-overlapping windows, and it explicitly explains that
take-profit was loosened to 0.4 so it would not front-run the trail.

Note that the 20-day figure is documented as **coupled** to
`agent/lib/earnings.ts`: the binary-event guard assumes the same window, so the
two move together or a position gets held through an earnings print the guard
never flagged.

Measured live facts to anchor against, from 52 closed trades:
hit rate 54%, mean +0.81% per trade, average win +4.92%, average loss -3.98%,
45 of 52 exits on the max-hold timer, zero trailing-stop exits.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0, `ℹ fail 0` |
| Replay (from plan 015) | `node --experimental-strip-types scripts/replay-live-trades.ts` | prints the table |

## Scope

**In scope:**
- `plans/016-findings.md` (create), the analysis and recommendation
- `agent/lib/exits.ts`, **only** the numeric values in `DEFAULT_EXITS`, and
  only if the findings support a change
- `agent/lib/exits.test.ts`, update any test that pins a changed constant
- `agent/lib/earnings.ts`, **only** if `defaultMaxHoldDays` changes, because
  the two are documented as coupled

**Out of scope** (do NOT touch, even though they look related):
- The exit *mechanism*, precedence order, or any logic in `checkExits`. Plan
  002 owns that and it is already done.
- `agent/lib/hold-floor.ts` and `MIN_MAX_HOLD_DAYS`.
- Per-position stored exit levels on existing trades. Changing a default does
  not and must not rewrite history.
- The replay harness itself. If it needs changing, that is a defect in plan
  015's deliverable; report it rather than patching it here.

## Git workflow

- Branch: `advisor/016-spike-rederive-exit-ladder`
- The findings commit and the constants commit must be **separate**, so the
  analysis survives even if the parameter change is reverted.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Characterise the win distribution

Using the exported record from plan 015, compute and write into
`plans/016-findings.md`:

- the distribution of **peak** unrealised gain per trade, not just realised
  (the peak is what the trail acts on, and it is the number nobody has looked
  at yet),
- the same for peak drawdown from entry,
- how many trades ever exceeded each candidate `activateTrailAtPct`.

**Verify**: the findings file contains these distributions with counts, not
just summary statistics. A mean over 52 trades hides the shape.

### Step 2: Sweep the two constants together

Sweep `activateTrailAtPct` and `defaultTrailingStopPct` jointly over a sensible
grid through plan 015's replay. They interact: the realised exit of a trade
that arms at the threshold is `(1 + activate) × (1 - trail)`, so sweeping one
at a time is misleading.

Report, for each pair: total return, alpha versus SPY, max drawdown, and the
exit-reason distribution.

**Verify**: the findings file has the grid, and states which cells beat the
current (0.05, 0.08) pair.

### Step 3: Be honest about the sample

52 trades is small. Before recommending anything:

- state how much of any improvement comes from one or two trades (drop the
  best trade and the worst trade, and report whether the ranking survives),
- say plainly whether the best cell is distinguishable from the current one
  given the sample,
- prefer a **broad plateau** over a sharp peak. A sharp optimum on 52
  observations is overfitting, and the existing comment in `exits.ts` already
  shows the team reasoning this way about `defaultMaxHoldDays`.

**Verify**: the findings file contains the leave-one-out check and an explicit
statement about distinguishability.

### Step 4: Recommend, and only then change

If and only if step 3 supports it, change the constants in `DEFAULT_EXITS`.

Update the explanatory comment above them to record what was swept, over what
data, and why these values. The existing comment is a good model: it explains
the mechanism, not just the number.

If `defaultMaxHoldDays` changes, check `agent/lib/earnings.ts` for the coupled
assumption and update both together, or **STOP** if that turns out to be more
than a constant.

If the analysis does **not** support a change, say so and change nothing. "The
current values are fine and here is the evidence" is a successful outcome for
this spike, and a better one than a marginal tweak dressed up as an
improvement.

**Verify**: `pnpm test` → all pass. If a test pinned a constant you changed,
update it and say so in the commit body.

## Test plan

- No new behavioural tests; the mechanism is unchanged and already covered by
  plan 002's tests.
- If constants change, every test that pins them must be updated and must still
  assert something real. Specifically check `agent/lib/exits.test.ts` for tests
  that compare a value to the imported constant, which would pass regardless.
  That tautology has shipped in this repo before.
- Re-run plan 002's mutation check afterwards to confirm the arming test still
  bites with the new values.

## Done criteria

ALL must hold:

- [ ] `plans/016-findings.md` exists with the peak-gain distribution, the joint
      sweep grid, and the leave-one-out robustness check
- [ ] It states explicitly whether any pair is distinguishable from the current
      one given a 52-trade sample
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0`
- [ ] Either `DEFAULT_EXITS` is unchanged and the findings say why, or it is
      changed and the comment above it records the evidence
- [ ] If `defaultMaxHoldDays` changed, `agent/lib/earnings.ts` was checked
- [ ] Findings and constants are separate commits
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 015's replay did not reproduce reality well enough to trust (its own
  step 3). Everything here inherits that credibility.
- The best parameter pair is driven by one or two trades.
- `defaultMaxHoldDays` looks like it should change and the coupling to
  `agent/lib/earnings.ts` is more than a shared constant.
- You are tempted to also change the mechanism to make a parameter work. That
  is a sign the parameter is wrong, not the mechanism.
- Fewer than about 40 trades survived plan 015's filtering.

## Maintenance notes

- **This changes live trading behaviour.** A reviewer should be able to read
  `plans/016-findings.md` alone and agree with the conclusion without rerunning
  anything.
- The honest default is to change nothing. A 52-trade sample supports "the
  current values are clearly bad" far better than it supports "these specific
  other values are best".
- Whatever is chosen, revisit once the sample is materially larger. Record the
  trade count the decision was made on, inside the comment, so a future reader
  knows how much weight it carries.
- Deliberately not addressed here: whether a time-based exit belongs in the
  ladder at all once the trail works. That is a strategy question, not a
  parameter question, and it wants far more than 52 observations.
