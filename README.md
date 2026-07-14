# poof

An autonomous trading agent. Built with the [eve](https://www.npmjs.com/package/eve) agent
framework and [Convex](https://convex.dev) for persistent memory, trading a real
[Trading 212](https://www.trading212.com/) ISA account.

## What it does

On a daily schedule, the agent recalls its memory (past trades, lessons, risk state),
checks and manages open positions, reads market news and prices, forms a small number of
trade theses, runs each thesis through a red-team check and a hard risk gate, submits
orders, then posts a plain-English summary to Slack. See `agent/instructions.md` for the
full step-by-step cycle and `agent/lib/risk.ts` for the risk gate.

## Architecture

`eve` runs the agent loop and schedules (`agent/schedules/`), calling tools
(`agent/tools/`) that talk to Trading 212 (`agent/lib/t212.ts`), market data providers,
and Convex (`convex/memory.ts`) for durable state (trade history, lessons, risk state).
Reports and alerts go to Slack.

## Setup

1. Install Node 24.x (see `.nvmrc`) and `corepack enable`.
2. Install dependencies: `corepack pnpm@10.26.0 install`.
3. Copy `.env.example` to `.env.local` and fill in real values. Read every comment in
   that file first, especially the safety switches section.

## Verification commands

Run these before trusting any change:

```
corepack pnpm@10.26.0 run typecheck
corepack pnpm@10.26.0 run test
corepack pnpm@10.26.0 run build
pnpm eval
```

## Safety switches

Two env vars control whether this agent can touch real money (see `agent/lib/state.ts`):

- `DRY_RUN` - defaults ON (anything other than the literal string `"false"` is treated as
  dry-run). While on, orders are simulated, not sent to the broker.
- `TRADING212_ENV` - defaults to `"demo"` (paper trading) wherever it is read. Set to
  `"live"` to point at the real account.

`REQUIRE_APPROVAL=true` additionally requires a Slack approval before each real order,
but only takes effect once `DRY_RUN=false`.

## How to go live

Only do this once you have tested thoroughly in `DRY_RUN=true` / `TRADING212_ENV=demo`.

1. Fund the real Trading 212 ISA account.
2. Set `TRADING212_ENV=live` in your deployment's environment variables.
3. Set `DRY_RUN=false`.
4. Redeploy.

Real orders will only be placed once both `TRADING212_ENV=live` and `DRY_RUN=false` are
set together.

## Kill switch

To stop real-money trading immediately:

1. Set `DRY_RUN=true`.
2. Redeploy.

This is the fastest way to halt order placement without touching any other config. Orders
will go back to being simulated instead of sent to the broker.
