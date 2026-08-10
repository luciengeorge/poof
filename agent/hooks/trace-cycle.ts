import { defineHook } from "eve/hooks";
import { alert } from "../lib/alert.ts";
import {
  actionResultCallId,
  actionResultName,
  exitsFrom,
  externalGbpValuesFrom,
  externalHoldingsFrom,
  isCycleTurnMessage,
  looksLikeReport,
  ordersFrom,
  positionsFrom,
  postTradeTruthFrom,
  quotesFrom,
  truthFrom,
} from "../lib/cycle-trace.ts";
import {
  checkInvariants,
  summarizeInvariants,
  vacuousInvariants,
  violatedInvariants,
} from "../lib/invariants.ts";
import { checkReportNumbers, summarizeFindings } from "../lib/report-check.ts";
import { memoryFromEnv, type Memory, type CycleTraceKey } from "../lib/memory.ts";
import { OBSERVER_FETCH_TIMEOUT_MS } from "../lib/fetch-timeout.ts";
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
 *     red-team before a buy, exits before entries, no instrument sent twice, a recorded cycle.
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
 *  - `action.result`: the ordered tool/subagent sequence, plus the cycle's own ground truth from
 *    results it already produced: the pre-trade GBP figures and held positions from
 *    review_performance, the POST-TRADE equity and cash from record_cycle (which runs last and
 *    refetches), the orders from submit_orders, the exits from manage_positions, the quoted prices
 *    from get_prices, and the advisory external holdings from review_external_holdings.
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
  // Tracing needs durable storage; without the Convex credentials there is nowhere to record
  // (CI and eval runs), and retrying per event would just warn on every tool call.
  if (!process.env.CONVEX_APP_SECRET || !process.env.CONVEX_URL) return null;
  return { env: tradingEnv(), sessionId, turnId };
}

/**
 * Convex client for this hook, with every HTTP call TIME-BOUNDED. Hooks run inline in eve's
 * event pipeline, so a Convex endpoint that hangs rather than errors would stall the cycle
 * until the OS TCP timeout, and this hook makes one small call per tool result. The trading
 * path deliberately keeps its untimed client (see memoryFromEnv).
 */
function observerMemory(): Memory {
  return memoryFromEnv(undefined, { timeoutMs: OBSERVER_FETCH_TIMEOUT_MS });
}

/**
 * An output that will NOT parse must say so.
 *
 * This silence is why a real capture gap took a long chase to find: `ordersFrom` returning null
 * looked identical to a cycle that placed nothing, so the trace simply had no orders and nothing
 * anywhere said why. Absence of capture has to announce itself, exactly like the truncation cap
 * does. The top-level keys are logged (never the values, which contain positions and prices) so the
 * shape mismatch is diagnosable from the log alone.
 */
function warnUnparseable(key: CycleTraceKey, toolName: string, output: unknown): void {
  const shape =
    typeof output === "object" && output !== null
      ? `object with keys [${Object.keys(output as object).join(", ")}]`
      : typeof output;
  console.warn(
    `[online-eval] cycle ${key.sessionId}/${key.turnId}: could NOT parse ${toolName} output, so ` +
      `its ground truth is MISSING from the trace and the judge will see nothing for it. Got ${shape}.`,
  );
}

/**
 * Say out loud when a recorded collection hit its cap, exactly as the 200-tool cap does.
 *
 * A silently short list is the dangerous case: the judge would read a missing order or price as
 * proof the report invented it. The flag travels to the judge in the ground truth as well; this
 * line is so the same fact is visible to a human reading the logs.
 */
function warnIfTruncated(key: CycleTraceKey, what: string, truncated: boolean): void {
  if (!truncated) return;
  console.warn(
    `[online-eval] cycle ${key.sessionId}/${key.turnId}: ${what} hit the recording cap and is ` +
      "INCOMPLETE; it is marked truncated so absence from it proves nothing",
  );
}

export default defineHook({
  events: {
    // Open a trace only for turns that are actually trading cycles.
    async "message.received"(event, ctx) {
      try {
        if (!isCycleTurnMessage(event.data?.message)) return;
        const traceKey = key(ctx.session.id, event.data?.turnId);
        if (!traceKey) return;
        await observerMemory().startCycleTrace(traceKey);
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

        const memory = observerMemory();
        // The callId makes the append idempotent: a durable turn can re-deliver this very event
        // after a crash-and-resume, and a double-append would put a second submit_orders in the
        // sequence.
        const callId = actionResultCallId(result);
        await memory.appendCycleTraceTool(traceKey, name, callId);

        // NOTE: the context saves below are deliberately NOT skipped when the append reports a
        // duplicate. They used to be, and that lost real data: on 2026-08-06 a cycle recorded
        // neither its orders nor its exits. Re-delivery is instead handled inside the mutation, per
        // callId, so a repeated result cannot double-count into an accumulating collection while a
        // later delivery of the SAME call carrying fuller output is still captured.

        // Ground truth for the report check AND for the later report-quality judge, taken from
        // results the cycle already computed: no extra broker or FX calls, so observing cannot
        // perturb what is observed.
        //
        // WHY SO MUCH OF IT. The judge is asked whether every numeric claim is supported, and it
        // may use nothing but what is recorded here. With only six GBP numbers stored, a
        // correctly sourced order, exit, position count or price was unverifiable from its seat
        // and scored as invented: three consecutive live cycles were graded grounding=1 on
        // ACCURATE reports. Each collection is bounded and flags its own truncation, so an
        // incomplete list is never read as proof that a real event did not happen.
        const output = (result as { output?: unknown } | undefined)?.output;
        if (name === "review_performance") {
          // PRE-TRADE: this tool runs early. `accountValueGbp` here is what the deterministic
          // report check grades against, since the report is told to quote it verbatim.
          const truth = truthFrom(output);
          const positions = positionsFrom(output);
          if (positions) warnIfTruncated(traceKey, "the held position list", positions.truncated);
          // One round trip for both: this runs INLINE in a live cycle, so the hook keeps its
          // per-tool-result HTTP traffic to the minimum.
          if (truth || positions) {
            await memory.saveCycleTraceContext(traceKey, {
              ...truth,
              ...(positions
                ? {
                    positionTickers: positions.tickers,
                    positionCount: positions.count,
                    positionsTruncated: positions.truncated,
                  }
                : {}),
            });
          }
        } else if (name === "record_cycle") {
          // POST-TRADE: this tool runs LAST and does its own fresh broker fetch, so it is the
          // only figure describing the account after the day's orders. Stored separately from the
          // pre-trade pair rather than overwriting it: the judge needs the post-trade cash (the
          // report describes what is left AFTER trading), and the deterministic check keeps
          // grading the pre-trade account value it always graded.
          const postTrade = postTradeTruthFrom(output);
          if (postTrade) {
            await memory.saveCycleTraceContext(traceKey, {
              postTradeAccountValueGbp: postTrade.accountValueGbp,
              postTradeCashGbp: postTrade.cashGbp,
            });
          }
        } else if (name === "submit_orders") {
          const captured = ordersFrom(output);
          if (captured) {
            warnIfTruncated(traceKey, "the order list", captured.truncated);
            await memory.saveCycleTraceContext(traceKey, {
              orders: captured.orders,
              ordersTruncated: captured.truncated,
              callId,
            });
          } else {
            warnUnparseable(traceKey, name, output);
          }
        } else if (name === "manage_positions") {
          const captured = exitsFrom(output);
          if (captured) {
            warnIfTruncated(traceKey, "the exit list", captured.truncated);
            await memory.saveCycleTraceContext(traceKey, {
              exits: captured.exits,
              exitsTruncated: captured.truncated,
              callId,
            });
          } else {
            warnUnparseable(traceKey, name, output);
          }
        } else if (name === "get_prices") {
          // Merged server-side across the cycle's several calls, so an early quote the report
          // cites is not erased by a later batch.
          const quotes = quotesFrom(output);
          if (Object.keys(quotes).length > 0) {
            await memory.saveCycleTraceContext(traceKey, { quotes, callId });
          }
        } else if (name === "review_external_holdings") {
          // Two forms of the same tool result, and neither replaces the other: the BARE array is
          // the magnitude allow-list the deterministic check consumes, the LABELLED holdings are
          // reference context for the judge. Handing it the bare array is what made it read the
          // allowance as a checklist of figures the report owed the reader.
          const externalGbpValues = externalGbpValuesFrom(output);
          const labelled = externalHoldingsFrom(output);
          if (labelled.holdings.length > 0) {
            warnIfTruncated(traceKey, "the external advisory holding list", labelled.truncated);
          }
          if (externalGbpValues.length > 0 || labelled.holdings.length > 0) {
            await memory.saveCycleTraceContext(traceKey, {
              ...(externalGbpValues.length > 0 ? { externalGbpValues } : {}),
              ...(labelled.holdings.length > 0
                ? {
                    externalAdvisoryHoldings: labelled.holdings,
                    externalAdvisoryHoldingsTruncated: labelled.truncated,
                  }
                : {}),
            });
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
        await observerMemory().saveCycleTraceContext(traceKey, { reportText: String(text) });
      } catch (err) {
        console.warn("[online-eval] recording the report text failed (non-fatal):", err);
      }
    },

    // The terminal boundary: grade the cycle once, persist the verdict, alert on anything wrong.
    async "turn.completed"(event, ctx) {
      try {
        const traceKey = key(ctx.session.id, event.data?.turnId);
        if (!traceKey) return;
        const memory = observerMemory();
        const trace = await memory.getCycleTrace(traceKey);
        if (!trace) return; // not a cycle turn

        // A truncated trace is missing tools, so checkInvariants downgrades absence-based
        // conclusions to not-applicable: a recording cap must never produce a false violation.
        const truncated = trace.truncated === true;
        // The recorded orders are passed too: `no-duplicate-orders` is a property of the orders,
        // not of how many submit_orders calls produced them. Without them it would report
        // not-applicable on every cycle, which is a guard that never runs.
        const invariants = checkInvariants(trace.toolSequence, {
          truncated,
          orders: trace.orders,
          ordersTruncated: trace.ordersTruncated,
        });
        const violations = violatedInvariants(invariants);
        const vacuous = vacuousInvariants(invariants);
        if (truncated) {
          console.warn(
            `[online-eval] cycle ${traceKey.sessionId}/${traceKey.turnId} trace was TRUNCATED ` +
              `at ${trace.toolSequence.length} tools; absence-based invariants are reported as ` +
              "not-applicable rather than violated",
          );
        }

        // Only gradeable with both halves: the numbers the code computed and the text the agent
        // wrote. A missing half is reported, not silently treated as a pass.
        const report =
          trace.accountValueGbp !== undefined && trace.reportText !== undefined
            ? checkReportNumbers(trace.reportText, {
                accountValueGbp: trace.accountValueGbp,
                // Both stages are supplied: a report written after trading legitimately quotes the
                // post-trade figure, and grading it against the pre-trade one produced a guaranteed
                // false finding on every cycle that traded.
                postTradeAccountValueGbp: trace.postTradeAccountValueGbp,
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
