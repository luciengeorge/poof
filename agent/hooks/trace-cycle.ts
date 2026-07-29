import { defineHook } from "eve/hooks";
import { alert } from "../lib/alert.ts";
import {
  actionResultName,
  externalGbpValuesFrom,
  isCycleTurnMessage,
  looksLikeReport,
  truthFrom,
} from "../lib/cycle-trace.ts";
import {
  checkInvariants,
  summarizeInvariants,
  vacuousInvariants,
  violatedInvariants,
} from "../lib/invariants.ts";
import { checkReportNumbers, summarizeFindings } from "../lib/report-check.ts";
import { memoryFromEnv, type CycleTraceKey } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";

/**
 * ONLINE EVALS: behavioural verification of the REAL production cycle.
 *
 * The offline evals in evals/cycle/ prove the agent can behave correctly in CI against a demo
 * account. Nothing proved that a live cycle DID behave correctly: production had a heartbeat, a
 * failure alert and a decision log, but nothing that ASSERTED anything about a completed cycle.
 * Every incident was caught by a human reading Slack.
 *
 * This hook closes that gap with two independent checks, both observers:
 *
 *  1. INVARIANTS over the ordered tool sequence, using the very same `checkInvariants` the
 *     offline evals call (agent/lib/invariants.ts). Guards the cycle discipline: earnings and
 *     red-team before a buy, exits before entries, exactly one submit, a recorded cycle.
 *  2. REPORT SELF-CONSISTENCY: does the account value the agent WROTE match the one the code
 *     COMPUTED (agent/lib/report-check.ts)? This is the check that would have caught the report
 *     claiming about GBP 282 when the account held GBP 248.
 *
 * SAFETY. This hook is an OBSERVER and can only log, write to the cycleTraces table, and post
 * an alert. It never touches the risk gate, sizing, or order placement, and a failing check
 * alerts rather than blocking anything. It also MUST NEVER THROW: eve treats a thrown hook as a
 * real failure that escalates to turn.failed, so a trace-capture problem would become a trading
 * failure. Every handler body is therefore wrapped in try/catch, exactly like alert-on-failure.
 *
 * EVE EVENTS, and why:
 *  - `message.received`: marks which turns are cycles at all. Ad-hoc Slack questions call no
 *    record_cycle, so grading them would alert falsely on every conversation.
 *  - `action.result`: the ordered tool/subagent sequence, plus the cycle's own GBP ground truth
 *    from the review_performance / review_external_holdings results it already produced.
 *  - `message.completed`: the outbound report text, which is where the stated numbers live.
 *  - `turn.completed`: the terminal boundary where everything is graded and alerted once.
 *
 * WHY WRITES ARE INCREMENTAL. A turn is a durable workflow that checkpoints at every step and
 * can resume in a different process after a redeploy, timeout or crash. In-memory accumulation
 * across steps would therefore be silently lossy, so each observation is upserted into the
 * cycleTraces row as it happens, keyed by (env, sessionId, turnId), and only the final verdict
 * is computed at the turn boundary. A partial trace also survives a cycle that dies mid-way,
 * which is exactly the forensic record that was missing.
 */

function key(sessionId: string, turnId: unknown): CycleTraceKey | null {
  if (typeof turnId !== "string" || turnId.length === 0) return null;
  return { env: tradingEnv(), sessionId, turnId };
}

export default defineHook({
  events: {
    // Open a trace only for turns that are actually trading cycles.
    async "message.received"(event, ctx) {
      try {
        if (!isCycleTurnMessage(event.data?.message)) return;
        const traceKey = key(ctx.session.id, event.data?.turnId);
        if (!traceKey) return;
        await memoryFromEnv().startCycleTrace(traceKey);
        // Positive signal on the happy path: if this line never appears in the logs and
        // cycleTraces stays empty, the online evals are not running at all.
        console.log(
          `[online-eval] cycle trace opened for ${traceKey.sessionId}/${traceKey.turnId}`,
        );
      } catch (err) {
        console.warn("[online-eval] starting the cycle trace failed (non-fatal):", err);
      }
    },

    // Accumulate the ordered tool sequence and the cycle's ground truth. Every write is a
    // no-op when this turn has no trace, so non-cycle turns cost one round trip and nothing else.
    async "action.result"(event, ctx) {
      try {
        const traceKey = key(ctx.session.id, event.data?.turnId);
        if (!traceKey) return;
        const result = event.data?.result;
        const name = actionResultName(result);
        if (!name) return;

        const memory = memoryFromEnv();
        await memory.appendCycleTraceTool(traceKey, name);

        // Ground truth for the report check, taken from results the cycle already computed:
        // no extra broker or FX calls, so observing cannot perturb what is observed.
        const output = (result as { output?: unknown } | undefined)?.output;
        if (name === "review_performance") {
          const truth = truthFrom(output);
          if (truth) await memory.saveCycleTraceContext(traceKey, truth);
        } else if (name === "review_external_holdings") {
          const externalGbpValues = externalGbpValuesFrom(output);
          if (externalGbpValues.length > 0) {
            await memory.saveCycleTraceContext(traceKey, { externalGbpValues });
          }
        }
      } catch (err) {
        console.warn("[online-eval] recording a tool result failed (non-fatal):", err);
      }
    },

    // Keep the latest report candidate. The report is not necessarily the turn's final message
    // (record_cycle and update_lessons run after it), so this deliberately does not filter on
    // finishReason; it keeps the last message that quotes money, which is the report.
    async "message.completed"(event, ctx) {
      try {
        const traceKey = key(ctx.session.id, event.data?.turnId);
        if (!traceKey) return;
        const text = event.data?.message;
        if (!looksLikeReport(text)) return;
        await memoryFromEnv().saveCycleTraceContext(traceKey, { reportText: String(text) });
      } catch (err) {
        console.warn("[online-eval] recording the report text failed (non-fatal):", err);
      }
    },

    // The terminal boundary: grade the cycle once, persist the verdict, alert on anything wrong.
    async "turn.completed"(event, ctx) {
      try {
        const traceKey = key(ctx.session.id, event.data?.turnId);
        if (!traceKey) return;
        const memory = memoryFromEnv();
        const trace = await memory.getCycleTrace(traceKey);
        if (!trace) return; // not a cycle turn

        const invariants = checkInvariants(trace.toolSequence);
        const violations = violatedInvariants(invariants);
        const vacuous = vacuousInvariants(invariants);

        // Only gradeable with both halves: the numbers the code computed and the text the agent
        // wrote. A missing half is reported, not silently treated as a pass.
        const report =
          trace.accountValueGbp !== undefined && trace.reportText !== undefined
            ? checkReportNumbers(trace.reportText, {
                accountValueGbp: trace.accountValueGbp,
                cashGbp: trace.cashGbp ?? 0,
                deployedGbp: trace.deployedGbp ?? 0,
                externalGbpValues: trace.externalGbpValues,
              })
            : null;

        await memory.finishCycleTrace(traceKey, {
          invariants,
          reportPass: report?.pass,
          reportFindings: report?.findings,
        });

        console.log(
          `[online-eval] cycle ${traceKey.sessionId}/${traceKey.turnId} ` +
            `tools=${trace.toolSequence.length} ${summarizeInvariants(invariants)} ` +
            `report=${report ? (report.pass ? "pass" : "FAIL") : "not-checked"}`,
        );
        // Vacuity is not a failure, but it is not evidence either: say so, so that "verified"
        // and "never reached" never look the same in the logs.
        if (vacuous.length > 0) {
          console.log(
            `[online-eval] ${vacuous.length} guard(s) held vacuously (never exercised): ` +
              vacuous.map((r) => r.name).join(", "),
          );
        }

        if (violations.length > 0) {
          await alert(
            `🚨 poof ONLINE EVAL: ${violations.length} cycle invariant(s) violated ` +
              `(session ${traceKey.sessionId}): ` +
              violations.map((r) => `${r.name} (${r.detail ?? "no detail"})`).join("; ") +
              `. Tool sequence: ${trace.toolSequence.join(" -> ")}`,
          );
        }
        if (report && !report.pass) {
          await alert(
            `🚨 poof ONLINE EVAL: the report does not match the computed numbers ` +
              `(session ${traceKey.sessionId}): ${summarizeFindings(report.findings)}`,
          );
        }
        if (report === null && trace.toolSequence.length > 0) {
          console.warn(
            "[online-eval] report self-consistency NOT checked: missing " +
              `${trace.accountValueGbp === undefined ? "ground truth" : "report text"}`,
          );
        }
      } catch (err) {
        // A grading failure must never escalate into a cycle failure.
        console.warn("[online-eval] grading the cycle failed (non-fatal):", err);
      }
    },
  },
});
