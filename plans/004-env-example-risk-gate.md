# Plan 004: Stop `.env.example` reinstating the pre-#76 risk gate

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 0859c96..HEAD -- .env.example agent/lib/risk.ts agent/lib/state.ts README.md`
> If any of those changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-reinstall-dependency-tree.md (so a green test run is evidence)
- **Category**: security
- **Planned at**: commit `0859c96`, 2026-09-30

## Why this matters

poof trades a real Trading 212 UK ISA with roughly £250 of real money. The risk
gate is the only thing standing between the model and that money, and its
shipped values were retuned in commit `022d985` ("feat(risk): concentrate
positions and floor the hold period (#76)") after seven weeks live showed the
median order was £10 on a £250 account: a correct pick at that size is eight
pence of profit. #76 raised the per-trade floor from 2% to 15%, cut the position
cap from 10 to 4, and loosened the circuit breakers to match four concentrated
names.

`.env.example` was never updated. It still carries **live, uncommented**
`TRADING_*` assignments holding the pre-#76 values, and `README.md:26` tells
every new operator to copy that file to `.env.local` and fill it in. Anyone who
follows the documented setup silently restores the exact £5-probe sizing that
#76 existed to eliminate, on a deployment that may well be pointed at the live
account. Six of the ten override lines are wrong.

This is currently latent, not active: `vercel env ls production` shows no
`TRADING_*` variable set on the deployment, and the repo's own `.env.local` sets
none either. So nothing is broken today. The bug fires the first time somebody
follows the README.

After this change, copying `.env.example` cannot alter the gate, and a test
fails the build if the documented values ever drift from `DEFAULT_LIMITS` again.

## Current state

Files involved:

- `.env.example`: the committed setup template. Lines 42-53 are the limit
  overrides. Every one is a live assignment, not a comment.
- `agent/lib/risk.ts`: `DEFAULT_LIMITS` at lines 70-81, the shipped truth.
- `agent/lib/state.ts`: `resolveLimits()` at line 120 overlays `TRADING_*` env
  vars onto `DEFAULT_LIMITS`; `DEFAULT_LOSS_DAY_MIN_DROP_PCT` at line 37.
- `README.md:26`: the instruction to copy the file.

`.env.example:42-53` exactly as it exists today:

```
# --- LIMIT OVERRIDES (tune risk-gate aggression; unset/blank/non-numeric falls back to the shipped default) ---
TRADING_MAX_PER_NAME_PCT=0.3                # default 0.3 (30% of equity max in any single name)
TRADING_MAX_DEPLOYED_PCT=1.0                # default 1.0 (100% of equity may be deployed, no idle-cash reserve)
TRADING_MAX_NEW_POSITIONS_PER_DAY=6         # default 6
TRADING_MIN_TRADE_PCT=0.02                  # default 0.02 (2% of equity floor per trade)
TRADING_MAX_TRADE_PCT=0.3                   # default 0.3 (30% of equity ceiling per trade)
TRADING_DAILY_LOSS_HALT_PCT=0.04            # default 0.04 (4% daily loss circuit breaker)
TRADING_MAX_CONCURRENT_POSITIONS=10         # default 10
TRADING_MIN_PRICE=5                         # default 5 (USD minimum share price)
TRADING_MAX_DRAWDOWN_PCT=0.1                # default 0.1 (10% drawdown circuit breaker)
TRADING_MAX_CONSECUTIVE_LOSS_DAYS=2         # default 2
TRADING_LOSS_DAY_MIN_DROP_PCT=0.015          # min day-over-day drop (fraction) that counts as a "loss day" for the consecutive-loss-days breaker; smaller moves are noise
```

`agent/lib/risk.ts:70-81`, the shipped truth:

```ts
export const DEFAULT_LIMITS: RiskLimits = {
  maxPerNamePct: 0.3,
  maxDeployedPct: 0.9,
  maxNewPositionsPerDay: 4,
  minTradePct: 0.15,
  maxTradePct: 0.3,
  dailyLossHaltPct: 0.06,
  maxConcurrentPositions: 4,
  minPrice: 5,
  maxDrawdownPct: 0.15,
  maxConsecutiveLossDays: 2,
};
```

The six that disagree:

| env var | `.env.example` says | `DEFAULT_LIMITS` really is |
|---|---|---|
| `TRADING_MAX_DEPLOYED_PCT` | 1.0 | 0.9 |
| `TRADING_MAX_NEW_POSITIONS_PER_DAY` | 6 | 4 |
| `TRADING_MIN_TRADE_PCT` | 0.02 | **0.15** |
| `TRADING_DAILY_LOSS_HALT_PCT` | 0.04 | 0.06 |
| `TRADING_MAX_CONCURRENT_POSITIONS` | 10 | **4** |
| `TRADING_MAX_DRAWDOWN_PCT` | 0.1 | 0.15 |

`TRADING_LOSS_DAY_MIN_DROP_PCT` is not part of `DEFAULT_LIMITS`. Its default
lives at `agent/lib/state.ts:37`:

```ts
export const DEFAULT_LOSS_DAY_MIN_DROP_PCT = 0.015;
```

so the value shown in `.env.example` for that one is already correct.

Why commenting out is the right fix rather than correcting the numbers in
place: `agent/lib/state.ts:107-113` already treats an unset var as "use the
shipped default".

```ts
function numFromEnv(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
```

So a commented-out line produces today's gate exactly, and a copied `.env.local`
can no longer pin a stale number. Correcting the numbers in place would work
today and rot again on the next tuning commit, which is precisely the failure
this plan is fixing.

Repo conventions that apply here:

- Comments explain WHY, at length, and are not written on every line. Read the
  block comment above `DEFAULT_LIMITS` at `agent/lib/risk.ts:64-69` for the
  house voice.
- No em-dashes anywhere.
- Tests use `node:test` with `node:assert/strict` and plain object fixtures, no
  mocking framework.
- Reading a source file as text inside a test to pin a structural fact is an
  established pattern here. `agent/lib/hold-floor.test.ts:81` and
  `agent/lib/funnel.test.ts:282` both do it with
  `readFileSync(new URL("../path", import.meta.url), "utf8")`. Model the new
  test on those.
- NEVER use TypeScript parameter properties (`constructor(private readonly x)`).
  `--experimental-strip-types` cannot erase them and the whole test file dies
  with a bare "test failed".

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck (app) | `pnpm typecheck` | exit 0 |
| Typecheck (convex) | `npx tsc -p convex/tsconfig.json` | exit 0 |
| This file's tests | `node --test --experimental-strip-types agent/lib/env-example.test.ts` | all pass |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |

Note on the summary prefix: Node 24 prints `ℹ pass N` / `ℹ fail N`, Node 22
prints `# pass N` / `# fail N`. Plan 001 puts this repo on Node 24 (`.nvmrc`,
`engines: 24.x`). If you see `#` instead of `ℹ`, you are on the wrong Node and
plan 001 is not done; a grep pinned to one prefix will silently match nothing.

## Scope

**In scope** (the only files you should modify):

- `.env.example`: lines 42-53 only
- `agent/lib/env-example.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):

- **The values in `agent/lib/risk.ts`.** They are correct. This plan makes the
  documentation match the code, never the other way round. If you find yourself
  editing `DEFAULT_LIMITS` to make a test pass, you have the direction backwards.
- `agent/lib/state.ts`. `resolveLimits` and `numFromEnv` already behave
  correctly. Do not refactor the env-var-name mapping out of it; that is a
  money-path file and the test in step 2 pins the mapping without touching it.
- `agent/instructions.md:8`. It says "the gate's 2%-of-equity floor" in prose,
  which is the same stale pre-#76 number reaching the model rather than the
  gate. It is real and it is recorded in Maintenance notes below, but changing
  the agent's prompt changes trading behaviour and belongs in its own change
  with its own review. Leave it.
- `.env.example:28` (the `TIINGO_API_KEY` line). Plan 008 edits that line. Do
  not touch it, so the two plans do not collide in the same file.
- `README.md`. The "copy this file" instruction stays correct once the file is
  safe to copy.
- Any `TRADING_*` variable on Vercel or in `.env.local`. Neither has any set
  today; verify with the step 0 command and change nothing.

## Git workflow

- Branch: `advisor/004-env-example-risk-gate`
- One commit. Message style from `git log`: conventional commits, subject in the
  imperative, body explaining the mechanism. For example:
  `fix(config): comment out the stale TRADING_* overrides in .env.example`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0: Confirm the bug is latent, not already live

Before changing anything, establish that no deployment is currently running on
the stale values. If one is, that is a live incident and outranks this plan.

```
grep -cE '^TRADING_[A-Z_]+=' .env.local || echo "0 (none set locally)"
npx vercel env ls production 2>&1 | grep -c TRADING_ || echo "0 (none set on Vercel)"
```

**Verify**: both report zero. If either is non-zero, STOP and report which
variable is set where; a live override means the gate in production is not the
gate in the code, and somebody needs to decide that deliberately.

### Step 1: Comment out the overrides and remove the drifting prose numbers

Replace `.env.example` lines 42-53 with the block below, exactly. Two things
change and both matter:

1. Every assignment is commented out, so copying the file can no longer pin a
   value.
2. The stated default is now the assignment itself, and the trailing prose
   carries no number. A number stated twice on one line is a number that can
   disagree with itself, which is how this bug was born.

```
# --- LIMIT OVERRIDES (optional; every line below is COMMENTED OUT on purpose) ---
# An unset, blank or non-numeric TRADING_* var falls back to the value shipped in
# DEFAULT_LIMITS (agent/lib/risk.ts), which is the gate as tuned in #76. Leaving these
# commented is therefore the correct configuration for any deployment that has not
# deliberately chosen to differ. They are shown, rather than omitted, so an operator can
# see what is tunable and what the live setting is.
#
# The danger this guards against: an earlier version of this file shipped these as LIVE
# assignments holding the PRE-#76 values (2% trade floor, 10 concurrent positions). Copying
# it, as the README tells you to, silently restored the five-pound-probe sizing that #76
# existed to eliminate, on an account trading real money. Uncomment a line only when you
# mean to override that deployment's risk gate.
#
# The values below ARE the shipped defaults. agent/lib/env-example.test.ts fails the build
# if they ever drift from DEFAULT_LIMITS again.
# TRADING_MAX_PER_NAME_PCT=0.3               # ceiling on any single name, as a fraction of equity
# TRADING_MAX_DEPLOYED_PCT=0.9               # how much of the account may be invested; the rest stays as cash for FX and fees
# TRADING_MAX_NEW_POSITIONS_PER_DAY=4        # new positions that may be opened in one day
# TRADING_MIN_TRADE_PCT=0.15                 # floor per trade; a smaller order is REJECTED, not placed
# TRADING_MAX_TRADE_PCT=0.3                  # ceiling per trade
# TRADING_DAILY_LOSS_HALT_PCT=0.06           # daily loss circuit breaker; resumes on its own the next day
# TRADING_MAX_CONCURRENT_POSITIONS=4         # open positions at once
# TRADING_MIN_PRICE=5                        # minimum share price, USD
# TRADING_MAX_DRAWDOWN_PCT=0.15              # drawdown circuit breaker; requires a manual resume
# TRADING_MAX_CONSECUTIVE_LOSS_DAYS=2        # consecutive loss days before the breaker trips
# TRADING_LOSS_DAY_MIN_DROP_PCT=0.015        # min day-over-day drop counting as a "loss day"; smaller moves are noise. Default lives in agent/lib/state.ts, not DEFAULT_LIMITS
```

Leave `.env.example` lines 1-41 untouched, including the header comment at line
6 that already points at `resolveLimits`.

**Verify**: `grep -nE '^TRADING_[A-Z_]+=' .env.example` → no output, exit status
1. And `grep -c '^# TRADING_' .env.example` → `11`.

### Step 2: Add the drift test

Create `agent/lib/env-example.test.ts`. It reads `.env.example` as text and
pins three separate facts. Each one is a different way this bug can come back,
so all three are needed:

1. **No live assignment.** No line matches `^TRADING_[A-Z_]+=`. This is the
   actual security property: copying the file cannot change the gate.
2. **Every documented value equals the shipped default.** Parse every
   `# TRADING_X=<number>` line, map it to its `DEFAULT_LIMITS` field, and assert
   equality. This is the drift guard.
3. **The map is complete in both directions.** Every key of `DEFAULT_LIMITS`
   appears in the map and in the file, and every `TRADING_*` name in the file is
   one `agent/lib/state.ts` actually reads. Without this, adding an eleventh
   limit and forgetting to document it would pass silently, and so would a
   typo'd variable name that `resolveLimits` never looks at.

Target shape. Match the surrounding test style; `import test from "node:test"`
and `import assert from "node:assert/strict"`.

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_LIMITS, type RiskLimits } from "./risk.ts";
import { DEFAULT_LOSS_DAY_MIN_DROP_PCT } from "./state.ts";

/**
 * .env.example is the file README.md tells a new operator to copy. It therefore configures
 * real deployments, and for a while it shipped LIVE assignments holding the pre-#76 risk
 * limits: a 2% trade floor and 10 concurrent positions on an account that had just been
 * retuned to 15% and 4. Following the documented setup restored the exact probe sizing #76
 * deleted. These tests make that impossible to reintroduce quietly.
 */

const ENV_EXAMPLE = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");

/** env var name -> the DEFAULT_LIMITS field resolveLimits() overlays it onto. */
const LIMIT_KEYS: Record<string, keyof RiskLimits> = {
  TRADING_MAX_PER_NAME_PCT: "maxPerNamePct",
  TRADING_MAX_DEPLOYED_PCT: "maxDeployedPct",
  TRADING_MAX_NEW_POSITIONS_PER_DAY: "maxNewPositionsPerDay",
  TRADING_MIN_TRADE_PCT: "minTradePct",
  TRADING_MAX_TRADE_PCT: "maxTradePct",
  TRADING_DAILY_LOSS_HALT_PCT: "dailyLossHaltPct",
  TRADING_MAX_CONCURRENT_POSITIONS: "maxConcurrentPositions",
  TRADING_MIN_PRICE: "minPrice",
  TRADING_MAX_DRAWDOWN_PCT: "maxDrawdownPct",
  TRADING_MAX_CONSECUTIVE_LOSS_DAYS: "maxConsecutiveLossDays",
};

/** Every documented override, parsed off the commented-out lines. */
function documentedOverrides(): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of ENV_EXAMPLE.split("\n")) {
    const m = line.match(/^#\s*(TRADING_[A-Z0-9_]+)=([-0-9.]+)/);
    if (m) out.set(m[1]!, Number(m[2]));
  }
  return out;
}

test("no TRADING_* override is a live assignment in .env.example", () => { /* ... */ });

test("every documented TRADING_* value equals the shipped default", () => { /* ... */ });

test("the documented overrides cover DEFAULT_LIMITS exactly, and every name is one state.ts reads", () => { /* ... */ });
```

Fill in the three bodies:

- Test 1: assert `/^TRADING_[A-Z0-9_]+=/m.test(ENV_EXAMPLE)` is `false`, with a
  message naming the offending line.
- Test 2: for each `[envName, field]` of `LIMIT_KEYS`, assert
  `documentedOverrides().get(envName) === DEFAULT_LIMITS[field]`. Then assert
  the standalone one: `documentedOverrides().get("TRADING_LOSS_DAY_MIN_DROP_PCT")
  === DEFAULT_LOSS_DAY_MIN_DROP_PCT`.
- Test 3: three assertions.
  - The set of `LIMIT_KEYS` values equals `Object.keys(DEFAULT_LIMITS)` as sets,
    so a new limit cannot be added without documenting it.
  - Every key of `documentedOverrides()` is either in `LIMIT_KEYS` or is
    `TRADING_LOSS_DAY_MIN_DROP_PCT`.
  - Every key of `documentedOverrides()` appears literally in the text of
    `agent/lib/state.ts` (read it with `readFileSync(new URL("./state.ts",
    import.meta.url), "utf8")`), so a name nothing reads cannot be documented as
    though it worked.

Use exact numeric equality, not a tolerance. These are configuration literals
written by hand in two places; they are either the same characters or they are a
bug.

**Verify**: `node --test --experimental-strip-types agent/lib/env-example.test.ts`
→ 3 tests, all pass.

### Step 3: Confirm nothing else moved

**Verify**:

- `pnpm typecheck` → exit 0
- `npx tsc -p convex/tsconfig.json` → exit 0
- `pnpm test` → exit 0, `ℹ fail 0`, and 3 more tests than the plan-001 baseline

### Step 4: Mutation-check your own tests

This repo has shipped vacuous tests four times: a constant compared against
itself, a mutation that landed in the wrong function, and unit tests with no
wiring test. Prove each assertion bites. Two mutations, because tests 1 and 2
guard different failures and one mutation cannot exercise both.

**Mutation A, the drift guard.** In `.env.example`, change
`# TRADING_MIN_TRADE_PCT=0.15` to `# TRADING_MIN_TRADE_PCT=0.02` (the old
pre-#76 value).

1. **Confirm the mutation actually landed**:
   `grep -n 'TRADING_MIN_TRADE_PCT' .env.example` and read the line. Do not skip
   this. `cp` is aliased to `cp -i` in this environment and has silently refused
   to overwrite before, producing a false green off a change that never happened.
2. Run `node --test --experimental-strip-types agent/lib/env-example.test.ts`
   → test 2 must go RED, naming `minTradePct`.
3. Revert: set it back to `0.15`.
4. **Verify the revert**: `git diff .env.example` shows only your intended
   change, and the test file passes again.

**Mutation B, the security property.** Uncomment one line: turn
`# TRADING_MAX_CONCURRENT_POSITIONS=4` into `TRADING_MAX_CONCURRENT_POSITIONS=4`.

1. **Confirm it landed**: `grep -nE '^TRADING_' .env.example` prints exactly one
   line.
2. Run the test file → test 1 must go RED.
3. Revert and re-verify with `git diff .env.example` plus a passing run.

**Verify**: you observed test 2 go red under mutation A, test 1 go red under
mutation B, and both green after revert. If either mutation leaves the suite
green, the test is not testing what it claims and this is a STOP condition.

## Test plan

New file `agent/lib/env-example.test.ts`, 3 tests, structured after
`agent/lib/hold-floor.test.ts:81` (source-as-text structural assertion):

1. **No live `TRADING_*` assignment.** The security property: copying
   `.env.example` cannot move the risk gate.
2. **Documented values equal `DEFAULT_LIMITS`**, all ten, plus
   `TRADING_LOSS_DAY_MIN_DROP_PCT` against `DEFAULT_LOSS_DAY_MIN_DROP_PCT`.
   Would have caught all six of today's wrong values.
3. **Coverage in both directions.** No undocumented limit, no documented
   variable that `resolveLimits` never reads.

No behavioural tests are needed: this plan changes no code path. `resolveLimits`
already has coverage for the unset/blank/non-numeric fallback; do not duplicate
it.

Verification: `pnpm test` → all pass, 3 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0` and 3 more tests than the plan-001 baseline
- [ ] `grep -nE '^TRADING_[A-Z_]+=' .env.example` returns no output (exit 1)
- [ ] `grep -c '^# TRADING_' .env.example` returns `11`
- [ ] `grep -n 'maxConcurrentPositions: 4' agent/lib/risk.ts` still matches, and
      `git diff --stat agent/lib/risk.ts` is empty: the code did not change
- [ ] You observed both mutations turn the intended test red, and green after revert
- [ ] `git status --short` shows only `.env.example` and
      `agent/lib/env-example.test.ts`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 0 finds a `TRADING_*` variable actually set on Vercel production or in
  `.env.local`. That means a live deployment is running a gate that differs from
  the code, which is an operator decision, not an executor one.
- `.env.example` lines 42-53 do not match the "Current state" excerpt, or
  `DEFAULT_LIMITS` no longer holds the values in the table. The file drifted
  after this plan was written and the six-way comparison needs redoing.
- A test in step 4 stays green under its mutation.
- You conclude `agent/lib/risk.ts` or `agent/lib/state.ts` needs to change to
  make a test pass. Neither does. The documentation is wrong; the code is right.
- `git status` shows `.env.local` as modified. It is gitignored and must never
  be staged; if it appears, something staged it by wildcard and you should stop
  rather than commit a file full of live API credentials.

## Maintenance notes

For whoever owns this next:

- **`agent/instructions.md:8` still carries the stale number.** It reads "there
  is no minimum trade size beyond the gate's 2%-of-equity floor", which is the
  pre-#76 value reaching the model in prose. Line 14 of the same file states the
  post-#76 figures correctly ("each trade between 15% and 30% of equity"), so
  the prompt currently contradicts itself. Deliberately deferred: editing the
  agent's instructions changes what it decides, so it wants its own change and
  its own review, not a ride-along in a config fix. It has the same drift shape
  as this bug and the same fix shape is available: a test asserting the prompt's
  stated limits match `DEFAULT_LIMITS`.
- A reviewer should check exactly two things: that no `TRADING_*` line is live,
  and that `git diff` touches no file under `agent/lib/`. A diff that edits
  `risk.ts` has the fix backwards.
- When a future tuning commit changes `DEFAULT_LIMITS`, `agent/lib/env-example.test.ts`
  will fail immediately and name the field. That is the intended cost: update
  `.env.example` in the same commit. If the failure is ever silenced by editing
  the test's expected value rather than the file, the guard is gone.
- This plan and plan 008 both edit `.env.example`. If 008 has already landed,
  its change is at line 28 (`TIINGO_API_KEY`) and does not overlap the 42-53
  block; rebase and keep both.
