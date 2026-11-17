import { defineHook } from "eve/hooks";
import { isAmbient } from "../lib/ambient-permissions.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";

// Operational receipts only: no message text, identity, trading memory, broker or model calls.
export default defineHook({ events: {
  async "delivery.consumed"(event, ctx) {
    if (!isAmbient(ctx)) return;
    try {
      await memoryFromEnv(undefined, { timeoutMs: 1_500 }).recordAmbientReceipt({ env: tradingEnv(),
        sessionId: ctx.session.id, turnId: event.data.turnId, phase: "received" });
    } catch { console.warn("[observation] ambient receipt unavailable"); }
  },
  async "turn.settled"(event, ctx) {
    if (!isAmbient(ctx)) return;
    const outcome = event.data.outcome;
    if (outcome !== "completed" && outcome !== "failed" && outcome !== "cancelled") return;
    try {
      await memoryFromEnv(undefined, { timeoutMs: 1_500 }).recordAmbientReceipt({ env: tradingEnv(),
        sessionId: ctx.session.id, turnId: event.data.turnId, phase: "settled", outcome });
    } catch { console.warn("[observation] ambient receipt unavailable"); }
  },
} });
