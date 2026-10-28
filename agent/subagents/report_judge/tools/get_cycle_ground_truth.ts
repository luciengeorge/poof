import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  judgeGroundTruthResult,
  type JudgeGroundTruthResult,
} from "../../../lib/report-judge.ts";
import { memoryFromEnv, type Memory, type StoredCycleTrace } from "../../../lib/memory.ts";

type CycleTraceReader = Pick<Memory, "getCycleTraceById" | "recentCycleTraces">;

/**
 * Load one cycle's facts through the secret-gated Convex memory client.
 *
 * Kept as a narrow function so the tool has a direct test seam while ground-truth assembly stays
 * pure and tested in agent/lib/report-judge.ts.
 */
export async function loadCycleGroundTruth(
  cycleId: string,
  memory: CycleTraceReader = memoryFromEnv(),
): Promise<JudgeGroundTruthResult> {
  const trace = await memory.getCycleTraceById(cycleId);
  if (trace === null) return judgeGroundTruthResult(null);
  return judgeGroundTruthResult({ ...trace, ...(await previousAccountValue(trace, memory)) });
}

/**
 * The account value the cycle before this one recorded, which reports quote as "last recorded".
 * Best effort: a failed lookup leaves the claim unverifiable rather than failing the grade.
 */
async function previousAccountValue(
  trace: StoredCycleTrace,
  memory: CycleTraceReader,
): Promise<{ previousAccountValueGbp?: number }> {
  try {
    const previous = (await memory.recentCycleTraces(trace.env, 50))
      .filter((t) => t.startedAt < trace.startedAt && t.postTradeAccountValueGbp !== undefined)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    return previous?.postTradeAccountValueGbp !== undefined
      ? { previousAccountValueGbp: previous.postTradeAccountValueGbp }
      : {};
  } catch {
    return {};
  }
}

export default defineTool({
  description:
    "Load the stored ground truth for exactly one already-finished trading cycle by its immutable " +
    "cycle id. Call this before grading. It returns the observed facts plus mandatory coverage " +
    "notes, or an explicit UNJUDGEABLE result when no trace exists for that id. Read-only: it " +
    "cannot trade, change a report, or ask a human anything.",
  inputSchema: z.object({
    cycleId: z.string().min(1).describe("the immutable cycle id supplied by the weekly judge pass"),
  }),
  async execute({ cycleId }) {
    return await loadCycleGroundTruth(cycleId);
  },
});
