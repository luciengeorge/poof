import type { JevClient } from "./jev.ts";

/**
 * Is a proposed memory edit a durable lesson, or a one-off dressed up as a rule?
 *
 * Memory is a small fixed number of slots, and the gate that protects them is an LLM told to be
 * hard to please. This asks Jev the same question as one probability and attaches it to the
 * gate's decision, so the two can be compared over time. It does not admit or refuse anything:
 * the memory policy in code and the LLM gate keep that job.
 */

export interface JevDurability {
  /** Probability this is a durable, generalisable lesson rather than a single outcome restated. */
  durable: number;
  model: string;
}

export async function jevDurabilityCheck(
  jev: JevClient,
  input: { condition: string; action: string; reason?: string },
  logger: Pick<Console, "warn"> = console,
): Promise<JevDurability | undefined> {
  try {
    const res = await jev.ask(
      { condition: input.condition, action: input.action, reason: input.reason ?? null },
      {
        durable: {
          type: "noul",
          instructions:
            "Is this a durable, generalisable lesson about how to trade, rather than a one-off outcome or a restatement of a statistic?",
          criteria: {
            true: "A rule that would still apply in a different week, market, or ticker.",
            false: "A single result, a number that recomputes anyway, or a reaction to one bad day.",
          },
        },
      },
    );
    return { durable: res.answers.durable.noul, model: res.model };
  } catch (err) {
    logger.warn("[jev] durability check unavailable:", err);
    return undefined;
  }
}
