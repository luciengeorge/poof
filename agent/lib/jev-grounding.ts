import type { JevClient } from "./jev.ts";

/**
 * A second opinion on the report judge's grounding score, from Jev, recorded beside it.
 *
 * The weekly judge is an LLM reading a report against stored ground truth and returning a 1..5
 * grounding score. That is exactly the "does the cited material support the claims" check that
 * TypeSafe's own citation-check cookbook is built for, so Jev is asked the same thing as two
 * probabilities and the answers sit next to the LLM's score on the same cycle. Nothing here
 * changes the LLM score, the thresholds, or whether an alert fires. In a few weeks the pair says
 * whether a cheap calibrated check tracks the expensive one, which is what would justify leaning
 * on it.
 */

export interface JevGrounding {
  /** Probability the report's numeric and factual claims are supported by the ground truth. */
  supported: number;
  /** Probability the report states something the ground truth contradicts. */
  contradicted: number;
  model: string;
}

export async function jevGroundingCheck(
  jev: JevClient,
  input: { reportText: string; groundTruth: unknown; coverage?: unknown },
  logger: Pick<Console, "warn"> = console,
): Promise<JevGrounding | undefined> {
  if (!input.reportText.trim()) return undefined;
  try {
    const res = await jev.ask(
      { report: input.reportText, groundTruth: input.groundTruth, coverage: input.coverage ?? null },
      {
        supported: {
          type: "noul",
          instructions: "Are the numeric and factual claims in the report supported by the ground truth?",
          criteria: {
            true: "Every figure and fact the report states appears in, or follows from, the ground truth.",
            false: "At least one stated figure or fact has no basis in the ground truth.",
          },
        },
        contradicted: {
          type: "noul",
          instructions: "Does the report state any figure or fact that the ground truth contradicts?",
        },
      },
    );
    return { supported: res.answers.supported.noul, contradicted: res.answers.contradicted.noul, model: res.model };
  } catch (err) {
    logger.warn("[jev] grounding check unavailable:", err);
    return undefined;
  }
}
