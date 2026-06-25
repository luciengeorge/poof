import { defineTool } from "eve/tools";
import { z } from "zod";
import { checkHalt, DEFAULT_LIMITS } from "../lib/risk.ts";
import { t212FromEnv } from "../lib/t212.ts";
import { evaluateAndExecute } from "../lib/orders.ts";
import {
  deriveRiskState,
  loadRiskState,
  fxRateFromEnv,
  isDryRun,
  type RiskState,
  type StoredRiskState,
} from "../lib/state.ts";
import { etDateString } from "../lib/clock.ts";
import { memoryFromEnv, type Env } from "../lib/memory.ts";

const env = (): Env => (process.env.TRADING212_ENV ?? "demo") as Env;

// Load durable risk state from Convex, derive this cycle's fields (day rollover, peak,
// consecutive-loss days), persist the update, and return the gate fields. Best-effort:
// if memory is unavailable, fall back to a neutral state (no halt) so trading isn't blocked.
async function resolveRiskState(currentEquity: number): Promise<RiskState> {
  try {
    const memory = memoryFromEnv();
    const stored = (await memory.getRiskState(env())) as StoredRiskState | null;
    const derived = deriveRiskState(stored, currentEquity, etDateString(new Date()));
    const halt = checkHalt(
      {
        equity: currentEquity,
        cash: 0,
        positions: [],
        ...derived.fields,
      },
      DEFAULT_LIMITS,
    );
    await memory.saveRiskState({
      env: env(),
      ...derived.persist,
      haltState: halt.halted
        ? halt.manualResumeRequired
          ? "circuit"
          : "daily"
        : "none",
    });
    return derived.fields;
  } catch (err) {
    console.warn(
      "[memory] risk-state resolve failed; using neutral state (no halt):",
      err,
    );
    return loadRiskState();
  }
}

const proposalSchema = z.object({
  ticker: z.string().min(1).describe("Trading 212 instrument ticker, e.g. AAPL_US_EQ"),
  side: z.enum(["BUY", "SELL"]),
  notional: z
    .number()
    .positive()
    .describe("Positive amount to trade, in account currency (GBP)"),
  price: z.number().positive().describe("Current share price in USD (from get_prices)"),
  thesis: z
    .string()
    .min(1)
    .describe("One-line reason for the trade (recorded to memory with the trade)"),
  redTeamVerdict: z
    .string()
    .optional()
    .describe("The red_team subagent's verdict on this thesis, if reviewed"),
});

export default defineTool({
  description:
    "Validate proposed trades against the hard risk limits on the LIVE account, then place the accepted ones as market orders. The risk gate runs INSIDE this tool and is authoritative — it cannot be bypassed. Honors DRY_RUN (default on: orders are simulated, not sent). Returns `placed` (with share quantity; `dryRun`/`skipped` flags) and `rejected` (with reasons). Always report both back to the user.",
  inputSchema: z.object({
    proposals: z.array(proposalSchema).min(1).max(10),
  }),
  // Phase 1b: require human approval (Slack) before REAL orders. Only meaningful when
  // actually executing — dry-run/simulated orders never need approval.
  needsApproval: () =>
    process.env.REQUIRE_APPROVAL === "true" && process.env.DRY_RUN === "false",
  async execute({ proposals }) {
    const client = t212FromEnv();
    const result = await evaluateAndExecute(proposals, {
      client,
      fxRate: fxRateFromEnv(),
      dryRun: isDryRun(),
      resolveRiskState,
    });

    // Record every placed/simulated trade to durable memory. Best-effort:
    // a memory failure must never break trading.
    try {
      const memory = memoryFromEnv();
      await Promise.all(
        result.placed.map((p) =>
          memory.recordTrade({
            env: env(),
            ticker: p.proposal.ticker,
            side: p.proposal.side,
            notional: p.proposal.notional,
            price: p.proposal.price,
            quantity: p.quantity,
            dryRun: p.dryRun,
            thesis: p.proposal.thesis,
            redTeamVerdict: p.proposal.redTeamVerdict,
            status: p.skipped ? "skipped" : p.dryRun ? "dry-run" : "placed",
          }),
        ),
      );
    } catch (err) {
      console.warn("[memory] recordTrade failed (non-fatal):", err);
    }

    return result;
  },
});
