# Plan 021: execution contract for later D–F

A–C introduced observation only. D is being implemented behind a disabled switch; no extra live trading cadence is active.

One account owner must cover every physical broker caller: stock/core orders, mechanical
exits, scheduled/manual cycles, catch-up, reconciliation and future second reviews. Acquiring
a logical lease does not stop an old process from sending. D must fence physical sends or
prove all previous sends/retries are quiescent before transferring ownership.

Each logical operation persists a generation-aware intent and transitions through
`reserved -> sending -> acknowledged -> reconciling -> reconciled`. Timeout/ambiguous
response after sending goes to `unknown`, retains account ownership, blocks new dispatch,
and permits reconciliation reads only. A process restart or expired lease never authorizes
a repeated order POST. Verify broker order/fill state; never retry an ambiguous POST based
only on elapsed time, a failed wrapper result or an empty response.

Use one atomic ET-day entry reservation across all sessions. Reserve before send; persist
acknowledgements and reject duplicate reservations. Release only when rejection/non-send is
proved. Unknown sends retain their reservation. Prove four entries across two sessions cannot
become eight, including crashes before/after send and concurrent manual callers.

Position identity includes confirmed broker quantity and generation, with explicit pending
orders. A SELL acknowledgement does not prove flat: partial fills retain the residual,
update only reconciled quantities and P&L, and preserve the generation until closure.
Re-entry creates a new generation. Do not reuse ticker/day-only exit keys. Do not close all
BUY history merely because a single SELL was accepted.

The serving SELL path sends before intent bookkeeping and permits exits when bookkeeping
fails. **Explicit user decision, 17 Nov 2026:** in the new execution mode, unverifiable
account ownership blocks ALL automatic orders, including SELLs. Manual exits in the broker
remain available. The disabled mode must test this policy for every physical send. Existing
serving behavior remains until the new mode passes D acceptance and is deliberately activated.

VUAG funding and sweeps require a separate London-session resolver with UK holidays, early
closes and US/UK DST mismatch weeks. An afternoon US review cannot sell/fund/sweep the core
outside its valid session. Replace ET-day-only core suppression with explicit reconciled
operation identity; do not weaken duplicate protection to obtain another sweep.

Drain stops new owners and physical sends, waits for active retry/send quiescence, and
reconciles unknown outcomes before deployment/owner transfer. A deployment cannot fence an
old worker. If quiescence cannot be proved, keep the serving execution mode and use the
existing recovery procedure. `DRY_RUN` remains the global order stop.

D acceptance must cover stale owners, overlap, pending/partial/unknown outcomes, crashes,
re-entry, daily cap, observer isolation and rejection of off-session core operations. E is
optional mechanical exits after D plus qualified snapshot evidence. F is optional 10:00/14:00
ET reviews after D, with at most two scheduled starts and slot-aware catch-up/watchdog.
First measure incremental afternoon decisions with read-only capabilities. Both require a
separate reviewed change, activation decision and rollback drill; no forecast gains authority
to sell VUAG, open shorts or change risk limits.


## D implementation stages (17 Nov 2026)

The first disabled admission slice is deliberately **not activation-ready**. It installs
one account/environment fence at the Trading 212 physical request boundary, persists
`sending` before fetch, renews admission on each GET retry, and never retries an ambiguous
POST (including 429 or an unreadable body). Only a definitive validation rejection permits
one smaller precision retry. `DRY_RUN` also blocks direct physical writes in this mode.
Concurrent snapshot GETs are allowed for one owner; writes require no active reads or write.
Expired leases and process restarts never clear write I/O. A GET with lost settlement
can expire with its lease because it has no order side effect: mark it read-abandoned,
bump ownership generation and reject any late result or settlement. Drain can perform
the same read recovery, while any active write remains fenced. Immediately before fetch,
recheck expiry, cancellation and market hours after any admission delay; proven non-sends
release their reservation. Drain blocks new admission and
only reports quiescence after settled requests; it cannot stop legacy workers.

The atomic ET-day reservation includes serving-mode stock BUYs before the new mode's
first reservation. This first disabled slice deliberately counts **all stock BUYs, including
top-ups**, which is stricter than risk.ts's new-position count. It is not a completed
implementation of that risk rule. Admission uses the application's resolved
`maxNewPositionsPerDay` from `TRADING_MAX_NEW_POSITIONS_PER_DAY` (default four), accepts
only integer limits zero through four, and freezes the limit with the first reservation.
A larger limit or a different limit mid-day fails closed with an explicit configuration
error. Reconciliation must supply confirmed holdings/generations before a later reviewed
slice can exempt top-ups and claim parity with the new-position risk rule. Unknown/pending/filled acknowledgements all retain both account fence
and reservation. Even a complete FILLED response is not returned into legacy bookkeeping:
it proves neither flat position quantity nor reconciled P&L. The first slice intentionally
has **no automatic fence-clear/reconciliation API**. Manual broker exits remain available.
It is for disabled implementation/testing, not an operational rollout.

Before enabling: implement exclusive reconciliation reads and matching order/fill proof,
partial/residual position generations and idempotent bookkeeping; handle same-day re-entry
without ticker/day-only exit keys; verify stable broker account identity; prove serving
workers are drained across deploys, exercise recovery and rollback, then review/activate
separately. Never infer non-placement from an empty portfolio/history page or elapsed time.
No additional live cadence or scheduled review is introduced by this first slice.


## D read-only reconciliation stage

The next disabled stage grants a separate `reconcile/…` owner GET access while retaining
exactly the original unresolved write and daily reservation. It requires a known broker
order ID in pending/filled/unknown state; a sending POST or an unknown result without an
ID requires manual audit and never becomes retryable on elapsed time. The prior lease
must expire before the read owner can claim. Reconciliation is allowed while writes are
drained, but only pending orders, ticker-filtered history and portfolio GETs are admitted.
Every physical GET/retry consumes one of eight durable read admissions; one read at a time,
15-second timeout, at most three history pages of 50 items. Provider URLs are never followed;
only a validated numeric cursor is used to construct a backend-approved path. Expired
reconciliation GETs can be abandoned with generation fencing; late results cannot settle.

Normalized receipts record order classification, observed residual quantity, coverage and
counts only. Match the acknowledged ID, ticker, side, requested/filled quantity and creation
time (at most ten seconds before local sending time to tolerate bounded clock skew). A
filled SELL is still distinct from a flat, closed position generation. Empty history,
missing pagination metadata or an absent portfolio ticker cannot prove non-placement.
Do not derive P&L from these receipts or release any fence from them: `canClearFence=false`
always, including after FILLED, zero-fill rejection and a flat portfolio. No raw broker
payload, credential, chat or trading-memory row is stored by this stage.

`scripts/reconcile-execution.ts` is an explicit operator entry point, not an agent tool or
schedule. It refuses to run without the enabled execution mode and explicit verified account
configuration. **Do not turn the mode on just to run it.** This implementation is tested with
injected transports and convex-test only; no actual broker calls or production reconciliation
runs are part of validation. Generation-aware holdings and idempotent fill/P&L bookkeeping,
then a reviewed fence-clear/recovery protocol and activation/rollback proof remain pending.


Operator command outcomes: `not-needed` exits0 when the authenticated backend reports no
fenced order; `manual-audit-required` exits2; `broker-read-failed` and unexpected failures
exit1; disabled/incomplete configuration exits2. Expected backend outcomes use structured
codes, and CLI text is fixed rather than copied from exception payloads. Unknown errors
remain generic; no stack, provider body, credential, account or broker payload is printed.
These diagnostics never change fence state or authorize retries.


## D isolated position-generation ledger

The disabled inventory stage adopts a fresh baseline only under the current account owner,
with no active I/O, no unresolved order and a verified zero pending-order count. It never
infers a baseline from a post-order portfolio. Baseline origin and observation time are
recorded without inventing the original entry date; later baseline refreshes must match
existing quantities exactly and compare an already confirmed broker basis against later
broker observations. The fill-derived average is retained separately: after a BUY, the
first quantity-matching refresh establishes a new broker basis without comparing broker
rounding/fees with our weighted fill calculation. Later broker-basis changes require audit;
refresh never overwrites the computed basis or infers a manual change/corporate-action repair.

For an acknowledged order, the read-only collector can seal normalized GBP-wallet fills
inside its immutable reconciliation receipt. Bookkeeping accepts only the receipt ID,
never a separately supplied fill set; older count-only receipts cannot be booked. Apply
only a fresh, complete receipt from the current ownership generation. Fill IDs are unique
per environment/account; conflicting or missing earlier fills fail closed. Replay is
idempotent across receipts. Signed quantity changes must match the broker-observed residual,
otherwise nothing commits. Top-ups preserve the generation and weighted native share-price
basis. Partial exits preserve the residual and generation; only an exactly zero observed
broker quantity closes it. Re-entry creates a new generation even within the same ET day.

Realized P&L records the broker-reported GBP amount per SELL fill once; it is not estimated
from native price differences or a guessed FX rate. These fields do not claim a fee-inclusive
net return. BUY fills cannot claim realized profit. Existing trade/cycle/risk/lesson history
is untouched. New tables remain isolated operational bookkeeping, not new model learning.

**The collector does not invoke this ledger, and live trading tools do not use it.** A
verified baseline producer, ledger orchestration, generation-aware exit intents/strategy bookkeeping,
reviewed fence clear/manual recovery, and activation/drain/account verification remain to
be integrated and tested. No current daily behavior changes. Neither a baseline nor a
bookkeeping receipt grants dispatch or releases an account fence/daily reservation; APIs
continue to report canDispatch/canClearFence=false. Do not enable the incomplete mode.


## D in-cycle order resolution (17 Nov 2026)

With the mode enabled, an order now completes end to end inside the cycle that sent it.
Before the first order of a tool call the transport verifies that the API key belongs to
`EXECUTION_ACCOUNT_ID` (`/equity/account/info`, GBP) and that the isolated ledger adopts, or
exactly confirms, the broker holdings with zero pending orders. Any failure blocks every
automatic order in that call, SELLs included; manual broker exits remain available.

After an acknowledged POST the sending owner hands its live lease to a fresh `reconcile/…`
owner (no expiry wait), the bounded GET plan seals evidence, the ledger books the sealed
fills, and `resolve` releases the fence. `resolve` requires a complete matched history, the
current generation, an unchanged fence and a booked receipt for that exact evidence. Only a
full fill or a zero-fill end is terminal: a full fill keeps its daily slot, a zero-fill end
releases it and surfaces to legacy code as a broker rejection (a skip). Pending, not yet
listed, or incomplete history is retried a few times six seconds apart; a partial fill,
mismatch or invalid response stays fenced for manual audit. A filled order returns to the
existing order bookkeeping unchanged.

A fence left by an earlier run is resolved before the next tool call touches the broker. If
it cannot be, that call fails: no reads, no orders. An unacknowledged send (no broker ID)
still requires manual audit and is never resent.
