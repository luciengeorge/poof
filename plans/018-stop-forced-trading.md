# Plan 018: Stop telling the agent to trade when it has no reason to

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. The reviewer maintains `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat e921a44..HEAD -- agent/instructions.md`
> If it changed, compare the "Current state" excerpts against the live file;
> on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (it changes what a live, real-money agent does every day)
- **Depends on**: plans/017-index-core.md, and **must ship in the same release**
- **Category**: bug
- **Planned at**: commit `e921a44`, 2026-09-30

## Why this matters

`agent/instructions.md` tells the agent, in bold, to trade every cycle even when
it has no edge, and to lower its standards until something qualifies. With a
measured stock-picking edge of zero (53 trades, t = 0.37, -0.02% after costs)
and about 0.3% paid in FX on every US round trip, that instruction buys a
guaranteed cost for no expected benefit. Estimated at roughly 4.9% a year under
the current limits (about 18 round trips per slot per year, times 0.3%, times 90%
deployed).

Published basis: Barber and Odean, "Trading Is Hazardous to Your Wealth"
(Journal of Finance, 2000). The most active fifth of households earned 11.4% a
year net against 17.9% for the market; their gross returns were close to the
market, so costs made the gap.

The instruction was written for a sound reason, "cash guarantees you lose to
SPY", but it fights idle cash with the most expensive tool available. Plan 017
parks idle capital in the index, so **the alternative to a stock trade becomes
the index, not cash.** With that in place the forced-trade rule has no remaining
purpose. The owner decided on 2026-09-30: poof buys or sells only when it has a
reason to.

**Ship this only with plan 017.** Removing forced trading without the index core
would leave more money in cash and make the drag worse.

## Current state

`agent/instructions.md`, as of `e921a44`. Every line below is a target.

Line 8 (stale since commit 022d985 raised the floor to 15%):
> Trading 212 supports fractional shares and there is no minimum trade size**
> beyond the gate's 2%-of-equity floor.

Line 14:
> **Concentrate and deploy.** The gate enforces: each trade between **15% and
> 30% of equity** ... Aim for 3-4 names at roughly 20-30% each with 80-90% of the
> account working. Seven weeks of £5-£10 "probes" left a strategy with positive
> expectancy flat ...

Line 20, the core of the problem:
> Default to **opening at least one position each cycle.** A "no-trade" cycle is
> only justified on a genuinely empty day ... Ordinary uncertainty, a stock that
> "already moved," or "no clear edge" are NOT reasons to sit out ... If you catch
> yourself rejecting every candidate, lower your bar and take the best one with a
> defined stop. The stop caps the downside; cash guarantees you lose to SPY.

Line 28 (inside step 3, "Review performance"):
> Use the track record to learn: read `realizedByTag` and bias sizing/selection
> toward strategy types with **positive realized expectancy** ... Trailing SPY is
> a reason to trade *better*, never a reason to stop trading and sit in cash
> (cash can't beat SPY).

Also note line 14's claim of "a strategy with positive expectancy". Measured
against the index over the same holding windows, the picks show no edge; the
+0.8% mean per trade was mostly the market rising.

Conventions: the instructions file is plain, direct prose addressed to the
agent, with bold for rules that matter. Match that voice. Keep it concise; do not
add a long essay. No em-dashes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Node | `source ~/.nvm/nvm.sh >/dev/null 2>&1 && nvm use >/dev/null 2>&1` | v24.x |
| Tests | `pnpm test` | exit 0, `ℹ fail 0` |
| Typecheck | `pnpm typecheck` | exit 0 |

## Scope

**In scope:**
- `agent/instructions.md`: lines 8, 14, 20 and the relevant sentences of line 28
- one new test file asserting the prompt's content (suggest `agent/lib/instructions.test.ts`)

**Out of scope** (do NOT touch):
- Every other line of `agent/instructions.md`. Do not reword, reformat or
  "improve" anything else; this is a real-money agent and every change to its
  prompt is a behaviour change.
- Any subagent prompt under `agent/subagents/`.
- Risk limits, exits, or any code. The 15% trade floor stays: a stock trade that
  does happen should be large enough to matter.
- `.env.example` (plan 004).

## Git workflow

- Branch: the same `feat/index-core` branch as plan 017, one separate commit.
- Conventional commits, ending with the two attribution lines you are given.
- Stage explicit paths only. Do NOT push or open a PR.

## Steps

### Step 1: Tests first

Create `agent/lib/instructions.test.ts` that reads `agent/instructions.md` and
asserts it does **not** contain any of:

- `opening at least one position each cycle`
- `lower your bar`
- `are NOT reasons to sit out`
- `cash guarantees you lose to SPY`
- `cash can't beat SPY`
- `2%-of-equity floor`
- `bias sizing/selection toward strategy types`

and that it **does** mention the index core by its ticker `VUAGl_EQ` and states
that a cycle with no stock trade is normal.

**Verify**: `node --test --experimental-strip-types agent/lib/instructions.test.ts`
FAILS on every assertion. A test that passes before the edit is not testing it.

### Step 2: Rewrite the four targets

- **Line 8**: correct the stale 2% floor to the real 15% floor.
- **Line 14**: keep the limits the gate enforces (15-30% per trade, 30% per
  name, at most 4 stock positions, price at least $5). Replace the "aim for 3-4
  names ... 80-90% working" deployment target: idle capital now sits in the index
  core automatically, so the stock sleeve holds **zero to four** names. Remove
  the claim that the strategy has positive expectancy.
- **Line 20**: replace the forced-trade rule with its opposite, plainly: the
  index core (`VUAGl_EQ`) is the default home for money; buy a stock only when
  you have a specific, fresh reason to expect it to beat the index over your hold
  period; a cycle with no stock trade is normal and not a failure; and if a
  wanted buy is rejected for insufficient cash, poof sells enough of the core and
  the buy can be placed next cycle. Keep "use a defined stop" for any stock you
  do buy.
- **Line 28**: remove the instruction to bias sizing toward `realizedByTag`.
  Say instead that per-tag and overall stats are currently too small to act on
  (fewer than about 400 trades cannot detect a 0.5% edge) and must not drive
  sizing. Remove the "trailing SPY ... never a reason to stop trading" sentence.

**Verify**: step-1 tests all pass.

### Step 3: Nothing else changed

**Verify**: `git diff agent/instructions.md` touches only lines 8, 14, 20 and
the named sentences in 28. Read the diff line by line. `pnpm test` exits 0.

### Step 4: Mutation-check

Restore one forbidden phrase (for example put back "lower your bar"), **confirm
with grep it landed**, run the test, confirm RED, restore with `/bin/cp -f`,
confirm `git diff` shows only your intended edits, confirm green. Repeat for
removing the `VUAGl_EQ` mention.

**Verify**: both mutations observed red.

## Test plan

`agent/lib/instructions.test.ts` covering the forbidden phrases and the required
core mention. The prompt has no unit-testable logic beyond its content, so a
content test is the right tool here, and it prevents the forced-trade rule being
reintroduced by a later edit.

## Done criteria

ALL must hold:

- [ ] `pnpm test` exits 0 with `ℹ fail 0`, including the new test
- [ ] `grep -c "lower your bar" agent/instructions.md` prints 0
- [ ] `grep -c "VUAGl_EQ" agent/instructions.md` prints at least 1
- [ ] `git diff --stat` shows only `agent/instructions.md` and the new test file
- [ ] Both mutations observed red
- [ ] Committed on `feat/index-core`, not pushed

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" lines do not match the live file.
- Making the change seems to require editing a subagent prompt or code.
- Plan 017 has not been implemented on the branch yet. This must not ship alone.

## Maintenance notes

- **Expect far fewer stock trades.** That is the intended outcome, not a bug.
  Several quiet cycles in a row are normal now.
- A reviewer should read the rewritten paragraphs in full as the agent will, and
  ask one question: would a model reading this still feel obliged to trade?
- If a future change wants the agent to trade more, the evidence bar is the one
  plan 019 sets up: a stock-selection signal whose rank IC clears about 0.04 with
  t of at least 2. Not a return to forced activity.
