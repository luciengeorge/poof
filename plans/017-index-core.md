# Plan 017: Hold the index with every pound not in a stock

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. The reviewer maintains `plans/README.md`; do not
> edit it.
>
> **Drift check (run first)**: `git diff --stat e921a44..HEAD -- agent/lib/risk.ts agent/lib/execution.ts agent/lib/orders.ts agent/lib/positions.ts agent/lib/benchmark.ts agent/tools/submit_orders.ts agent/tools/manage_positions.ts agent/tools/review_performance.ts convex/schema.ts convex/memory.ts`
> Plan 002 may have landed and touched `agent/lib/exits.ts`; that is expected and
> out of scope here. For any file listed above that changed, compare the
> "Current state" excerpts against live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH (order placement on a real-money account)
- **Depends on**: plans/001 (DONE). Must ship in the SAME release as plan 018.
- **Category**: bug (a measured, unintended bet against the benchmark)
- **Planned at**: commit `e921a44`, 2026-09-30

## Why this matters

poof trades a real Trading 212 Stocks ISA and is benchmarked against the S&P
500. Measured on the live record, 15 Jul to 29 Sep 2026: the account held on
average **64% cash** while the S&P 500 rose **3.61% in GBP**. That idle cash
alone cost **-2.17 percentage points** of a -4.16pp shortfall. It was not a
deliberate bearish call; the agent simply could not find enough to buy.

A separate measurement found poof's stock picks have **no detectable edge over
the index** (53 trades, excess +0.28% gross, t = 0.37, -0.02% after the 0.3%
FX round trip). Published evidence points the same way: roughly nine in ten US
large-cap funds trail the S&P 500 over 15 years (S&P SPIVA scorecards).

So idle capital should sit in the index, not in cash. The owner decided on
2026-09-30: **an index core holding every pound not in a stock, with stock
picking kept but optional.** The stock sleeve keeps every existing limit.

## Verified constraints (checked by the reviewer, 2026-09-30)

Treat these as facts. Each was tested, not assumed.

1. **The instrument** is `VUAGl_EQ`: Vanguard S&P 500 (Acc), ISIN
   IE00BFMXXD54, `currencyCode: "GBP"`, `workingScheduleId: 70` (LSE),
   `extendedHours: false`. It is on the live account's instrument list. GBP-quoted
   means no Trading 212 FX fee. Accumulating means dividends are reinvested, so
   it is a total-return holding. Unhedged, so it tracks the S&P 500 in GBP.
2. **Trading 212 orders are quantity-only.** `placeMarketOrder({ticker,
   quantity})` and `placeLimitOrder` in `agent/lib/t212.ts`. There is no order-
   by-cash-amount endpoint and no quote endpoint.
3. **No external source prices VUAG.** Finnhub `VUAG.L` returns HTTP 403 on this
   account's tier; `VUAG.LON` and `VUAG` return zeros. Tiingo returns "Ticker
   not found". **The only price is Trading 212's own `currentPrice` on a held
   position** (`T212Position.currentPrice`, GBP), which is also the venue that
   fills the order. Consequence: poof must hold a small amount of VUAG before it
   can size a VUAG order, and must **never sell the core to zero**.
4. **London closes before the cycle in summer.** LSE trades 08:00-16:30 UK
   time. Under BST that is 07:00-15:30 UTC. The daily cycle fires around
   15:35-15:45 UTC. So in summer a VUAG order queues until the next London open;
   in winter (GMT, LSE until 16:30 UTC) it fills the same day.
5. **Every holding is currently valued with the USD to GBP rate.** In
   `agent/lib/execution.ts` `buildRiskSnapshot`:
   `value: p.quantity * p.currentPrice * fx.rate`. The same assumption is in
   `deployedValueGbp` and in the reconciliation's computed total. A GBP holding
   priced this way reads about 25% low (fx near 0.755).
6. **Same-batch sale proceeds cannot fund a buy.** `validateOrders` in
   `agent/lib/risk.ts`: "Sell proceeds are unsettled on a T212 cash ISA, so they
   must not fund a same-batch BUY." So funding a stock buy by selling VUAG takes
   two cycles. The owner accepted a one-cycle lag.
7. **`t212TickerToFinnhubSymbol` returns null for anything not ending
   `_US_EQ`**, so the existing BUY path rejects VUAG before sizing it.

## Current state

`agent/lib/execution.ts`, `buildRiskSnapshot` (the valuation to change):

```ts
  const riskPositions: Position[] = positions.map((p) => ({
    ticker: p.ticker,
    value: p.quantity * p.currentPrice * fx.rate,
  }));
```

`agent/lib/risk.ts`, `evaluateBuy` (the limits that must see stocks only):

```ts
  const minTrade = limits.minTradePct * p.equity;
  const maxTrade = limits.maxTradePct * p.equity;
  if (order.notional < minTrade || order.notional > maxTrade) { ... }
  if (order.notional > running.cash) { return `insufficient cash ...` }
  const currentName = running.valueByTicker.get(order.ticker) ?? 0;
  if (currentName + order.notional > limits.maxPerNamePct * p.equity) { ... }
  const resultingCash = running.cash - order.notional;
  const minCash = (1 - limits.maxDeployedPct) * p.equity;
  if (resultingCash < minCash) { return `would breach cash floor ...` }
  ...
    if (running.distinctPositions >= limits.maxConcurrentPositions) { ... }
```

and in `validateOrders`, `distinctPositions: p.positions.length` counts every
holding, so VUAG would occupy one of the four stock slots.

`agent/tools/manage_positions.ts` feeds positions to `checkExits`
(`agent/lib/exits.ts`) and reconciles with `orphanedOpenBuys`
(`agent/lib/positions.ts`). Unexempted, the 20-day max-hold would sell the index
every month and the 10% stop-loss would sell it in every correction.

Conventions: pure, unit-tested functions with IO at the edges. `agent/lib/
orders.test.ts` shows how this repo fakes the Trading 212 client as a plain
object and asserts on what it received; follow it. Comments explain *why* at
length and are not on every line. No em-dashes. No TypeScript parameter
properties (`--experimental-strip-types` cannot erase them).

## Design (owner-approved decisions marked [OWNER])

- **Core ticker** `VUAGl_EQ`, quote currency GBP. Hard-code it as a single named
  constant. Do **not** generalise currency handling to arbitrary LSE
  instruments; many quote in GBX (pence) and that is a trap for a later change.
- **Cash buffer**: keep about **3% of equity** in cash (FX fees on stock buys,
  rounding, price drift between sizing and fill).
- **Sweep**: at the end of a cycle, buy VUAG with free cash above the buffer, if
  the excess is at least a minimum order value (about £2), no VUAG order is
  already pending, and the cycle did not just raise cash for a stock buy.
- **Funding a stock buy [OWNER: one-cycle lag]**: when a stock BUY is rejected
  for insufficient cash, sell enough VUAG to cover the shortfall plus the
  buffer, report it, and do not retry the stock in the same batch. Next cycle the
  agent re-evaluates with the cash available. If it no longer wants the stock,
  the following sweep returns the cash to VUAG.
- **Never sell the core to zero.** Keep a floor (for example 0.05 shares) so
  Trading 212 keeps returning its price.
- **Halts [OWNER]**: halts continue to block stock BUYs, exactly as today. The
  core path does not go through `validateOrders`, so halts never stop the sweep
  and never sell the core.
- **Exits [OWNER: existing positions run normally]**: the core is excluded from
  `checkExits` and from orphan reconciliation. Stocks are unchanged.
- **Stock limits see stocks only**: for the stock sleeve, per-name cap,
  concurrent-position count, trade band, and the deployed-cash floor are
  computed over stock holdings only. Equity is still the broker's total, which
  includes VUAG. The cash floor becomes "stock sleeve at most `maxDeployedPct`
  of equity"; VUAG is the remainder, not cash.
- **Core orders are not trades.** Do **not** write VUAG orders to the `trades`
  table. That table feeds the selection-skill statistics (win rate, per-tag
  stats, calibration, attribution); index rebalances would contaminate the
  measurement of whether stock picking works. Record core activity in the cycle
  trace or a small dedicated audit table instead.
- **Benchmark [OWNER: VUAG]**: measure the account against VUAG itself. It is the
  exact counterfactual ("did poof beat just holding the index, in pounds?"), it
  is total return, and it needs no FX conversion.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Node | `source ~/.nvm/nvm.sh >/dev/null 2>&1 && nvm use >/dev/null 2>&1` | v24.x |
| Typecheck | `pnpm typecheck` | exit 0 |
| Convex typecheck | `npx tsc -p convex/tsconfig.json` | exit 0 |
| Tests | `pnpm test` | exit 0, `ℹ fail 0` |
| Build | `pnpm build` | exit 0 |

Baseline: 633 tests (639 if plan 002 has landed). Use `ℹ` (Node 24) when reading
counts; `#` means the wrong Node.

**Do NOT run `npx convex deploy` in any form.** It always targets production.
The reviewer runs `npx convex deploy --dry-run -y` during review: it validates
the schema against the real, populated production tables and writes nothing.
Your job is to make every new field on an existing table `v.optional`, because
`tsc` cannot catch a required field added to a populated table and a violation
fails the production deploy outright.

## Scope

**In scope:**
- `agent/lib/core.ts` (create): constants and pure helpers
- `agent/lib/core.test.ts` (create)
- `agent/lib/execution.ts`: per-holding valuation
- `agent/lib/risk.ts`: stock limits over stock holdings only
- `agent/lib/orders.ts` and/or a new core execution function: the core path
- `agent/tools/submit_orders.ts`: funding on insufficient cash; do not record core orders as trades
- `agent/tools/manage_positions.ts` and `agent/lib/positions.ts`: exclude the core from exits and orphans
- the end-of-cycle sweep: wire it where the cycle's orders complete; find the right place (`submit_orders`, or the `record_cycle` tool, whichever runs last and has the broker client) and justify the choice in a comment
- `agent/lib/benchmark.ts`, `agent/tools/review_performance.ts`, `convex/schema.ts`, `convex/memory.ts`, `agent/lib/memory.ts`: VUAG benchmark
- tests for each of the above

**Out of scope** (do NOT touch):
- `agent/instructions.md` and any prompt. That is plan 018 and ships in the same release, reviewed separately.
- `agent/lib/exits.ts` internals (plan 002).
- The numeric values in `DEFAULT_LIMITS` for the stock sleeve.
- Halt thresholds and halt logic in `checkHalt`.
- **Placing any real order, or running anything against production.** The reviewer bootstraps VUAG and rebases the benchmark after merge.

## Git workflow

- Branch: `feat/index-core` off `main` (after plan 002 merges; the reviewer will tell you the base).
- One commit per step below, conventional commits, ending with the two attribution lines you are given.
- Stage explicit paths only. Do NOT push or open a PR.

## Steps

### Step 1: Pure core helpers, tests first

Create `agent/lib/core.ts` with the core ticker, quote currency, buffer
fraction, minimum order value, floor quantity, and pure functions:

- `fxForHolding(ticker, usdGbpRate)`: `1` for the core, `usdGbpRate` otherwise.
- `sweepQuantity({freeCash, equity, corePrice, precision, reservedForStocks})`:
  quantity of VUAG to buy with cash above the buffer, sized with a small safety
  margin below the price so a fill a touch higher still clears; `0` if the excess
  is under the minimum order value.
- `fundingSale({shortfall, equity, coreQuantity, corePrice, precision})`:
  quantity of VUAG to sell to cover a shortfall plus the buffer, capped so the
  core never falls below the floor quantity.
- `isCore(ticker)`.

Unit-test each, including: zero and negative excess, excess just under the
minimum, a shortfall larger than the whole core (capped at floor), and the
floor holding exactly.

**Verify**: `node --test --experimental-strip-types agent/lib/core.test.ts` passes.

### Step 2: Value each holding in its own currency

Use `fxForHolding` in `buildRiskSnapshot`, `deployedValueGbp`, and the
reconciliation's computed total in `agent/lib/execution.ts`.

Test: a snapshot holding a USD stock and VUAG values the stock at
`qty * price * fx` and VUAG at `qty * price`, and the reconciliation's computed
total matches a broker total built the same way (no false divergence).

**Verify**: `pnpm test` all pass.

### Step 3: Stock limits over stocks only

In `agent/lib/risk.ts`, compute the per-name cap, concurrent-position count,
trade band, and deployed-cash floor over **stock** holdings only, leaving equity
as the broker total. The cash floor becomes: stock-sleeve value after the buy
must not exceed `maxDeployedPct * equity`.

Tests: with 90% of equity in VUAG and 3% cash, a valid 15% stock buy is rejected
only for insufficient cash (not for the cash floor, and not for the position
count); with three stock positions plus VUAG, a fourth stock is allowed and a
fifth is not.

**Verify**: `pnpm test` all pass; every existing risk test still passes.

### Step 4: Exempt the core from exits and orphan reconciliation

In `agent/tools/manage_positions.ts` (or the helper it uses), filter the core
out before `checkExits` and before `orphanedOpenBuys`.

Tests: a behavioural test that a VUAG position down 15% and held 60 days
produces no exit signal; and a **structural** test, modelled on
`agent/lib/hold-floor.test.ts:83-95`, that `manage_positions.ts` filters the
core before calling `checkExits`. A unit test on the helper alone does not prove
the tool calls it; this repo has shipped that gap four times.

**Verify**: `pnpm test` all pass.

### Step 5: The core execution path

Implement sweep, funding sale, and bootstrap, reading VUAG's price from the
broker's positions (constraint 3) and sizing with `fxForHolding` (rate 1).

- **Pending dedupe**: skip if a VUAG order is already pending
  (`getPendingOrders`). In summer a VUAG order placed at the cycle is still
  pending the next morning; the next cycle must not stack another.
- **Bootstrap**: if VUAG is not held and not pending, the path must NOT guess a
  price. Return a clear "core not bootstrapped" status and do nothing. The
  reviewer performs the bootstrap after merge with `scripts/bootstrap-core.ts`.
  Do not implement an automatic fixed-quantity blind order.
- **Funding**: in `submit_orders`, after validation, for BUYs rejected with
  `insufficient cash`, sum the shortfall, call the funding sale once, and add a
  clear note to the tool result ("raised £X from the index core; the stock can be
  bought next cycle"). Do not retry the stock in this batch.
- **Sweep**: at the end of the cycle, sweep excess cash into VUAG, unless the
  cycle raised funds.
- **Not trades**: core orders must not reach `buildRecordTradeArgs` or
  `memory.recordTrade`. Record them in the cycle trace or a dedicated table.
- **Dry run**: honour `isDryRun()` exactly as stock orders do.

Tests with a fake client (pattern: `agent/lib/orders.test.ts`): sweep sizes from
the broker's VUAG price with rate 1; no second sweep while one is pending; a
cycle that raised funds does not sweep; funding never sells below the floor; no
core order appears in the recorded trades; a halt does not stop the sweep; not
held and not pending returns "not bootstrapped" and places nothing.

**Verify**: `pnpm test` all pass.

### Step 6: Benchmark against VUAG

Add an optional `benchmarkTicker` to the `benchmark` table (`v.optional`; the
table is populated). When it is `VUAGl_EQ`, the stored inception price is VUAG's
GBP price, the inception FX rate is `1`, and `review_performance` passes VUAG's
current price (from the broker's positions) and a current rate of `1`, so
`computeAlpha` reports a `"GBP"` basis with no conversion. When absent, behaviour
is exactly as today (legacy SPY). Extend `scripts/rebase-benchmark.ts` with an
optional `--benchmark-ticker` so the reviewer can switch it.

**Verify**: `pnpm test` all pass; `npx tsc -p convex/tsconfig.json` exit 0;
`grep -n "benchmarkTicker" convex/schema.ts` shows it wrapped in `v.optional`.

### Step 7: Mutation-check the money invariants

For each: back up, mutate, **confirm with grep that the mutation landed on the
intended line** (two lines can share an expression; `perl` without `/g` takes the
first), run tests, confirm RED, restore with `/bin/cp -f`, confirm `git diff`
clean of the mutation, confirm green. Never chain `grep -c` into `&&`.

- M1: value VUAG with the USD rate again → the step-2 test goes red.
- M2: count VUAG in `distinctPositions` → the step-3 slot test goes red.
- M3: drop the core filter before `checkExits` → the step-4 structural and behavioural tests go red.
- M4: record a core order as a trade → the "not trades" test goes red.
- M5: remove the pending-order check → the no-double-sweep test goes red.
- M6: let funding sell below the floor → the floor test goes red.

## Test plan

Summarised from the steps: `core.test.ts` for the pure helpers; valuation and
reconciliation; stock limits with a large core; core exempt from exits
(behavioural plus structural); the execution path with a fake client covering
sweep, dedupe, funding, floor, halts, not-trades, and not-bootstrapped; the
benchmark with and without `benchmarkTicker`.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck`, `npx tsc -p convex/tsconfig.json`, `pnpm build` exit 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0`
- [ ] Every new field on an existing Convex table is `v.optional` (reviewer runs the prod dry run)
- [ ] Mutations M1 to M6 each observed red after confirming they landed
- [ ] `grep -rn "VUAGl_EQ" agent/` shows the constant defined once and referenced by name elsewhere
- [ ] No core order can reach `memory.recordTrade` (test proves it)
- [ ] No file under `agent/instructions.md` or `plans/` modified
- [ ] No real order placed and nothing run against production
- [ ] Commits on `feat/index-core`, not pushed

## STOP conditions

Stop and report back (do not improvise) if:

- Any constraint in "Verified constraints" turns out false in the code.
- Supporting the core requires changing a stock-sleeve limit value, or halt logic.
- The sweep has no place in the cycle that both runs last and has the broker client.
- A schema change cannot be made `v.optional`.
- You find yourself implementing a blind fixed-quantity bootstrap order.
- A mutation does not turn its test red after you confirmed it landed.

## Maintenance notes

- **Rollout, by the reviewer, after merge, in order**: (1) deploy; the core
  path stays inert until VUAG is held; (2) run
  `scripts/bootstrap-core.ts --env live --apply`, which checks the GBP quote and
  buys the 0.05-share floor, and confirm the fractional quantity was accepted; (3)
  read the contract note and confirm there is **no FX fee** on a GBP instrument;
  (4) run `sweepCore` locally with `dryRun: true` against the live broker to
  confirm sizing; (5) rebase the benchmark to VUAG at that day's equity and VUAG
  price; the next cycle performs the first real sweep. Do not run a production
  `DRY_RUN` cycle: it simulates exits too, suspending real stop-losses on open
  positions.
- **Beta goes to about 1.** The account will now follow the market down as well
  as up. That is the owner's intended trade, not a regression.
- **Halts will fire on market moves.** The drawdown and consecutive-loss halts
  measure total equity, now mostly index. They block stock buys only, so the core
  keeps working, but the consecutive-loss halt requires a manual resume and may
  trip about once a year. Worth rebasing halts on stock-sleeve P&L later; not here.
- **Summer orders fill next morning.** A VUAG trade placed at the 15:35 UTC cycle
  fills at the next London open, possibly after an overnight gap. Harmless for a
  passive holding; the pending check prevents stacking.
- Plan 018 (the prompt) must ship with this. Removing forced trading **without**
  a core would raise cash drag, not lower it.
