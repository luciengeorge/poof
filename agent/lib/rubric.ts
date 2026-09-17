import { heldThroughEarnings } from "./earnings.ts";
import type { JevClient } from "./jev.ts";

/**
 * A deterministic risk rubric for a trade thesis, run BEFORE the LLM red team.
 *
 * WHY. The LLM reviewer drifted. Its prompt asked whether size was proportionate to "the
 * (usually weak) conviction", and over seven weeks nearly every verdict became "shrink to a £5
 * probe", which left a positively-expectant strategy flat. The judgement calls it was making
 * (already priced in, does the catalyst move this stock, is there substance, is a binary event
 * inside the hold window) are yes/no questions over text. Jev answers those as calibrated
 * probabilities, the same way every day, and the verdict is then a RULE written here, with a
 * number beside each reason, that a test can pin. The LLM keeps only the coherence veto.
 *
 * The binary-event question is not asked of Jev at all: the earnings calendar and the hold window
 * are known, so that one is arithmetic.
 */

export interface RubricInput {
  ticker: string;
  thesis: string;
  strategyTag?: string;
  nextEarnings?: { date: string; daysUntil: number } | null;
  maxHoldDays?: number;
  /** How old the underlying news is, if known. Passed to Jev as context for "priced in". */
  newsAgeHours?: number;
}

export interface RubricAnswers {
  pricedIn: number;
  catalystConnects: number;
  substance: number;
}

export type RubricVerdict = "keep" | "shrink" | "veto";

export interface RubricResult {
  verdict: RubricVerdict;
  reasons: string[];
  answers: RubricAnswers;
  binaryEventInWindow: boolean;
  model: string;
}

// Thresholds, each with the one reason it exists. Change one here and a test says so.
/** Below this the stated catalyst does not plausibly move this stock: the thesis is about something else. */
export const RUBRIC_VETO_CONNECTS_BELOW = 0.35;
/** Below this there is no specific, verifiable catalyst, only narrative. */
export const RUBRIC_VETO_SUBSTANCE_BELOW = 0.3;
/** Above this the market has most likely already repriced; an LLM reacting to public news has no edge left. */
export const RUBRIC_SHRINK_PRICED_ABOVE = 0.7;
/** Below these the thesis is plausible but not strong: proceed smaller, never at the floor's expense. */
export const RUBRIC_SHRINK_CONNECTS_BELOW = 0.55;
export const RUBRIC_SHRINK_SUBSTANCE_BELOW = 0.55;

const pct = (x: number) => x.toFixed(2);

/** Pure. The whole verdict policy, so it can be tested at every boundary without a network. */
export function rubricVerdict(
  answers: RubricAnswers,
  binaryEventInWindow: boolean,
  strategyTag?: string,
): { verdict: RubricVerdict; reasons: string[] } {
  const reasons: string[] = [];
  let verdict: RubricVerdict = "keep";

  if (binaryEventInWindow && strategyTag !== "earnings-play") {
    verdict = "veto";
    reasons.push("earnings print inside the hold window and this is not sized as an earnings play");
  }
  if (answers.catalystConnects < RUBRIC_VETO_CONNECTS_BELOW) {
    verdict = "veto";
    reasons.push(`catalyst does not connect to this stock: ${pct(answers.catalystConnects)} < ${RUBRIC_VETO_CONNECTS_BELOW}`);
  }
  if (answers.substance < RUBRIC_VETO_SUBSTANCE_BELOW) {
    verdict = "veto";
    reasons.push(`no specific catalyst: substance ${pct(answers.substance)} < ${RUBRIC_VETO_SUBSTANCE_BELOW}`);
  }
  if (verdict === "veto") return { verdict, reasons };

  if (answers.pricedIn > RUBRIC_SHRINK_PRICED_ABOVE) {
    verdict = "shrink";
    reasons.push(`priced in: ${pct(answers.pricedIn)} > ${RUBRIC_SHRINK_PRICED_ABOVE}`);
  }
  if (answers.catalystConnects < RUBRIC_SHRINK_CONNECTS_BELOW) {
    verdict = "shrink";
    reasons.push(`catalyst connection only ${pct(answers.catalystConnects)} < ${RUBRIC_SHRINK_CONNECTS_BELOW}`);
  }
  if (answers.substance < RUBRIC_SHRINK_SUBSTANCE_BELOW) {
    verdict = "shrink";
    reasons.push(`substance only ${pct(answers.substance)} < ${RUBRIC_SHRINK_SUBSTANCE_BELOW}`);
  }
  return { verdict, reasons };
}

export function binaryEventInWindow(input: Pick<RubricInput, "nextEarnings" | "maxHoldDays">): boolean {
  const next = input.nextEarnings;
  if (!next) return false;
  return heldThroughEarnings(
    { date: next.date, daysUntil: next.daysUntil, hour: "", epsEstimate: null },
    { maxHoldDays: input.maxHoldDays },
  );
}

export async function rubricCheck(
  jev: JevClient,
  input: RubricInput,
  logger: Pick<Console, "warn"> = console,
): Promise<RubricResult | undefined> {
  const binary = binaryEventInWindow(input);
  try {
    const res = await jev.ask(
      {
        ticker: input.ticker,
        thesis: input.thesis,
        strategyTag: input.strategyTag ?? null,
        newsAgeHours: input.newsAgeHours ?? null,
        nextEarnings: input.nextEarnings ?? null,
      },
      {
        pricedIn: {
          type: "noul",
          instructions: "Has the market most likely already repriced for the catalyst in this thesis?",
          criteria: {
            true: "The information is widely reported, hours old, or the reaction is already described.",
            false: "The catalyst is fresh and its implications are not yet reflected in the price.",
          },
        },
        catalystConnects: {
          type: "noul",
          instructions: "Does the stated catalyst plausibly move THIS specific stock in the proposed direction?",
        },
        substance: {
          type: "noul",
          instructions:
            "Is there a specific, verifiable catalyst here rather than excitement, momentum, or a vague narrative?",
        },
      },
    );
    const answers: RubricAnswers = {
      pricedIn: res.answers.pricedIn.noul,
      catalystConnects: res.answers.catalystConnects.noul,
      substance: res.answers.substance.noul,
    };
    const { verdict, reasons } = rubricVerdict(answers, binary, input.strategyTag);
    return { verdict, reasons, answers, binaryEventInWindow: binary, model: res.model };
  } catch (err) {
    logger.warn(`[jev] rubric check unavailable for ${input.ticker}:`, err);
    return undefined;
  }
}
