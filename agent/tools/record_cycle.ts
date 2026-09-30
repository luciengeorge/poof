import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { fxForCycle } from "../lib/fx.ts";
import { brokerSnapshotWithFx, reconcileAccountValueGbp } from "../lib/execution.ts";
import { cycleRecordWithFx } from "../lib/cycle-record.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";
import { isDryRun } from "../lib/state.ts";
import { CORE_TICKER } from "../lib/core.ts";
import { coreOrderRecord, sweepCore } from "../lib/core-orders.ts";

export default defineTool({
  description:
    `Log this cycle's decision to durable memory. Call this ONCE at the END of every cycle (whether or not you traded), after posting your report. It records what you decided (trade / no-trade), your one-line reasoning, and the candidates/watchlist you considered, alongside a server-fetched equity and free-cash snapshot. This decision log is how the weekly scorecard counts cycles and how you review your own reasoning over time. It places no stock orders; afterwards it sweeps free cash above a small buffer into the index core (${CORE_TICKER}), automatically, and reports what it did in \`core\`. Safe to call every cycle.`,
  inputSchema: z.object({
    decision: z
      .enum(["trade", "no-trade"])
      .describe('"trade" if you placed at least one order this cycle, otherwise "no-trade".'),
    rationale: z
      .string()
      .min(1)
      .max(2000)
      .describe("One or two sentences: why you traded or held off, and the main theme of the cycle."),
    candidates: z
      .array(z.string())
      .optional()
      .describe("Tickers or theses you seriously considered this cycle."),
    watchlist: z
      .array(z.string())
      .optional()
      .describe("Tickers you are watching for a future cycle."),
  }),
  async execute({ decision, rationale, candidates, watchlist }) {
    try {
      const client = t212FromEnv();
      const [account, fx] = await Promise.all([
        client.getBrokerSnapshot({ fresh: true }),
        fxForCycle(),
      ]);
      const brokerSnapshot = brokerSnapshotWithFx(account, fx);
      const accountValueReconciliation = reconcileAccountValueGbp(brokerSnapshot);
      const equity = accountValueReconciliation.accountValueGbp;
      const freeCash = brokerSnapshot.cash.free;
      const memory = memoryFromEnv();
      const env = tradingEnv();
      await memory.recordCycle(cycleRecordWithFx({
        env,
        equity,
        freeCash,
        decision,
        rationale,
        candidates,
        watchlist,
        fx,
      }));

      // END-OF-CYCLE SWEEP of idle cash into the index core. It lives here, not in submit_orders,
      // because this is the one tool that runs LAST, after every order the cycle places; that runs
      // EVERY cycle, where submit_orders is skipped on a quiet day, now the normal day; and that
      // holds the broker client. After recordCycle, so the recorded figures stay the account as the
      // day's stock orders left it. sweepCore never throws, so a sweep problem cannot unrecord the
      // cycle.
      const core = await sweepCore({
        client,
        fx,
        dryRun: isDryRun(),
        hasOrderIntent: (key) => memory.hasOrderIntent(env, key),
      });
      const audit = coreOrderRecord(core, env);
      if (audit) {
        try {
          await memory.recordCoreOrder(audit);
        } catch (err) {
          console.warn("[memory] recordCoreOrder failed (non-fatal):", err);
        }
      }
      // Surface reconciliation status so the observer can alert if the broker total was unusable
      // or the FX-derived cross-check diverged. The recorded equity remains broker-authoritative.
      //
      // The equity and cash figures are RETURNED as well as written. This tool runs LAST and does
      // its own fresh broker fetch, so these are the only figures that describe the account AFTER
      // the day's orders; everything else in the cycle saw a pre-trade snapshot. Returning them
      // costs nothing and makes the post-trade state observable outside this tool. They are
      // exactly the numbers written above, not a re-read.
      return {
        recorded: true,
        fx: { rate: fx.rate, source: fx.source, fallbackUsed: fx.source === "fallback" },
        accountValueGbp: equity,
        cashGbp: freeCash,
        snapshotTakenAt: brokerSnapshot.takenAt,
        accountValueReconciliation,
        core,
      };
    } catch (err) {
      console.warn("[memory] recordCycle failed (non-fatal):", err);
      return { recorded: false, note: "memory or broker unavailable" };
    }
  },
});
