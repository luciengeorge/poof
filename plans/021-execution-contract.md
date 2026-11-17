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
