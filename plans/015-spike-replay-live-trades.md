# Plan 015 (SPIKE): Replay poof's real trades through the backtest harness

> **Executor instructions**: This is a SPIKE. The deliverable is a working
> read-only tool plus a written answer to a specific question, not a change to
> how poof trades. Follow the steps, run every verification command, and stop
> at the STOP conditions rather than improvising. When done, update the status
> row in `plans/README.md` and write your findings into
> `plans/015-findings.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- agent/lib/backtest.ts agent/lib/exits.ts scripts/`
> If any changed, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (read-only, offline, no Convex writes, no broker calls)
- **Depends on**: plans/001-reinstall-dependency-tree.md, plans/002-arm-trailing-stop-off-peak.md
- **Category**: direction
- **Planned at**: commit `0859c96`, 2026-09-30

## Why this matters

poof's live record is 52 closed trades with **+0.81% mean return per trade** and
a 54% hit rate. The picks have positive expectancy. But 45 of those 52 (87%)
exited on the max-hold timer, because the trailing stop could not fire (fixed
in plan 002). So the obvious question is worth real money:

> On the same 52 entries, what would a working exit ladder have paid?

Today that is unanswerable, and worse, the sweeps that appear to answer it are
answering it about a different strategy. `scripts/sweep-maxhold.ts` and
`scripts/sweep-sizing.ts` both generate one entry per ticker on the first
session of the window, so every exit parameter this project has ever swept was
measured against a six-month buy-and-hold signal, not against poof's ~10 to 20
day news-catalyst entries.

The harness is already faithful in the ways that matter: fills at the next
open, exits evaluated on the daily close, one observation per day, the same
`checkExits` the live exit engine uses. The only thing missing is the ability
to feed it real entries with their real stored exit levels.

**Plan 016 depends on this.** Re-deriving the exit constants without it is
guessing with extra steps.

## Current state

`agent/lib/backtest.ts` around lines 26-31: the `Signal` type carries only
`{ ticker, date, notional? }`. There is nowhere to put the stop, trail, take
profit, or hold that the live trade actually carried.

Around lines 256-266, every replayed position is constructed with the exit
fields hardcoded absent:

```ts
stopLossPct: undefined,
takeProfitPct: undefined,
maxHoldDays: undefined,
```

`trailingStopPct` is not set at all. So `effectiveLevels` always falls back to
`DEFAULT_EXITS`, and the per-position values that governed real trades are
invisible to the harness.

Production stores exactly what is needed, on the `trades` table
(`convex/schema.ts`): `ticker`, `createdAt`, `price`, `fillPrice`,
`stopLossPct`, `takeProfitPct`, `trailingStopPct`, `maxHoldDays`, `closedAt`,
`exitPrice`, `pnl`, `status`, `strategyTag`.

No script in `scripts/` exports trades from Convex.

A working daily-candle provider exists at `agent/lib/tiingo.ts` (`getCandles`).
Note that Finnhub's `/stock/candle` returns **HTTP 403** on this account's free
tier, verified 2026-09-30, so do not use it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0, `ℹ fail 0` |
| Existing backtest | `pnpm backtest` | runs, prints a table |

Reading production Convex needs `CONVEX_URL` pointing at the production
deployment and the shared secret in the environment. Reference them by name;
never print a secret value, and never write one into a file.

## Scope

**In scope:**
- `agent/lib/backtest.ts`, extend `Signal` and thread the exit fields through
- `agent/lib/backtest.test.ts`, tests for the threading
- `scripts/export-trades.ts` (create), read-only export of the closed record
- `scripts/replay-live-trades.ts` (create), the replay and its report
- `plans/015-findings.md` (create), the written answer

**Out of scope** (do NOT touch, even though they look related):
- `agent/lib/exits.ts`. The values in `DEFAULT_EXITS` are plan 016's subject.
  This spike must not change trading behaviour at all.
- `scripts/sweep-maxhold.ts` and `scripts/sweep-sizing.ts`. Leave them; note
  in your findings that their results were measured on a different signal
  process.
- Any Convex mutation. This spike is **read-only against production**.
- Live trading configuration of any kind.

## Git workflow

- Branch: `advisor/015-spike-replay-live-trades`
- Commits per logical unit. Conventional commits.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Thread real exit levels into the harness

Extend `Signal` in `agent/lib/backtest.ts` with optional `stopLossPct`,
`takeProfitPct`, `trailingStopPct` and `maxHoldDays`, and pass them into the
`OpenPosition` built around line 256 instead of the hardcoded `undefined`s.

Absent fields must still fall back to `DEFAULT_EXITS`, so existing callers
behave exactly as before.

**Verify**: `pnpm test` → all pass, existing backtest tests unchanged. Add a
test asserting a `Signal` carrying `maxHoldDays: 7` produces a position that
exits on day 7 rather than at the 20-day default. That test must fail if you
revert the threading.

### Step 2: Export the closed record, read-only

Write `scripts/export-trades.ts` that queries production Convex and writes the
closed BUY record to a local JSON file.

**The survivorship trap**: there are three closed statuses, `closed`,
`closed-estimated` and `closed-unknown`. A `closed-unknown` row carries a
placeholder `pnl` of 0 and its exit price is not real. Filter on the status
values explicitly, and **report the counts of each** so the sample is
characterised rather than silently biased. Do not filter by "has a pnl number".

**Verify**: the script writes a file; its row count and status breakdown match
what you would expect from a record of 99 trade rows, 52 of them closed. Print
the breakdown.

### Step 3: Replay

Write `scripts/replay-live-trades.ts` that, for each exported trade, fetches
daily candles around its real holding window via `agent/lib/tiingo.ts`, feeds
the entry as a `Signal` carrying its real stored exit levels, and runs the
existing harness.

Print the same shape of table the existing sweeps print: total return, alpha
versus SPY over the same window, max drawdown, and an **exit-reason
distribution**.

**Verify**: the replay reproduces the real outcome approximately. This is the
credibility check for the whole spike. If replayed P&L is wildly different from
the recorded `pnl`, the harness is not modelling reality and every number after
this is worthless. Quantify the agreement and put it in the findings.

### Step 4: Answer the question

With the harness trusted, run it under at least these configurations and put
the results in `plans/015-findings.md`:

1. **As it actually traded** (stored exit levels, pre-plan-002 trail behaviour
   if you can express it), the baseline.
2. **With the plan-002 fix** (trail arming off the peak), same stored levels.
3. A small sweep of `activateTrailAtPct` and `defaultTrailingStopPct` around
   the current 0.05 / 0.08.

**Verify**: `plans/015-findings.md` exists and states, with numbers: how well
the replay matched reality, what the exit-reason distribution becomes once the
trail can fire, and whether any parameter pair beats the current one by more
than the noise in a 52-trade sample.

That last clause matters. **52 trades is a small sample.** Say so explicitly and
give some indication of the uncertainty rather than reporting a winner to three
decimal places.

## Test plan

- The step 1 threading test (a `Signal`'s `maxHoldDays` actually governs).
- One test per new exit field, or one table-driven test covering all four.
- Mutation-check the threading: revert it, **confirm with `grep` that the
  mutation landed** (`cp` is aliased to `cp -i` here and has silently refused
  to overwrite before, producing a false green), confirm the test goes red,
  restore with `/bin/cp -f`, confirm green.
- The scripts themselves do not need unit tests; step 3's agreement check is
  their verification.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0`, including the new threading tests
- [ ] `grep -n "stopLossPct: undefined" agent/lib/backtest.ts` returns no match
- [ ] `scripts/export-trades.ts` runs read-only and prints a status breakdown
- [ ] `scripts/replay-live-trades.ts` runs and prints an exit-reason distribution
- [ ] `plans/015-findings.md` states the replay-vs-reality agreement with numbers
- [ ] No Convex mutation was executed; no secret value written to any file
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The replay does not approximately reproduce recorded P&L (step 3). Report the
  discrepancy. Do **not** tune the harness until it agrees; that is fitting the
  instrument to the answer.
- Tiingo cannot supply candles for a material fraction of the tickers. Report
  the coverage rate.
- You find yourself wanting to change `agent/lib/exits.ts`. That is plan 016.
- Fewer than about 40 trades survive filtering. Below that the sweep in step 4
  is not worth running and you should say so instead of running it.
- Any step would require a write to production Convex.

## Maintenance notes

- The output of this spike is an **input to a decision**, not a decision. Plan
  016 uses it. Resist reporting a single "best" parameter pair; report the
  shape of the surface and the uncertainty.
- Whoever reviews this should look hardest at step 3's agreement check. Every
  later number inherits it.
- Worth recording in the findings for future readers: the existing
  `sweep-maxhold` and `sweep-sizing` results were measured on one-entry-per-
  ticker buy-and-hold signals, so they do not describe poof's actual strategy
  and should not be cited as if they do.
- Deliberately out of scope but worth noting: the funnel now records a
  `higherIn10d` forecast and a real 10-day outcome for hundreds of names a day.
  Once plan 008 makes that scoring work, it becomes a far larger dataset than
  52 trades for questions about entry quality, though not about exits.
