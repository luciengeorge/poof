# Plan 005: Never place an order twice, never lose one that filled

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- agent/lib/orders.ts agent/lib/orders.test.ts agent/tools/submit_orders.ts agent/tools/manage_positions.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (this is the order-placement path on a real-money account)
- **Depends on**: plans/001-reinstall-dependency-tree.md
- **Category**: bug
- **Planned at**: commit `0859c96`, 2026-09-30

This plan covers three defects in one file's order loop. They are bundled
because they edit the same lines and splitting them would only manufacture a
merge conflict and two reviews of the same code.

## Why this matters

poof places real orders against a real Trading 212 ISA. Three separate defects
on that path:

**(a) The duplicate guard is written after the thing it guards.** The order
intent marker exists, per its own doc comment, to protect "against duplicate
placement when a step re-runs after a market order has already filled and
vanished from pending". It is recorded *after* the broker call returns. So if
the Vercel function is killed between Trading 212 accepting the order and
Convex acknowledging the insert, a re-fire sees no pending order (a market
order fills and disappears) and no intent row, and places the trade again. On a
£250 account a duplicated 15-30% BUY is a 30-60% single-name position, well past
the `maxPerNamePct: 0.3` the gate enforces, because the gate already passed on
the first read.

**(b) A throw mid-batch discards orders that already filled.** The loop body has
unguarded awaits and the caller does not wrap the call, so if order N fills and
order N+1 throws, the whole tool throws and the bookkeeping block never runs.
The filled position gets no row in `trades`, `openBuys` never returns it, and
the exit engine never manages it. A real position, with real money, with no
stop-loss, no trailing stop and no time limit, permanently invisible.

**(c) The exit path has no duplicate guard at all.** `manage_positions.ts` calls
the same executor without passing `hasOrderIntent` or `recordOrderIntent`, and
the executor guards on `if (hasOrderIntent && ...)`, so it silently no-ops. A
retried or double-fired cycle can re-send a SELL.

## Current state

`agent/lib/orders.ts`, the tail of the per-order loop as of `0859c96`:

```ts
    const outcome = await placeWithPrecision(client, proposal.ticker, magnitude, sign);
    if ("skipped" in outcome) {
      result.placed.push({ proposal, quantity: 0, dryRun: false, skipped: outcome.skipped });
    } else {
      if (recordOrderIntent) await recordOrderIntent(intentKey);
      result.placed.push({
        proposal,
        quantity: outcome.quantity,
        dryRun: false,
        order: outcome.order,
      });
    }
  }

  return result;
}
```

`agent/tools/submit_orders.ts` around line 140, the unwrapped call:

```ts
    const result = await evaluateAndExecute(allowed, {
      client, fx, dryRun: isDryRun(), resolveRiskState,
      resolvePrice: async (ticker) => { ... },
      limits: resolveLimits(),
      hasOrderIntent: (key) => memory.hasOrderIntent(tradingEnv(), key),
      recordOrderIntent: async (key) => {
        await memory.recordOrderIntent(tradingEnv(), key);
      },
    });
```

and its bookkeeping, further down, which never runs if the above throws:

```ts
    // Record every placed/simulated trade to durable memory. Best-effort:
    // a memory failure must never break trading.
    try {
      const args = buildRecordTradeArgs(result.placed, tradingEnv());
      await Promise.all(args.map((a) => memory.recordTrade(a)));
    } catch (err) {
      console.warn("[memory] recordTrade failed (non-fatal):", err);
    }
```

Note the try/catch is in the wrong place: the hazard is not `recordTrade`
failing, it is never being reached.

`agent/tools/manage_positions.ts`, the exit-side call with no intent deps:

```ts
    const result =
      proposals.length > 0
        ? await evaluateAndExecute(proposals, {
            client,
            fx,
            dryRun,
            resolveRiskState,
            limits: resolveLimits(),
          })
        : { placed: [], rejected: [] };
```

Conventions: `agent/lib/orders.test.ts` is the exemplar. It builds a fake
Trading 212 client as a plain object and asserts on what the fake received.
Three existing tests there already cover intent-based duplicate suppression;
read them before writing new ones.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Order tests | `node --test --experimental-strip-types agent/lib/orders.test.ts` | all pass |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |

Note: the prefix is `ℹ` on Node 24, `#` on Node 22. Seeing `#` means the wrong
Node; plan 001 is a dependency for that reason.

## Scope

**In scope:**
- `agent/lib/orders.ts`, intent ordering, per-order error containment
- `agent/lib/orders.test.ts`, new tests
- `agent/tools/submit_orders.ts`, wrap the executor call
- `agent/tools/manage_positions.ts`, pass the intent deps
- A test file for the exit-path wiring (extend an existing one if a natural
  home exists)

**Out of scope** (do NOT touch, even though they look related):
- The risk gate in `agent/lib/risk.ts`. It is not implicated in any of these.
- The intent **key format**. See the warning in step 4: the key is built from
  date, ticker, side and notional, and an exit notional varies with the live
  price, so a naive reuse may never dedupe. Investigate and report; do not
  redesign the key scheme in this plan.
- `agent/lib/execution.ts` reconciliation.
- Retry or backoff behaviour in `placeWithPrecision`.

## Git workflow

- Branch: `advisor/005-order-integrity`
- Three commits, one per defect, so each can be reverted independently.
  Conventional commits, imperative subject, body explaining the failure mode.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Record the intent before the order is sent

Move `recordOrderIntent(intentKey)` above the `placeWithPrecision` call.

Recording first can only ever over-block: an intent whose order then failed
blocks a legitimate retry for the rest of that ET day. That is the correct way
to fail on this path. Placing a duplicate 30% position is not.

Add a comment saying so, because the ordering looks arbitrary otherwise.

**Verify**: `node --test --experimental-strip-types agent/lib/orders.test.ts`
→ existing tests still pass.

### Step 2: Test that the intent precedes the order

Add a test asserting ordering, not just presence: with a fake client and a fake
`recordOrderIntent` that both append to one shared array, assert the intent
entry appears *before* the placement entry.

A test that merely asserts "the intent was recorded" passes against the old
code and proves nothing.

**Verify**: the new test passes now, and fails if you temporarily move the
recording back below the call.

### Step 3: Contain a throw to the order that caused it

Wrap the per-order body inside the loop so a throw records an error entry for
that proposal and stops the batch, returning the partial `ExecutionResult`
rather than propagating. Wrap the `recordOrderIntent` await in its own
try/catch: losing the marker is survivable, losing the trade record is not.

Then in `agent/tools/submit_orders.ts`, ensure that whatever
`evaluateAndExecute` returns, the `recordTrade` bookkeeping still runs. The
cleanest shape is for the executor not to throw at all.

The invariant to hold: **anything the broker accepted must reach `recordTrade`.**

**Verify**: add and run a test where the fake client succeeds on the first
order and throws on the second, then assert the returned result still contains
the first placement. `pnpm test` → all pass.

### Step 4: Give the exit path a duplicate guard

Pass `hasOrderIntent` and `recordOrderIntent` into the `evaluateAndExecute`
call in `agent/tools/manage_positions.ts`, matching how
`agent/tools/submit_orders.ts` supplies them.

**Investigate before you wire it.** Read how `intentKey` is constructed in
`agent/lib/orders.ts`. If it includes the notional, an exit notional derived
from the live market value will differ between two runs on the same day, so the
key would never match and the guard would be decorative. If that is what you
find, **STOP and report** with the key format and your reasoning rather than
inventing a new key scheme. A guard that cannot fire is worse than none,
because it reads as protection.

**Verify**: a structural test asserting `manage_positions.ts` passes both
callbacks, modelled on `agent/lib/hold-floor.test.ts:83-95`, whose comment
records that mutation testing showed unit tests stay green when the wiring is
missing. Plus a behavioural test that a second identical exit is suppressed.

### Step 5: Mutation-check all three

For each of the three changes: back it out, **confirm the mutation actually
landed** with `grep` before trusting the result (`cp` is aliased to `cp -i`
here and has silently refused to overwrite, producing a false green), run the
tests, confirm RED, restore with `/bin/cp -f`, confirm `git diff` shows only
intended changes, and confirm the suite passes again.

**Verify**: you observed three separate reds and a clean restore.

## Test plan

New tests in `agent/lib/orders.test.ts`, modelled on the existing fake-client
tests there:

1. Intent is recorded **before** the broker call (ordering, not presence).
2. An intent recorded for a failed placement still blocks a same-day retry, and
   this is the documented, accepted trade-off.
3. First order succeeds, second throws: the result still reports the first
   placement.
4. A throw in `recordOrderIntent` does not lose an order the broker accepted.
5. Structural: `manage_positions.ts` passes both intent callbacks.
6. Behavioural: a repeated exit for the same position is suppressed, **only if
   step 4's investigation showed the key can actually match.**

Verification: `pnpm test` → all pass.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0`
- [ ] In `agent/lib/orders.ts`, `recordOrderIntent` appears **before**
      `placeWithPrecision` in the loop body
- [ ] A test fails if that ordering is reversed
- [ ] `grep -n "hasOrderIntent" agent/tools/manage_positions.ts` matches
- [ ] A test fails if the intent callbacks are removed from `manage_positions.ts`
- [ ] A fake client that throws on the second order still yields the first
      placement in the result
- [ ] `git status` shows only the four in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any "Current state" excerpt does not match the live code.
- Step 4's investigation shows the intent key cannot match across two exit runs
  for the same position. Report the key format; do not redesign it here.
- Containing the throw changes what `submit_orders` returns to the model in a
  way that would need the tool's description or `agent/instructions.md`
  updated. Flag it rather than editing the prompt.
- You find another caller of `evaluateAndExecute` beyond these two.
- Any test you add passes before the corresponding fix.

## Maintenance notes

- **This is the money path.** A reviewer should read the loop body in full and
  satisfy themselves of one invariant: anything the broker accepted reaches
  `recordTrade`. Everything else here is secondary.
- Recording the intent first makes a same-day retry after a *failed* placement
  impossible. That is deliberate. If it proves annoying in practice, the answer
  is an explicit intent-clearing path, not moving the write back after the send.
- Deliberately deferred: the intent key format. If step 4 shows it cannot serve
  exits, that is a real follow-up and should be filed rather than improvised.
- Related and separate: `agent/lib/positions.ts` `orphanedOpenBuys` has no
  guard against an empty portfolio read and can force-close the whole open book
  (plan 007). It interacts with this path, since a lost trade row and a
  force-closed trade row look similar afterwards, but they are distinct bugs.
