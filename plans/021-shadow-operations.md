# Plan 021: shadow implementation and activation

Local implementation of A–C; no production deployment or activation. Live cycle, catch-up,
broker calls, order handling, cash sweeps, risk state and lessons are unchanged by this slice.
The separate ambient/Eve migration remains in this checkout; review its combined build before deployment.

## Modes and prerequisites

All switches default to `false` in `.env.example`. An absent switch is off.

| Switch | Location | Effect |
|---|---|---|
| `SHADOW_RESEARCH_ENABLED` | Vercel + Convex | Master write/run gate |
| `SHADOW_FEED_QUOTAS_VERIFIED` | Vercel + Convex | Operator has checked feed access/headroom |
| `SHADOW_POSITIONS_ENABLED` | Vercel | Five-minute quote collection |
| `SHADOW_NEWS_ENABLED` | Vercel | Fifteen-minute incremental news ingestion |
| `SHADOW_FORECASTS_ENABLED` | Vercel | Prospective forecasts within news ingestion |
| `SHADOW_SCORE_ENABLED` | Vercel | Hourly matured-outcome scoring |

Require explicit `TRADING212_ENV=demo|live` for dataset partitioning. Shadow never constructs
a Trading 212 client. Convex uses the established `CONVEX_APP_SECRET` / `APP_SHARED_SECRET`
boundary; report queries work with all modes off. Existing live modes and `DRY_RUN` retain their meaning.

Before enabling: check the actual Finnhub company-news and timestamped quote entitlements,
Tiingo raw+adjusted EOD access for stocks and SPY, and Jev access. Measure existing funnel,
cycle and local research consumption on those keys. Do not set the quota-verification flag
merely because a platform plan changed. No paid feed or new service is provisioned.

New Convex tables are isolated `shadowDays`, `shadowRuns`, `shadowCursors`, `shadowEvents`,
and `shadowRevisions`, plus the rate-limiter component. Existing tables are read only.
The component is pinned to 0.3.2 for compatibility with the installed Convex 1.42;
`convex-test` 0.0.50 exercises the actual transactions and component in memory.
Production schema validation (`convex deploy --dry-run -y`) remains a reviewer gate;
it has not been run against production here. Deployment uses the existing Vercel production
build, which deploys Convex and regenerates component API types. Never deploy Convex separately.

## Cadence, limits and evidence

UTC cron wakeups: positions at minutes 2,7,…,57; news at 0,15,30,45; scorer at minute 9.
Positions are offset from news to reduce competition for the same shadow lease. Contention records a skipped receipt.
US regular-session calendar (2026–2027, NYSE holidays/early closes and ET DST) gates A/B.
Unsupported years fail closed. All shadow jobs exclude UTC hours 12,15,18 to reserve the
broad funnel, daily cycle and catch-up windows. Scoring can otherwise run outside sessions.
These exclusions produce intentional gaps, not a claim of uninterrupted listening.

One active shadow job per environment; one attempt per kind/slot; 240-second lease with
180-second work budget. Expired workers cannot write. No model/quote replay on an invocation
retry. A missed slot is never backfilled as a contemporary observation.

Durable quotas cover every physical shadow request: Finnhub 20/minute (burst 2), Tiingo
2/hour, Jev 40/ET-day, forecasts 20/ET-day. Finnhub requests run serially at least 3.2 seconds apart, except starting-pair
legs use a two-token burst after a 6.4-second refill pause. No feed retries; first 429 stops that run. Limits apply across shadow
workers, with UTC-anchored daily windows (no reset during the US session) and feed-key headroom reserved for existing live work; they do not retroactively
meter the established trading clients. If live degradation occurs, disable shadow research.

A currently records `position-state-unavailable` with any fresh held-symbol quotes.
Original BUY quantities are not confirmed current broker quantities, so no hypothetical
exit is calculated or stored. Quote collection is operational evidence only. A coherent,
recent confirmed snapshot contract is required before the trigger-comparison study can run.

B freezes at most 12 shortlisted symbols daily and adds at most 4 known held symbols.
Reads use a durable per-symbol cursor with 15-minute overlap and a 36-hour catch-up bound.
At most 50 items per symbol enter one transaction. Truncation keeps the cursor stationary,
and is recorded in the run reason. Cursor advancement and event insertion commit together.
Exact normalized headline/date or canonical URL deduplicates a story per ticker; different
syndicated headlines can evade that rule. Original evidence is immutable; corrections get
separate revision rows and never trigger another forecast. Eligible but unattempted events
remain visible; expired new/attempting/committed rows become unscoreable on the next claim.

C attempts at most 3 events per news run, reusing the existing Jev screen. Screening scores
are annotations, not eligibility thresholds. Eligible news has a known publication time,
is first seen during the session, and arrives within 15 minutes. Attempt time must still be
within that age bound. Unknown/stale/overnight articles are retained but ineligible.
There is no synthetic 0.5 answer on failure: unavailable forecasts are unscoreable.

Contract `event-relative-v1`: probability that stock USD total return strictly exceeds SPY
USD total return, from a prospective start to the actual close of the next US session whose
open follows commitment. Ties are false. The ledger stores input cutoff, completion and
server commitment separately. Only after commitment are stock/SPY quotes requested; both
must be timestamped after commitment, at most 60 seconds old and within the 60-second start
window, mutually within 5 seconds, and before the target open. Three bounded pair attempts
are allowed; lack of a qualifying pair is unscoreable. The model has no subsequent-news,
broker, execution-agent, account-memory or order tools.

Scoring waits at least 12 hours after target close. Raw intraday starts are converted using
each source response's start-day adjusted/raw close factor, then compared to adjusted target
closes. This handles splits/dividends without mixing adjusted and raw price bases. Missing
bars remain pending. One stock/SPY pair is scored per hourly run; pending rows rotate.
The baseline is frozen before collection from up to 200 earlier scored events, with matching
calendar-day horizon and outcomes available before that session's open; fewer than 20 gives
an explicitly unavailable baseline. This minimum supports description, not a promotion gate.

## Reports and rollback

With credentials loaded securely into the shell (do not print them), on Node 24:

```sh
node --experimental-strip-types scripts/shadow-report.ts 2026-11-11
```

This is a read-only query. JSON reports show all event states/reasons, capped/truncated
coverage, expected/attempted/completed/failed/missing ticks, unavailable position states,
fresh quote counts, horizon buckets, Brier versus 0.5 and the frozen base rate, and
story-weighted Brier. A daily report supplies only one trading-date cluster: it does not
invent uncertainty bounds or claim alpha. Keep successive daily reports for the later
untouched evaluation period; clustered uncertainty and live promotion require a separate
cross-date study. No publication or trading authority follows from a favourable score.

Switch off `SHADOW_RESEARCH_ENABLED` in Convex to reject further shadow writes, and in
Vercel to stop dispatch/network work on the next deployment. In-flight provider GETs/model
requests may finish; this switch is not cancellation. Persisted original evidence remains.
For an individual mode, switch that mode off and redeploy. Do not change the established
daily cycle to roll back research. Deploy outside market/runbook windows; record missed ticks.

Before any enablement, validate the deployed handlers with modes off, perform the schema
review, then enable A first. Collect ten complete sessions of operational coverage and
quota/freshness evidence. B and C have separate switches and activation decisions. This
checkout does not establish a profitable signal, full position-snapshot capability, or live
intraday exit readiness. D–F require their own implementation, review and activation.

## Local verification (2026-11-11)

848 tests passed on Node 24, including 20 shadow tests. App and Convex typechecks passed;
Eve build and runtime-asset smoke check passed. Six mutation checks failed as expected when
default-off gating, pre-commit quote rejection, adjusted-price basis, zero-retry policy,
owner fencing and backend prospective-start validation were deliberately broken, then restored.
Backend tests run actual Convex transactions and the rate-limiter component without network.
Jev automated code review was attempted but unavailable (`JEV_API_KEY` unset); no external
model validation, production schema dry-run, deployed-handler test or quota verification is
claimed by these results. The separate earlier Gateway-backed greeting eval remains blocked
by disconnected local Gateway credentials.

## Authorized activation (11 Nov 2026)

Lucien explicitly requested both ambient listening and all shadow research modes on.
The activation patch enforces ambient read-only tool permissions, disables ambient sandbox
and delegation, queues Slack turns, and adds an operator-only `/ops/activation-readiness`
endpoint. It accepts the existing shared secret as a bearer token, never returns credentials
or raw provider errors, and probes only bounded read-only feed/Slack/model requests with
`?probe=1`. Never run probes in the excluded live windows. A status request without `probe`
returns only effective configuration booleans.

Deploy the permission patch with modes off after 16:00 UTC, verify the probes, then set
all per-mode flags on in Vercel and master/quota flags on in Convex and redeploy through
Vercel. Verify effective flags and first durable run receipts. Slack still requires the
Connect client's message event subscriptions and history permissions. Observation remains
quote-only where confirmed position quantities are unavailable; forecast results cannot trade.

Production follow-up: a failed read/parse for one news symbol must not discard other
symbols or their forecast opportunities. Such failures retain that cursor and mark the
poll failed with bounded symbol/category diagnostics; peers continue. Missing optional
summary/source text is empty, while malformed mandatory headlines keep the cursor stationary.
All provider HTTP errors and durable budget denials still stop the run, including first429.
