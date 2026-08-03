/**
 * Pure extraction layer for the ONLINE eval hook (agent/hooks/trace-cycle.ts).
 *
 * The hook itself must never throw and must stay thin, so every piece of parsing that could
 * be wrong lives here, where it is unit-tested: naming an action result, pulling the cycle's
 * ground truth out of tool results it already produced, deciding which turns are trading
 * cycles, and deciding which assistant messages are the report.
 *
 * WHAT "GROUND TRUTH" MEANS HERE, and why it grew. It started as six GBP numbers, which turned
 * out to be far too little: the report-quality judge is asked whether every numeric claim is
 * supported, and with only six numbers to check against, a correctly sourced order, exit,
 * position count or price was UNVERIFIABLE and read as invented. Three consecutive live cycles
 * were scored grounding=1 on accurate reports. So the extractors below capture, from tool results
 * the cycle already produced (no extra broker or FX calls, so observing cannot perturb what is
 * observed): the pre-trade GBP figures, the POST-TRADE snapshot, the orders, the exits, the held
 * positions, the quoted prices, and the external advisory holdings with labelled fields.
 *
 * Every collection is BOUNDED and says when it truncated, because a judge told "this list is
 * incomplete" can refrain from concluding anything, whereas a silently short list looks like
 * proof that a real event never happened.
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
 * The POST-TRADE snapshot, read from a `record_cycle` tool result.
 *
 * WHY IT EXISTS. `truthFrom` above reads `review_performance`, which runs EARLY in the cycle, so
 * its cash figure is PRE-TRADE. The report correctly states the cash left AFTER the day's orders,
 * so grading that sentence against the pre-trade figure produced a guaranteed false "the cash is
 * misstated" finding on every cycle that traded (129.99 - 15 = 114.99 is the report being right,
 * not wrong). `record_cycle` runs LAST and does its own fresh broker fetch, so the equity and
 * free cash it recorded are the only figures that describe the account after trading.
 *
 * Returns null when the tool recorded nothing usable (it swallows broker/memory failures and
 * returns `{recorded:false}`), so the pre-trade figures remain the best available truth rather
 * than being replaced by a guess. Each half is independent: a partial snapshot keeps what it has.
 */
export function postTradeTruthFrom(
  output: unknown,
): { accountValueGbp?: number; cashGbp?: number } | null {
  if (typeof output !== "object" || output === null) return null;
  const raw = output as Record<string, unknown>;
  const accountValueGbp = finiteOrNull(raw.accountValueGbp);
  const cashGbp = finiteOrNull(raw.cashGbp);
  if (accountValueGbp === null && cashGbp === null) return null;
  return {
    ...(accountValueGbp !== null ? { accountValueGbp } : {}),
    ...(cashGbp !== null ? { cashGbp } : {}),
  };
}

/**
 * BOUNDS on every collection recorded below. A trace document must stay small and predictable
 * (Convex caps a document at 1MB), and a bound that is silently exceeded is worse than a small
 * one: past the cap the extractor sets `truncated`, the hook warns, and the judge is told the
 * collection is incomplete so absence there proves nothing. Same contract as the 200-tool cap in
 * convex/traceAppend.ts. A real cycle sits far below all four.
 */
export const MAX_TRACE_ORDERS = 30;
export const MAX_TRACE_EXITS = 30;
export const MAX_TRACE_POSITIONS = 30;
export const MAX_TRACE_HOLDINGS = 30;

/** Longest stored free-text detail on an order or an exit, so one string cannot bloat the row. */
const MAX_DETAIL_CHARS = 200;

/** One order the cycle attempted, as recorded for the judge. */
export interface TracedOrder {
  ticker: string;
  side: string;
  notionalGbp?: number;
  /** "placed" | "simulated" (dry run) | "skipped" | "rejected". */
  status: string;
  strategyTag?: string;
  /** Why it was skipped or rejected. */
  detail?: string;
}

/** One exit the exit engine triggered, as recorded for the judge. */
export interface TracedExit {
  ticker: string;
  reason: string;
  detail?: string;
}

/** One ADVISORY-ONLY external holding, with its GBP figures under NAMED fields. */
export interface TracedExternalHolding {
  ticker: string;
  currentValueGbp?: number;
  costBasisGbp?: number;
  unrealisedPnlGbp?: number;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function detailOf(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text === null ? undefined : text.slice(0, MAX_DETAIL_CHARS);
}

/**
 * Every order this cycle placed, simulated, skipped or had rejected, read from a `submit_orders`
 * result. Returns null when the output is not one (nothing was recorded), which the judge is told
 * apart from an EMPTY list (nothing was attempted): absence of data is not evidence that a
 * reported order was invented, whereas a genuinely empty list is.
 */
export function ordersFrom(
  output: unknown,
): { orders: TracedOrder[]; truncated: boolean } | null {
  if (typeof output !== "object" || output === null) return null;
  const { placed, rejected } = output as { placed?: unknown; rejected?: unknown };
  if (!Array.isArray(placed) || !Array.isArray(rejected)) return null;

  const orders: TracedOrder[] = [];
  let truncated = false;
  const push = (entry: TracedOrder): void => {
    if (orders.length >= MAX_TRACE_ORDERS) {
      truncated = true;
      return;
    }
    orders.push(entry);
  };

  for (const row of placed) {
    const order = orderFrom(row);
    if (!order) continue;
    const skipped = detailOf((row as { skipped?: unknown }).skipped);
    const simulated = (row as { dryRun?: unknown }).dryRun === true;
    push({
      ...order,
      status: skipped !== undefined ? "skipped" : simulated ? "simulated" : "placed",
      ...(skipped !== undefined ? { detail: skipped } : {}),
    });
  }
  for (const row of rejected) {
    const order = orderFrom(row);
    if (!order) continue;
    const reason = detailOf((row as { reason?: unknown }).reason);
    push({
      ...order,
      status: "rejected",
      ...(reason !== undefined ? { detail: reason } : {}),
    });
  }
  return { orders, truncated };
}

/** The proposal fields shared by a placed and a rejected row, or null when unreadable. */
function orderFrom(row: unknown): Omit<TracedOrder, "status"> | null {
  if (typeof row !== "object" || row === null) return null;
  const proposal = (row as { proposal?: unknown }).proposal;
  if (typeof proposal !== "object" || proposal === null) return null;
  const raw = proposal as Record<string, unknown>;
  const ticker = nonEmptyString(raw.ticker);
  const side = nonEmptyString(raw.side);
  if (ticker === null || side === null) return null;
  const notional = finiteOrNull(raw.notional);
  const strategyTag = nonEmptyString(raw.strategyTag);
  return {
    ticker,
    side,
    ...(notional !== null ? { notionalGbp: notional } : {}),
    ...(strategyTag !== null ? { strategyTag } : {}),
  };
}

/**
 * The exits the exit engine triggered this cycle, read from a `manage_positions` result. An exit
 * closes the originating BUY row rather than writing a SELL row, so without this the judge had no
 * way to confirm a reported "automatic sale" ever happened.
 */
export function exitsFrom(
  output: unknown,
): { exits: TracedExit[]; truncated: boolean } | null {
  if (typeof output !== "object" || output === null) return null;
  const signals = (output as { exitsTriggered?: unknown }).exitsTriggered;
  if (!Array.isArray(signals)) return null;
  const exits: TracedExit[] = [];
  let truncated = false;
  for (const signal of signals) {
    if (typeof signal !== "object" || signal === null) continue;
    const raw = signal as Record<string, unknown>;
    const ticker = nonEmptyString(raw.ticker);
    const reason = nonEmptyString(raw.reason);
    if (ticker === null || reason === null) continue;
    if (exits.length >= MAX_TRACE_EXITS) {
      truncated = true;
      continue;
    }
    const detail = detailOf(raw.detail);
    exits.push({ ticker, reason, ...(detail !== undefined ? { detail } : {}) });
  }
  return { exits, truncated };
}

/**
 * The held position list from a `review_performance` result: the tickers, bounded, plus the EXACT
 * count. The count is deliberately the full length even when the ticker list was truncated, so a
 * report stating "10 stocks" stays checkable.
 */
export function positionsFrom(
  output: unknown,
): { tickers: string[]; count: number; truncated: boolean } | null {
  if (typeof output !== "object" || output === null) return null;
  const positions = (output as { openPositions?: unknown }).openPositions;
  if (!Array.isArray(positions)) return null;
  const tickers: string[] = [];
  // Counted from READABLE rows only. Counting a malformed row would inflate the count and could
  // convict a report that correctly said "10 stocks", which is the opposite of the point.
  let count = 0;
  for (const position of positions) {
    if (typeof position !== "object" || position === null) continue;
    const ticker = nonEmptyString((position as { ticker?: unknown }).ticker);
    if (ticker === null) continue;
    count += 1;
    if (tickers.length < MAX_TRACE_POSITIONS) tickers.push(ticker);
  }
  return { tickers, count, truncated: count > tickers.length };
}

/**
 * A compact ticker-to-price map from a `get_prices` result, so a price quoted in the report can
 * be checked against the quote the cycle actually saw. Prices are in the instrument's own
 * currency (USD for US stocks), NOT GBP, and are never compared against the GBP ground truth.
 *
 * Cumulative bounding happens where the stored map is visible (convex/traceAppend.ts): a cycle
 * calls get_prices several times and later batches must not erase earlier ones.
 */
export function quotesFrom(output: unknown): Record<string, number> {
  if (typeof output !== "object" || output === null) return {};
  const quotes = (output as { quotes?: unknown }).quotes;
  if (!Array.isArray(quotes)) return {};
  const map: Record<string, number> = {};
  for (const quote of quotes) {
    if (typeof quote !== "object" || quote === null) continue;
    const raw = quote as Record<string, unknown>;
    const symbol = nonEmptyString(raw.symbol);
    const price = finiteOrNull(raw.price);
    if (symbol === null || price === null) continue;
    map[symbol] = price;
  }
  return map;
}

/**
 * Each ADVISORY-ONLY external holding with its GBP figures under NAMED fields, read from a
 * `review_external_holdings` result. This is the form the JUDGE gets.
 *
 * `externalGbpValuesFrom` below stays exactly as it is: that bare array is the magnitude
 * allow-list for the deterministic rule in report-check.ts, and the two are not
 * interchangeable. Handing the bare array to the judge is what made it read the allow-list as a
 * required-content checklist and penalise a report for "omitting" a cost basis it never owed the
 * reader. A missing figure is omitted rather than zero-filled: the quote can fail, and an
 * invented 0 would be worse than an absent field.
 */
export function externalHoldingsFrom(output: unknown): {
  holdings: TracedExternalHolding[];
  truncated: boolean;
} {
  if (typeof output !== "object" || output === null) return { holdings: [], truncated: false };
  const rows = (output as { holdings?: unknown }).holdings;
  if (!Array.isArray(rows)) return { holdings: [], truncated: false };
  const holdings: TracedExternalHolding[] = [];
  let truncated = false;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const raw = row as Record<string, unknown>;
    const ticker = nonEmptyString(raw.ticker);
    if (ticker === null) continue;
    if (holdings.length >= MAX_TRACE_HOLDINGS) {
      truncated = true;
      continue;
    }
    const currentValueGbp = finiteOrNull(raw.valueGbp);
    const costBasisGbp = finiteOrNull(raw.costBasisGbp);
    const unrealisedPnlGbp = finiteOrNull(raw.unrealisedPnlGbp);
    holdings.push({
      ticker,
      ...(currentValueGbp !== null ? { currentValueGbp } : {}),
      ...(costBasisGbp !== null ? { costBasisGbp } : {}),
      ...(unrealisedPnlGbp !== null ? { unrealisedPnlGbp } : {}),
    });
  }
  return { holdings, truncated };
}

/**
 * GBP magnitudes the report may legitimately quote even though they dwarf the trading
 * account: each ADVISORY-ONLY external holding's value, cost basis and unrealised P&L, read
 * from a `review_external_holdings` tool result. Instrument-currency prices are deliberately
 * excluded: they are USD and are never compared against GBP ground truth.
 *
 * ALLOW-LIST, not a checklist: it exists so the magnitude rule in report-check.ts does not fire
 * on the "Your other account" section. It is never handed to the judge as a list of figures the
 * report is required to contain (see `externalHoldingsFrom` above).
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
