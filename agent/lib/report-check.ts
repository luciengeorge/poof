/**
 * Self-consistency check between what the agent SAID in its Slack report and what the code
 * COMPUTED from the broker.
 *
 * WHY THIS EXISTS. A production report once stated the account was worth about GBP 282 when
 * it was GBP 248: the model hand-summed USD position values onto GBP cash instead of quoting
 * `accountValueGbp`. Nothing compared the number in the prose against the number in the
 * tool result, so a human reading Slack was the only detector. This module is that comparison.
 *
 * Pure and heavily tested: no I/O, no clock, no environment. It is an OBSERVER. A finding
 * raises an alert and NEVER blocks, resizes, or otherwise alters a trade.
 */

/** Ground truth for one cycle, taken from the tools that already compute it. */
export interface ReportTruth {
  /**
   * The account value AFTER the cycle's trades, when record_cycle observed one. Either stage
   * satisfies `account-value-present`: see the rule for why accepting both cannot weaken it.
   */
  postTradeAccountValueGbp?: number;
  /** The single authoritative account value (agent/lib/execution.ts accountValueGbp). */
  accountValueGbp: number;
  cashGbp: number;
  deployedGbp: number;
  /**
   * GBP magnitudes that legitimately exceed the trading account: the ADVISORY-ONLY external
   * holdings' values / costs / P&L. One of them is ~32x the Trading 212 account, so without
   * this allowance the magnitude rule below would fire on every single cycle that includes
   * the "Your other account" section, and the alert would be trained into noise.
   */
  externalGbpValues?: number[];
  /**
   * Captured position tickers. When present and complete, their length is the deterministic
   * source for a holdings count stated in the report.
   */
  positionTickers?: string[];
  /** A capped ticker list cannot prove a report's holdings count is wrong. */
  positionsTruncated?: boolean;
}

export interface ReportFinding {
  rule: string;
  detail: string;
}

export interface ReportCheckResult {
  pass: boolean;
  findings: ReportFinding[];
}

/** A figure is "the same number" within max(GBP 1, 0.5 percent) of the expected value. */
function tolerance(expected: number): number {
  return Math.max(1, Math.abs(expected) * 0.005);
}

function matchesWithinTolerance(figure: number, expected: number): boolean {
  if (!Number.isFinite(expected)) return false;
  return Math.abs(figure - expected) <= tolerance(expected);
}

/** A number with optional thousands separators and optional pence. */
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

/** "248.16 GBP" -> "£248.16", so the single prefix parser below sees both written forms. */
const SUFFIX_FORM = new RegExp(String.raw`(-?(?:${NUMBER}))\s*GBP\b`, "gi");

/** "£248.16", "GBP 248.16", "GBP248", "-£12.50", "£-12.50", "**£1,234.56**". */
const PREFIX_FORM = new RegExp(String.raw`(-?)\s*(?:£|GBP)\s*(-?)(${NUMBER})`, "gi");

/** A plain numeric holdings count such as "8 holdings" or "9 positions". */
const HOLDINGS_COUNT_FORM = /\b(\d+)\s+(?:holdings?|positions?|stocks?)\b/gi;

/** Every explicit numeric holdings count in the report, in the order written. */
export function parseHoldingsCounts(text: string): number[] {
  const counts: number[] = [];
  for (const match of text.matchAll(HOLDINGS_COUNT_FORM)) {
    const count = Number(match[1]);
    if (Number.isSafeInteger(count)) counts.push(count);
  }
  return counts;
}

/**
 * Every GBP figure in the text, in the order written.
 *
 * Deliberately narrow: only figures explicitly marked as GBP (the pound sign or "GBP") are
 * returned. Share prices are quoted in the instrument currency with a dollar sign and must
 * NOT be compared against GBP ground truth, so a bare or dollar-denominated number is
 * ignored rather than guessed at.
 */
export function parseGbpFigures(text: string): number[] {
  const figures: number[] = [];
  // Rewrite the suffix form first so "£248.16 GBP" is one figure rather than two.
  const normalized = text.replace(SUFFIX_FORM, "£$1");
  for (const match of normalized.matchAll(PREFIX_FORM)) {
    const negative = match[1] === "-" || match[2] === "-";
    const value = Number(match[3].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    figures.push(negative ? -value : value);
  }
  return figures;
}

/**
 * Grade a report's GBP figures against the cycle's ground truth.
 *
 * Rules:
 *  1. `account-value-present`: the authoritative account value must actually appear.
 *  2. `no-implausible-figure`: no GBP figure may exceed 1.5x the account value, unless it
 *     matches an allowed external-holdings magnitude.
 */
export function checkReportNumbers(
  reportText: string,
  truth: ReportTruth,
): ReportCheckResult {
  const findings: ReportFinding[] = [];
  const { accountValueGbp } = truth;

  if (truth.positionTickers !== undefined && truth.positionsTruncated !== true) {
    const actual = truth.positionTickers.length;
    for (const stated of parseHoldingsCounts(reportText)) {
      if (stated === actual) continue;
      findings.push({
        rule: "holdings-count-matches-tickers",
        detail:
          `the report states ${stated} holdings, but the ground truth lists ${actual} position ` +
          `tickers: ${truth.positionTickers.join(", ")}`,
      });
    }
  }

  // Without a usable account value there is no money ground truth to compare against, and
  // inventing money findings from it would alert on a broker/FX outage that is already surfaced
  // elsewhere. The independent holdings-count check below can still use captured tickers.
  if (!Number.isFinite(accountValueGbp) || accountValueGbp <= 0) {
    return { pass: findings.length === 0, findings };
  }

  const figures = parseGbpFigures(reportText);

  // EITHER SNAPSHOT STAGE SATISFIES THIS RULE. The account value is fetched early (pre-trade) and
  // again by record_cycle after trading, and a report is legitimately written from either: the
  // pre-trade figure when nothing traded, the post-trade one when something did. Accepting both
  // cannot weaken what this rule exists to catch, because the GBP 282 incident matched NEITHER
  // figure. Insisting on one stage instead produced a guaranteed finding on every cycle that
  // traded, which is a false alarm rather than a defect.
  const acceptable = [accountValueGbp, truth.postTradeAccountValueGbp].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0,
  );
  if (!figures.some((figure) => acceptable.some((v) => matchesWithinTolerance(figure, v)))) {
    findings.push({
      rule: "account-value-present",
      detail:
        `the report never states the account value of GBP ${acceptable.join(" or GBP ")} ` +
        `(within GBP ${tolerance(accountValueGbp).toFixed(2)}); GBP figures found: ` +
        `${figures.length > 0 ? figures.join(", ") : "none"}`,
    });
  }

  const limit = accountValueGbp * 1.5;
  const allowed = truth.externalGbpValues ?? [];
  for (const figure of figures) {
    if (Math.abs(figure) <= limit) continue;
    if (allowed.some((value) => matchesWithinTolerance(Math.abs(figure), Math.abs(value)))) {
      continue;
    }
    findings.push({
      rule: "no-implausible-figure",
      detail:
        `GBP ${figure} exceeds 1.5x the account value (limit GBP ${limit.toFixed(2)}) and ` +
        `matches no external advisory holding`,
    });
  }

  return { pass: findings.length === 0, findings };
}

/** One-line summary for a log line or a Slack alert. */
export function summarizeFindings(findings: readonly ReportFinding[]): string {
  return findings.map((f) => `${f.rule}: ${f.detail}`).join("; ");
}
