import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkReportNumbers,
  parseGbpFigures,
  parseHoldingsCounts,
  type ReportTruth,
} from "./report-check.ts";

// The real account, as of the incident this check exists to prevent.
const TRUTH: ReportTruth = {
  accountValueGbp: 248.16,
  cashGbp: 12.4,
  deployedGbp: 235.76,
};

/** The external advisory holding is ~32x the trading account and legitimately in the report. */
const WITH_EXTERNAL: ReportTruth = { ...TRUTH, externalGbpValues: [7912.44] };

function rules(findings: { rule: string }[]): string[] {
  return findings.map((f) => f.rule);
}

// --- the parser ---

test("parses the pound sign, plain and with pence", () => {
  assert.deepEqual(parseGbpFigures("Your account is worth £248.16 today."), [248.16]);
  assert.deepEqual(parseGbpFigures("£248"), [248]);
});

test("parses the GBP prefix with and without a space", () => {
  assert.deepEqual(parseGbpFigures("GBP 248.16"), [248.16]);
  assert.deepEqual(parseGbpFigures("GBP248.16"), [248.16]);
  assert.deepEqual(parseGbpFigures("gbp 248.16"), [248.16]);
});

test("parses the GBP suffix form", () => {
  assert.deepEqual(parseGbpFigures("Account value: 248.16 GBP"), [248.16]);
});

test("does not double-count a figure wrapped in both forms", () => {
  assert.deepEqual(parseGbpFigures("£248.16 GBP"), [248.16]);
});

test("parses thousands separators", () => {
  assert.deepEqual(parseGbpFigures("£7,912.44"), [7912.44]);
  assert.deepEqual(parseGbpFigures("£1,234,567.89"), [1234567.89]);
});

test("parses figures inside bold markdown and other punctuation", () => {
  assert.deepEqual(parseGbpFigures("Bottom line: **£248.16** (flat)."), [248.16]);
  assert.deepEqual(parseGbpFigures("- worth £248.16, up a little"), [248.16]);
  assert.deepEqual(parseGbpFigures("(£248.16)"), [248.16]);
});

test("parses negative figures written either side of the symbol", () => {
  assert.deepEqual(parseGbpFigures("down £-12.50"), [-12.5]);
  assert.deepEqual(parseGbpFigures("-£12.50"), [-12.5]);
  assert.deepEqual(parseGbpFigures("-12.50 GBP"), [-12.5]);
});

test("returns every figure, in order, across a multi-line report", () => {
  const report = "Worth £248.16.\nCash £12.40.\nInvested **£235.76**.";
  assert.deepEqual(parseGbpFigures(report), [248.16, 12.4, 235.76]);
});

test("ignores USD figures and bare numbers", () => {
  assert.deepEqual(parseGbpFigures("Exxon at $173.79, up 4% on 12 shares"), []);
  assert.deepEqual(parseGbpFigures("no money here at all"), []);
});

test("does not invent a figure from a currency pair or a word starting with GBP", () => {
  assert.deepEqual(parseGbpFigures("GBP/USD is 1.34 right now"), []);
  assert.deepEqual(parseGbpFigures("GBPUSD"), []);
});

test("ignores a lone symbol with no number", () => {
  assert.deepEqual(parseGbpFigures("costs £ and pence"), []);
});

test("parses explicit numeric holdings counts", () => {
  assert.deepEqual(parseHoldingsCounts("You hold 8 holdings across 9 positions."), [8, 9]);
  assert.deepEqual(parseHoldingsCounts("No count is stated here."), []);
});

// --- rule 1: account-value-present (the GBP 282 bug) ---

test("THE INCIDENT: a report claiming 282 when the account is 248 is caught", () => {
  const bad =
    "Bottom line: your account is worth about **£282.00** today, up a bit. " +
    "I bought a little Exxon (XOM) and sold nothing.";
  const result = checkReportNumbers(bad, TRUTH);
  assert.equal(result.pass, false);
  assert.ok(rules(result.findings).includes("account-value-present"));
  assert.match(result.findings[0].detail, /248\.16/);
});

test("a report quoting the authoritative figure passes", () => {
  const good =
    "Bottom line: your account is worth **£248.16** today. Cash sitting spare: £12.40.";
  assert.deepEqual(checkReportNumbers(good, TRUTH), { pass: true, findings: [] });
});

test("rounding to the nearest pound is within tolerance", () => {
  assert.equal(checkReportNumbers("Worth £248 today.", TRUTH).pass, true);
});

test("tolerance is the greater of GBP 1 and 0.5 percent", () => {
  // Small account: the GBP 1 floor applies (0.5% of 248.16 is only 1.24).
  assert.equal(checkReportNumbers("Worth £249.10.", TRUTH).pass, true);
  assert.equal(checkReportNumbers("Worth £252.00.", TRUTH).pass, false);
  // Large account: the percentage dominates the floor.
  const big: ReportTruth = { accountValueGbp: 100_000, cashGbp: 0, deployedGbp: 100_000 };
  assert.equal(checkReportNumbers("Worth £100,400.", big).pass, true);
  assert.equal(checkReportNumbers("Worth £101,000.", big).pass, false);
});

test("a report with no GBP figure at all fails the account-value rule", () => {
  const result = checkReportNumbers("Quiet day. I did not trade.", TRUTH);
  assert.equal(result.pass, false);
  assert.deepEqual(rules(result.findings), ["account-value-present"]);
});

// --- rule 2: no-implausible-figure, and the external-holdings exception ---

test("an inflated account total above 1.5x is caught as implausible", () => {
  // Contains the right figure too, so only the magnitude rule should fire.
  const report = "Worth £248.16 today, though the total portfolio is £8,160.60.";
  const result = checkReportNumbers(report, TRUTH);
  assert.equal(result.pass, false);
  assert.deepEqual(rules(result.findings), ["no-implausible-figure"]);
  assert.match(result.findings[0].detail, /8160\.6|8,160\.60/);
});

test("ESSENTIAL: the legitimate external advisory figure is allowed through", () => {
  const report =
    "Your trading account is worth **£248.16**.\n\n" +
    "Your other account: the Shopify (SHOP) holding is worth about £7,912.44 " +
    "against a cost of £9,982.65, so it is down £2,070.21 so far.";
  // 9982.65 is also an allowed magnitude: the cost basis of the same external holding.
  const truth: ReportTruth = {
    ...TRUTH,
    externalGbpValues: [7912.44, 9982.65, 2070.21],
  };
  assert.deepEqual(checkReportNumbers(report, truth), { pass: true, findings: [] });
});

test("without the exception the same legitimate report would fire every cycle", () => {
  // Pinning WHY the exception exists: this is the false alarm we must not ship.
  const report = "Worth £248.16. Your other account holds about £7,912.44 of Shopify.";
  assert.equal(checkReportNumbers(report, TRUTH).pass, false);
  assert.equal(checkReportNumbers(report, WITH_EXTERNAL).pass, true);
});

test("an external figure is matched within tolerance, not exactly", () => {
  const report = "Worth £248.16. Your other account holds about £7,912 of Shopify.";
  assert.equal(checkReportNumbers(report, WITH_EXTERNAL).pass, true);
});

test("a bogus figure is still caught when external holdings are allowed", () => {
  const report =
    "Worth £248.16. Your other account holds £7,912.44 of Shopify. " +
    "Total across everything: £8,160.60.";
  const result = checkReportNumbers(report, WITH_EXTERNAL);
  assert.equal(result.pass, false);
  assert.deepEqual(rules(result.findings), ["no-implausible-figure"]);
});

test("figures at or below 1.5x the account value are not flagged", () => {
  const atLimit = TRUTH.accountValueGbp * 1.5;
  const result = checkReportNumbers(`Worth £248.16, and a note about £${atLimit}.`, TRUTH);
  assert.deepEqual(result.findings, []);
});

test("magnitude is judged on absolute value, so a large loss is caught too", () => {
  const result = checkReportNumbers("Worth £248.16, down £-8,000.00 overall.", TRUTH);
  assert.deepEqual(rules(result.findings), ["no-implausible-figure"]);
});

test("one finding is reported per offending figure", () => {
  const report = "Worth £248.16 but also £5,000.00 and £9,000.00.";
  const result = checkReportNumbers(report, TRUTH);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(rules(result.findings), [
    "no-implausible-figure",
    "no-implausible-figure",
  ]);
});

test("both rules can fire on the same report", () => {
  const result = checkReportNumbers("Your portfolio is worth £8,160.60.", TRUTH);
  assert.deepEqual(rules(result.findings), [
    "account-value-present",
    "no-implausible-figure",
  ]);
});

// --- degenerate ground truth ---

test("a non-positive or non-finite account value yields no findings rather than false alarms", () => {
  for (const accountValueGbp of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = checkReportNumbers("Worth £282.00.", {
      accountValueGbp,
      cashGbp: 0,
      deployedGbp: 0,
    });
    assert.deepEqual(result, { pass: true, findings: [] });
  }
});

test("a non-finite external allowance never silently widens the magnitude rule", () => {
  const result = checkReportNumbers("Worth £248.16 and £9,000.00.", {
    ...TRUTH,
    externalGbpValues: [Number.NaN],
  });
  assert.deepEqual(rules(result.findings), ["no-implausible-figure"]);
});

test("an empty report is a finding, not a crash", () => {
  assert.equal(checkReportNumbers("", TRUTH).pass, false);
});

test("checkReportNumbers is pure: the same inputs give the same answer", () => {
  const report = "Worth £248.16.";
  assert.deepEqual(checkReportNumbers(report, TRUTH), checkReportNumbers(report, TRUTH));
});

// --- rule 3: stated holdings count must match the captured ticker list ---

const NINE_TICKERS = ["MOD", "NDSN", "HII", "JPM", "AAP", "TRMB", "HD", "YETI", "AMD"];

test("REGRESSION: 8 holdings against 9 ground-truth tickers is a violation", () => {
  const result = checkReportNumbers("Account value £248.16. You have 8 holdings.", {
    ...TRUTH,
    positionTickers: NINE_TICKERS,
  });

  assert.equal(result.pass, false);
  assert.deepEqual(rules(result.findings), ["holdings-count-matches-tickers"]);
  assert.match(result.findings[0].detail, /8 holdings/);
  assert.match(result.findings[0].detail, /9 position tickers/);
});

test("a holdings count matching the ground-truth ticker list is not a violation", () => {
  const result = checkReportNumbers("Account value £248.16. You have 9 holdings.", {
    ...TRUTH,
    positionTickers: NINE_TICKERS,
  });

  assert.deepEqual(result, { pass: true, findings: [] });
});

test("a report that states no holdings count is not penalised", () => {
  const result = checkReportNumbers("Account value £248.16. Positions remain unchanged.", {
    ...TRUTH,
    positionTickers: NINE_TICKERS,
  });

  assert.deepEqual(result, { pass: true, findings: [] });
});
