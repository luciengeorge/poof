import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryFromEnv, type Env } from "../lib/memory.ts";
import { decayed, renderMemoryBlock, type MemoryRow } from "../../convex/memoryPolicy.ts";

/** Convex rows carry a semantic `memoryId`; the policy module reasons about `id`. */
function toRows(stored: readonly { memoryId: string }[]): MemoryRow[] {
  return stored.map((s) => {
    const { memoryId, ...rest } = s as { memoryId: string } & Omit<MemoryRow, "id">;
    return { ...rest, id: memoryId };
  });
}

export default defineTool({
  description:
    "Recall your durable memory for this account. Returns your structured `memory` (directives you " +
    "must obey, lessons you derived, current observations), `fromLucien` (his recent messages, on " +
    "their own budget so they are never crowded out by your own reports), recent trades with " +
    "thesis and outcome, recent cycle decisions, recent conversation, and the persisted risk " +
    "state. Call this FIRST each cycle. The memory block is authoritative: a DIRECTIVE outranks " +
    "your own inference, and you cannot retire one yourself.",
  inputSchema: z.object({
    tradeLimit: z.number().int().min(1).max(50).optional(),
    messageLimit: z.number().int().min(1).max(50).optional(),
  }),
  async execute({ tradeLimit, messageLimit }) {
    const env = (process.env.TRADING212_ENV ?? "demo") as Env;
    const memory = memoryFromEnv();

    // Structured memory first, and independently of the rest: it is the part that must not be
    // silently missing. Each block is separately non-fatal, so one failure cannot blank the others.
    let memoryBlock = "";
    let directiveCount = 0;
    let expired: string[] = [];
    try {
      // Retire whatever lapsed BEFORE reading, so a stale observation cannot steer this cycle.
      // Once per cycle is enough, and step 1 is the only place guaranteed to run every time.
      expired = (await memory.expireAgentMemory(env)).expired;
      const rows = toRows(await memory.listAgentMemory(env));
      const live = decayed(rows, Date.now()).active;
      directiveCount = live.filter((r) => r.class === "directive").length;
      memoryBlock = renderMemoryBlock(live);
    } catch (err) {
      console.warn("[memory] structured memory unavailable (non-fatal):", err);
    }

    let fromLucien: { text: string; createdAt: number }[] = [];
    try {
      fromLucien = await memory.recentUserMessages(env);
    } catch (err) {
      console.warn("[memory] recentUserMessages failed (non-fatal):", err);
    }

    try {
      const recent = await memory.recallRecent(env, { tradeLimit, messageLimit });
      return {
        memory: memoryBlock,
        directiveCount,
        expiredThisCycle: expired,
        fromLucien,
        ...(recent as object),
      };
    } catch (err) {
      // Memory not configured (no CONVEX_URL) or unreachable: don't break the cycle.
      console.warn("[memory] recallRecent failed (non-fatal):", err);
      return {
        memory: memoryBlock,
        directiveCount,
        expiredThisCycle: expired,
        fromLucien,
        cycles: [],
        trades: [],
        messages: [],
        riskState: null,
        note: "memory unavailable",
      };
    }
  },
});
