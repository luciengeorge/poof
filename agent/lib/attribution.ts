/**
 * FAILURE ATTRIBUTION: which recurring patterns actually cost money, over the whole closed record.
 *
 * WHY THIS EXISTS. Reflection used to happen one cycle at a time, so a single bad day could install
 * a permanent rule. That is how an observation about one oil-price episode ended up standing as
 * durable guidance long after it stopped being true. SHARP (arXiv 2605.06822) attributes errors
 * across the WORST accumulated outcomes and requires a pattern to recur before it may motivate a
 * change; this module is that filter.
 *
 * The threshold is the point. Below `MIN_PATTERN_OCCURRENCES` nothing is reported at all, because
 * one or two losses are indistinguishable from variance on an account this small. Returning
 * "nothing qualifies" is the correct and expected answer most of the time, and it is much more
 * useful than a confident story about noise.
 *
 * HONESTY ABOUT WHAT THIS IS. These are CORRELATIONS over a tiny sample, not causes. A pattern here
 * is a place to look, never a proven mechanism, and the returned `note` says so in words that reach
 * the model and the weekly report rather than living only in this comment.
 *
 * Pure: no I/O, no clock, no environment. An OBSERVER: nothing here feeds the risk gate, sizing, or
 * order placement.
 */

/** The subset of a stored trade this module reasons about. */
export interface ClosedTradeLike {
  ticker: string;
  status: string;
  /** Entry price, in the instrument's own currency. */
  price: number;
  createdAt: number;
  closedAt?: number;
  /** Realised P&L in GBP. Absent means the outcome was never established. */
  pnl?: number;
  strategyTag?: string;
  redTeamVerdict?: string;
  exitPrice?: number;
  stopLossPct?: number;
  maxHoldDays?: number;
}

/**
 * How many times a pattern must recur before it is reported.
 *
 * SHARP requires an error pattern on >=3 of the worst days before the evolution agent may act on
 * it. Two is a coincidence on a portfolio this size.
 */
export const MIN_PATTERN_OCCURRENCES = 3;

export type FailureDimension =
  | "strategy"
  | "holding-period"
  | "exit-kind"
  | "red-team-verdict"
  | "ticker";

export interface FailurePattern {
  dimension: FailureDimension;
  key: string;
  /** How many losing closed trades share this key. */
  losses: number;
  /** Total realised loss across them, in GBP (negative). */
  totalPnl: number;
  /** A few instruments, so the pattern can be checked by hand. */
  examples: string[];
}

export interface AttributionResult {
  patterns: FailurePattern[];
  closedTrades: number;
  losingTrades: number;
  /** Trades that closed without an established outcome, so they can prove nothing. */
  unknownOutcomes: number;
  /** Plain-language statement of what this evidence can and cannot support. */
  note: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function holdingBucket(trade: ClosedTradeLike): string {
  const closed = trade.closedAt ?? trade.createdAt;
  const held = closed - trade.createdAt;
  if (held < WEEK_MS) return "under-1-week";
  if (held < 2 * WEEK_MS) return "1-to-2-weeks";
  return "over-2-weeks";
}

/**
 * Why did this losing trade end?
 *
 * Inferred rather than stored, because the exit reason lives on the cycle trace and not on the
 * trade row. A trade that ran to its time limit while barely moving is a very different failure
 * from one that hit its stop: the first says the thesis never played out (a selection or patience
 * problem), the second says the thesis was wrong (a sizing or timing problem). Conflating them
 * produces useless lessons.
 */
function exitKind(trade: ClosedTradeLike): string | undefined {
  const { price, exitPrice, stopLossPct, maxHoldDays, closedAt, createdAt } = trade;
  if (exitPrice !== undefined && stopLossPct !== undefined && price > 0) {
    // A small tolerance: a stop fills at or slightly through its trigger.
    if (exitPrice <= price * (1 - stopLossPct) * 1.005) return "stop-loss";
  }
  if (maxHoldDays !== undefined && closedAt !== undefined) {
    const heldDays = (closedAt - createdAt) / (24 * 60 * 60 * 1000);
    if (heldDays >= maxHoldDays - 0.5) return "max-hold";
  }
  return undefined;
}

function group(
  losers: readonly ClosedTradeLike[],
  dimension: FailureDimension,
  keyOf: (t: ClosedTradeLike) => string | undefined,
): FailurePattern[] {
  const buckets = new Map<string, ClosedTradeLike[]>();
  for (const trade of losers) {
    const key = keyOf(trade);
    if (key === undefined) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(trade);
    else buckets.set(key, [trade]);
  }
  const patterns: FailurePattern[] = [];
  for (const [key, trades] of buckets) {
    if (trades.length < MIN_PATTERN_OCCURRENCES) continue;
    patterns.push({
      dimension,
      key,
      losses: trades.length,
      totalPnl: trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0),
      examples: [...new Set(trades.map((t) => t.ticker))].slice(0, 4),
    });
  }
  return patterns;
}

/**
 * Find recurring failure patterns across the closed record.
 *
 * Only losing, CLOSED trades with an established outcome are considered: an open position's paper
 * loss is not a failure yet, and a trade that closed with an unknown result cannot argue either
 * way. Both are counted and reported so a thin evidence base is visible rather than implied.
 */
export function attributeFailures(
  trades: readonly ClosedTradeLike[],
  opts: { minOccurrences?: number } = {},
): AttributionResult {
  const min = opts.minOccurrences ?? MIN_PATTERN_OCCURRENCES;
  const closed = trades.filter((t) => t.closedAt !== undefined || t.status.startsWith("closed"));
  const withOutcome = closed.filter((t) => typeof t.pnl === "number");
  const unknownOutcomes = closed.length - withOutcome.length;
  const losers = withOutcome.filter((t) => (t.pnl ?? 0) < 0);

  const patterns = [
    ...group(losers, "strategy", (t) => t.strategyTag),
    ...group(losers, "holding-period", holdingBucket),
    ...group(losers, "exit-kind", exitKind),
    ...group(losers, "red-team-verdict", (t) => t.redTeamVerdict),
    ...group(losers, "ticker", (t) => t.ticker),
  ]
    .filter((p) => p.losses >= min)
    // Worst bleed first: the point is to look where the money actually went.
    .sort((a, b) => a.totalPnl - b.totalPnl);

  const note = buildNote({
    closed: withOutcome.length,
    losers: losers.length,
    unknownOutcomes,
    patterns: patterns.length,
    min,
  });

  return {
    patterns,
    closedTrades: withOutcome.length,
    losingTrades: losers.length,
    unknownOutcomes,
    note,
  };
}

function buildNote(x: {
  closed: number;
  losers: number;
  unknownOutcomes: number;
  patterns: number;
  min: number;
}): string {
  const parts: string[] = [
    `${x.closed} closed trades with a known outcome, of which ${x.losers} lost money.`,
  ];
  if (x.unknownOutcomes > 0) {
    parts.push(
      `${x.unknownOutcomes} closed with an UNKNOWN outcome and prove nothing either way.`,
    );
  }
  if (x.patterns === 0) {
    parts.push(
      `No failure pattern recurs at least ${x.min} times, so there is NOT ENOUGH EVIDENCE to ` +
        "change a standing rule. This is the normal result on a record this short: one or two " +
        "losses cannot be told apart from variance, and inventing a lesson from them is how a " +
        "rule based on noise gets made permanent.",
    );
  } else {
    parts.push(
      `${x.patterns} pattern(s) recur at least ${x.min} times. These are CORRELATIONS over a ` +
        "small sample, not proven causes: treat each as somewhere to look, and prefer a lesson " +
        "that names a MECHANISM (how the broker or the tooling behaves) over one that generalises " +
        "about a market.",
    );
  }
  return parts.join(" ");
}
