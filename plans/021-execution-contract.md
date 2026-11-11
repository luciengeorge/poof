# Plan 021: execution contract for later D–F

Design only. No runtime account ownership or extra live trading cadence is introduced by A–C.

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

The current SELL path sends before intent bookkeeping and permits exits when bookkeeping
fails. That fail-open rule conflicts with strict account ownership. D must resolve and test
the policy explicitly before E/F; it is not silently changed by an observer feature.

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
