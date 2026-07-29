/**
 * Pure extraction layer for the ONLINE eval hook (agent/hooks/trace-cycle.ts).
 *
 * The hook itself must never throw and must stay thin, so every piece of parsing that could
 * be wrong lives here, where it is unit-tested: naming an action result, pulling the cycle's
 * GBP ground truth out of tool results it already produced, deciding which turns are trading
 * cycles, and deciding which assistant messages are the report.
 *
 * OBSERVER ONLY. Nothing here is an input to the risk gate, sizing, or order placement.
 */

import { parseGbpFigures } from "./report-check.ts";
import type { ReportTruth } from "./report-check.ts";

/**
 * The tool or subagent name behind one `action.result` event, or null when the result is not
 * part of the cycle discipline (framework `load-skill-result`) or is malformed.
 *
 * `red_team` arrives as a `subagent-result` carrying `subagentName`, not `toolName`, so both
 * shapes are handled: the red-team-before-buy invariant depends on it.
 */
export function actionResultName(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const { toolName, subagentName } = result as {
    toolName?: unknown;
    subagentName?: unknown;
  };
  if (typeof toolName === "string" && toolName.length > 0) return toolName;
  if (typeof subagentName === "string" && subagentName.length > 0) return subagentName;
  return null;
}

/**
 * The `callId` behind one `action.result` event, or "" when it is missing.
 *
 * IDEMPOTENCY KEY. A turn is a durable workflow: if a crash lands between an event being
 * durably recorded and its delivery, the same `action.result` can fire again on resume. Without
 * a key, that double-appends and can false-trip `single-submit`, and a violation alert nobody
 * believes is worse than no alert at all. Empty means "cannot be deduplicated", and the caller
 * appends anyway rather than dropping a real tool call.
 */
export function actionResultCallId(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const { callId } = result as { callId?: unknown };
  return typeof callId === "string" ? callId : "";
}

/** Minimal shape of one runtime stream event, so this module does not depend on eve's union. */
export type EventLike = { type: string; data?: unknown };

interface RequestedAction {
  kind?: string;
  toolName?: string;
  subagentName?: string;
}

/**
 * The ordered names of every tool and subagent a run REQUESTED, earliest first, read from
 * `actions.requested` events.
 *
 * This is the OFFLINE mirror of `actionResultName`: the eval harness replays a full event
 * stream, so the sequence is built from requests there, while the production hook accumulates
 * results as they arrive. Both feed the same `checkInvariants`. Subagent delegations are
 * included under their subagent name so `red_team` participates in the ordering invariants.
 */
export function requestedActionNames(events: readonly EventLike[]): string[] {
  const requested: string[] = [];
  for (const event of events) {
    if (event.type !== "actions.requested") continue;
    const actions = (event.data as { actions?: unknown })?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions as RequestedAction[]) {
      if (action.kind === "tool-call" && action.toolName) requested.push(action.toolName);
      else if (action.kind === "subagent-call" && action.subagentName) {
        requested.push(action.subagentName);
      }
    }
  }
  return requested;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The cycle's authoritative GBP figures, read from a `review_performance` tool result. Returns
 * null unless a usable `accountValueGbp` is present: that figure is the whole basis of the
 * report check, and guessing one would be worse than not checking.
 */
export function truthFrom(output: unknown): ReportTruth | null {
  if (typeof output !== "object" || output === null) return null;
  const raw = output as Record<string, unknown>;
  const accountValueGbp = finiteOrNull(raw.accountValueGbp);
  if (accountValueGbp === null) return null;
  return {
    accountValueGbp,
    cashGbp: finiteOrNull(raw.cashGbp) ?? 0,
    deployedGbp: finiteOrNull(raw.deployedGbp) ?? 0,
  };
}

/**
 * GBP magnitudes the report may legitimately quote even though they dwarf the trading
 * account: each ADVISORY-ONLY external holding's value, cost basis and unrealised P&L, read
 * from a `review_external_holdings` tool result. Instrument-currency prices are deliberately
 * excluded: they are USD and are never compared against GBP ground truth.
 */
export function externalGbpValuesFrom(output: unknown): number[] {
  if (typeof output !== "object" || output === null) return [];
  const holdings = (output as { holdings?: unknown }).holdings;
  if (!Array.isArray(holdings)) return [];
  const values: number[] = [];
  for (const holding of holdings) {
    if (typeof holding !== "object" || holding === null) continue;
    const row = holding as Record<string, unknown>;
    for (const key of ["valueGbp", "costBasisGbp", "unrealisedPnlGbp"]) {
      const value = finiteOrNull(row[key]);
      if (value !== null) values.push(value);
    }
  }
  return values;
}

/**
 * Does this inbound message start a trading cycle?
 *
 * Only cycle turns get a trace and an invariant verdict. An ad-hoc Slack question calls no
 * `record_cycle`, so asserting the cycle invariants against it would fire a false alert on
 * every conversation and train the human to ignore the channel. Matches the scheduled
 * dispatch, the eval prompt, and a human asking for a cycle in their own words.
 */
export function isCycleTurnMessage(message: unknown): boolean {
  if (typeof message !== "string") return false;
  // "run" must sit in the same sentence as "trading cycle", so that talking ABOUT a past
  // cycle ("how did the trading cycle go?") is not mistaken for a request to run one.
  return /\brun\b[^.!?]*\btrading cycle\b/i.test(message);
}

/**
 * Is this assistant message a candidate for the cycle report?
 *
 * The report always quotes money in GBP (the instructions require the account value verbatim),
 * while interim narration before a tool call generally does not. Gating on "carries at least
 * one GBP figure" keeps short narration out of the report check without needing a length
 * heuristic; the LAST candidate of the turn is the one that gets graded.
 */
export function looksLikeReport(text: unknown): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return parseGbpFigures(text).length > 0;
}
