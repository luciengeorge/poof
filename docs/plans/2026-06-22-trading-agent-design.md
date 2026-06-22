# Autonomous Trading Agent — Design

Date: 2026-06-22
Status: Approved design, pre-implementation
Framework: eve (filesystem-first durable agents), deployed on Vercel

## Goal

A durable, multi-agent eve system that reads financial news + market data, proposes
trades, validates them against hard risk limits, executes via the Trading 212 API, and
reports on Slack. Built paper-first; graduates to real money in phases.

## Honest framing (non-negotiable context)

- Autonomous LLM trading does **not** reliably beat the market. News is priced in within
  seconds by professionals; an LLM has no structural edge. The realistic goal is a
  well-engineered, safe system that *might* make modest returns and **won't blow up the
  account** — not "max returns."
- Therefore the system is built around **capital preservation and hard guardrails**, proven
  on paper before any real money is risked.

## Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Rollout | Paper → prove → graduate | Risk nothing until behavior is proven |
| Account | Trading 212 **Invest** (stocks/ETFs, no leverage) | Worst case = capital→0, not owing money. No CFDs. |
| Trading style | Short/medium-term **swing trades** (hours→weeks) | Fits Invest (T+2 settlement) and fits an LLM reading news |
| Market | **US** stocks + ETFs | Most liquid, most news coverage = best signal |
| Risk appetite | **Balanced** | ETFs + news-driven stock bets, daily loss cap |
| Data provider | **Finnhub** (free for paper, cheap paid tier for live) | News-centric; covers news + quotes + fundamentals |
| Models | **Claude** via Vercel AI Gateway, tiered | Best agentic reasoning + tool use; cost-tiered per role |
| Slack channel | **#general** | Existing channel |
| Slack verbosity | Trades + alerts live, rejections in daily digest | Quiet but full visibility of real actions |

## Architecture

One eve app (not four deployments). The four "agents" map to eve primitives.

```
[schedule fires] → Research → Propose → RISK GATE → Execute → Report
                   (news+data) (theses)  (validate)  (T212)   (Slack)
```

**Validation happens BEFORE execution** — it is a gate, not a post-mortem.

**The single most important safety principle:** hard limits are enforced in
**deterministic TypeScript code** (`validate_orders` tool + `lib/risk.ts`), never left to
an LLM prompt. The LLM red-team can only *veto or shrink* a trade — never raise a limit or
approve one the code gate rejected.

### eve primitive mapping

- **Orchestrator** = root agent, triggered by eve **schedules** (Vercel Cron) on trading days.
- **Research agent** = **subagent** (own context): reads news + market data via tools, emits
  structured trade *theses*. Never executes.
- **Risk gate** = deterministic `validate_orders` **tool** (authoritative) + an LLM **red-team
  subagent** that critiques each surviving thesis.
- **Execution** = typed **tools** wrapping the Trading 212 API (`t212_place_order`, etc.). These
  hold the API key (app runtime), are idempotent, and are the only path to real orders.
- **Reporting + approval** = **Slack channel**. Phase 2 routes orders through eve's built-in
  human-in-the-loop approval before `t212_place_order` runs.
- **State** = eve `defineState`: positions, daily/peak P&L, halt flag, day's watchlist.

## Project structure

```
agent/
  agent.ts                   # model (sonnet-4.6), compaction, schedules config
  instructions.md            # orchestrator: run pipeline, obey the gate
  tools/
    t212_get_account.ts      # ┐ our own typed T212 tools (hold key, idempotent;
    t212_get_portfolio.ts    # │ only path to real orders). Written from the
    t212_place_order.ts      # │ OFFICIAL T212 API docs, not the audited-failed
    t212_cancel_order.ts     # ┘ third-party skill.
    get_news.ts              # Finnhub news + earnings
    get_prices.ts            # Finnhub quotes/candles
    validate_orders.ts       # deterministic risk gate (AUTHORITATIVE)
  skills/
    trading212.md            # our own API reference (from official docs)
    strategy.md              # the balanced swing-trading playbook
  subagents/
    research.ts              # news → structured theses (opus-4.8, no execution)
    red_team.ts              # critiques theses, can only veto/shrink (opus-4.8)
  channels/
    eve.ts                   # HTTP (auth) — already exists
    slack.ts                 # reporting + (Phase 2) approvals — already exists
  schedules/
    pre_open.ts  cycle.ts  eod.ts
  lib/
    t212.ts                  # shared T212 client (demo/live base URL switch)
    risk.ts                  # the limit table, pure functions
    state.ts                 # durable session/portfolio state
    data.ts                  # get_news/get_prices behind one interface (swap provider = 1 file)
```

## Risk guardrails (Balanced; enforced in code)

Limits expressed as **% of account equity** so they work identically on demo and live.

| Guardrail | Default | Enforced by |
|---|---|---|
| Max per single name | 18% of equity | code (hard reject) |
| Max total deployed | 80% (keep ≥20% cash) | code |
| Max new positions/day | 3 | code |
| Per-trade size | 2–8% of equity | code |
| Daily loss cap → HALT | −4% of equity | code + state flag |
| Max concurrent positions | ~10 | code |
| Leverage | none (Invest only) | account type |
| Per-position stop-loss | −8% from entry | tracked, acted next cycle |
| Min liquidity/price filter | price > $5, large/mid-cap | code |

All thresholds live in `lib/risk.ts` config for easy tuning.

### Halt / circuit-breaker policy (hybrid)

- **Daily loss cap (−4%) hit** → halt rest of day, **auto-resume next trading day**.
- **Circuit breaker → manual un-halt required** when either: daily cap hit **2 days in a
  row**, *or* drawdown from peak equity exceeds **−10%**. Agent posts "🛑 halted — reply
  `/resume`" on Slack and won't trade until acknowledged.

### Two-layer validation (ordered)

1. **`validate_orders` (deterministic, authoritative):** checks every proposed order against
   the table + current positions/cash from `t212_get_portfolio`. Any breach → reject. Halt
   flag short-circuits everything.
2. **Red-team subagent (after code gate passes):** argues *against* each thesis (priced in?
   thin float? earnings tomorrow? hype vs substance?). Can only **veto or shrink**.

A trade executes only if it clears **both**. Rejected trades are logged for the daily digest.

## Schedule (US market hours, via eve schedules / Vercel Cron)

- **Pre-open scan** (~09:00 ET): overnight news → day's watchlist + theses.
- **Mid-session cycles** (~2–3×/day): re-check news, run full pipeline, place/adjust orders, manage stops.
- **End-of-day report** (~16:15 ET): P&L, positions, what it did and why.

## Data layer (Finnhub)

- Behind one `get_news` / `get_prices` interface (`lib/data.ts`) — swapping/adding a provider
  (e.g. Polygon for prices later) is a one-file change.
- **Sentiment computed by the LLM** from headline/article text — avoids paying for Finnhub's
  sentiment endpoint and works on the free tier.
- Estimated volume: ~400–450 calls/day, bursty 60–90/cycle. Bottleneck is calls/min, mitigated
  by throttling per-symbol calls and caching fundamentals once daily.
- **Paper phase: Finnhub free tier ($0).** **Live phase: cheapest paid tier (~$12–50/mo)** for
  rate-limit headroom + detailed fundamentals.

## Models (Vercel AI Gateway, tiered)

| Role | Model | Why |
|---|---|---|
| Research + Red-team | `anthropic/claude-opus-4.8` | Hardest reasoning; quality pays for itself here |
| Orchestrator | `anthropic/claude-sonnet-4.6` | Mostly sequencing tool calls |
| Mechanical (Slack/parse) | `anthropic/claude-haiku-4.5` | Trivial, keep cheap |

Claude chosen for agentic reasoning + tool-use reliability under eve's loop. No LLM has a
market edge; the win is reasoning quality. Can A/B vs OpenAI later via eve evals. Claude tiers
used from day one (incl. paper phase). Current config `openai/gpt-5.4-nano` is too weak and
will be replaced.

## Slack reporting

- **Per-trade** (live): "✅ BOUGHT 3 NVDA @ $X ($Y, Z% equity) — thesis: … | gate: passed | red-team: passed".
- **Alerts** (live): halts, circuit breaker, API errors.
- **Daily digest**: equity, day P&L, total P&L vs deposit, open positions, halt status, rejected trades + reasons.
- **Phase 2**: per-trade messages become interactive Approve/Reject (eve HITL pauses the order).

## Skills (from skills.sh — reference only, not executors)

- `0xhubed/agent-trading-arena@risk-management` — guardrail patterns
- `affaan-m/everything-claude-code@llm-trading-agent-security` — layered security (prompt
  hygiene, spend policy, simulation, execution limits)
- **NOT** `trading212-labs/agent-skills@trading212-api` — beta + failed Snyk audit; we author
  our own `trading212.md` + tools from the official T212 API docs instead.

## Phased rollout (with prove-gates)

- **Phase 1 — Paper, autonomous.** Full pipeline on T212 **demo** (`demo.trading212.com`).
  Run ≥ **3–4 weeks**. Prove: didn't lose money / behaved sanely / zero limit breaches → graduate.
- **Phase 2 — Real, approval-gated.** Your deposit = the cap. Every order needs Slack approval
  (eve HITL). Prove over a few weeks.
- **Phase 3 — Real, autonomous** within hard limits + circuit breaker.

## Pre-production checklist (from eve security model)

- [ ] Replace `placeholderAuth()` in `agent/channels/eve.ts` with real auth (`vercelOidc()`).
- [ ] Verify Slack channel signature; never trust body-supplied identity.
- [ ] `T212_API_KEY`, `FINNHUB_API_KEY` in env only; never in artifacts or sandbox.
- [ ] `t212_place_order` idempotent (client order IDs) — crash mid-cycle can't double-trade.
- [ ] Sandbox network policy tighter than allow-all (agent doesn't need open egress).

## Open verification items (resolve during implementation)

- Verify Trading 212 API against **official docs**: demo vs live base URL, order endpoints/types
  Invest supports (market/limit/stop), rate limits, auth (API key from app → generate in T212 app).
- Confirm Finnhub free-tier endpoints actually cover company-news + basic-financials for US symbols
  at our throttled rate.
- Confirm Vercel Cron timezone handling for US market hours (ET, DST).
