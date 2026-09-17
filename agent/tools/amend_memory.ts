import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";
import { MAX_EDITS_PER_CYCLE } from "../../convex/memoryPolicy.ts";
import { jevFromEnv } from "../lib/jev.ts";
import { jevDurabilityCheck } from "../lib/jev-durability.ts";

/**
 * The ONLY way to change durable memory, and deliberately a narrow one.
 *
 * This replaced `update_lessons`, which took the FULL rewritten note. SHARP (arXiv 2605.06822)
 * ablates that exact mechanism: bounded atomic edits scored +33.2% return where free-form full
 * rewrites scored -12.1%, because a rewrite destroys credit assignment. There is no way to replace
 * memory wholesale here; the shape of the tool makes the failing pattern unreachable.
 */
export default defineTool({
  description:
    "Amend your durable memory with AT MOST 3 atomic edits. This is the only way memory changes: " +
    "there is no full-rewrite operation, because rewriting everything makes it impossible to tell " +
    "which belief earned its place. Each edit needs a `reason` naming what actually happened this " +
    "cycle. Call `memory_gate` FIRST to have your candidates judged, then pass the ones it " +
    "admitted. Classes: `directive` (Lucien's standing instruction or a hard constraint; you may " +
    "NOT create or retire one yourself), `lesson` (a durable mechanic you derived from outcomes), " +
    "`observation` (current regime or portfolio state, which expires on its own). Never store " +
    "figures that `review_performance` recomputes each cycle, such as win rates or per-tag P&L: " +
    "those arrive fresh anyway and go stale in memory. Returns a decision per edit, including any " +
    "REFUSAL and the rule that refused it, so read the result rather than assuming it applied.",
  inputSchema: z.object({
    edits: z
      .array(
        z.union([
          z.object({
            op: z.literal("add"),
            id: z
              .string()
              .min(1)
              .max(60)
              .describe("Stable semantic id, snake_case, e.g. broker_min_position."),
            class: z.enum(["directive", "lesson", "observation"]),
            category: z
              .string()
              .min(1)
              .max(40)
              .describe("Coarse grouping: execution, risk, selection, sizing, reporting."),
            condition: z
              .string()
              .min(1)
              .max(300)
              .describe('The trigger as a predicate: "IF a full close is rejected".'),
            action: z
              .string()
              .min(1)
              .max(300)
              .describe('What to do when it triggers: "prefer a partial de-risk".'),
            provenance: z
              .enum(["user", "agent"])
              .describe("`user` only when Lucien actually said it. Directives must be `user`."),
            reason: z.string().min(1).max(300),
          }),
          z.object({
            op: z.literal("modify"),
            id: z.string().min(1).max(60),
            condition: z.string().min(1).max(300).optional(),
            action: z.string().min(1).max(300).optional(),
            confidence: z.number().min(0).max(1).optional(),
            reason: z.string().min(1).max(300),
          }),
          z.object({
            op: z.literal("retire"),
            id: z.string().min(1).max(60),
            reason: z.string().min(1).max(300),
          }),
        ]),
      )
      .max(MAX_EDITS_PER_CYCLE)
      .describe(`At most ${MAX_EDITS_PER_CYCLE} edits. Fewer is normal; zero is fine.`),
    sourceCycle: z
      .string()
      .max(80)
      .optional()
      .describe("Short label for the cycle proposing this, for later attribution."),
  }),
  async execute({ edits, sourceCycle }) {
    if (edits.length === 0) return { applied: [], decisions: [], note: "no edits proposed" };
    try {
      const outcome = await memoryFromEnv().applyMemoryEdits(tradingEnv(), edits, sourceCycle);
      // Jev's read on whether each proposed lesson is durable, attached to the result (and so to
      // the cycle trace) beside the gate's decision. It admits and refuses nothing; the policy in
      // code and the memory_gate keep that job.
      const jev = jevFromEnv();
      if (!jev) return outcome;
      const jevDurability = await Promise.all(
        edits
          .filter((e): e is Extract<typeof e, { op: "add" }> => e.op === "add")
          .map(async (e) => {
            const d = await jevDurabilityCheck(jev, { condition: e.condition, action: e.action, reason: e.reason });
            return { id: e.id, ...(d ? { durable: d.durable, model: d.model } : { unavailable: true }) };
          }),
      );
      return { ...outcome, jevDurability };
    } catch (err) {
      // Non-fatal, like every other memory write: a cycle must still trade and report.
      console.warn("[memory] applyMemoryEdits failed (non-fatal):", err);
      return { applied: [], decisions: [], note: "memory unavailable" };
    }
  },
});
