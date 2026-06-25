import { defineHook } from "eve/hooks";
import { memoryFromEnv, type Env } from "../lib/memory.ts";

function env(): Env {
  return (process.env.TRADING212_ENV ?? "demo") as Env;
}

// Record the agent's final replies to durable memory. Best-effort: a thrown hook
// would fail the turn, so everything is wrapped in try/catch.
export default defineHook({
  events: {
    async "message.completed"(event, ctx) {
      try {
        // Skip interim narration before tool calls; only keep terminal replies.
        if (event.data?.finishReason === "tool-calls") return;
        const text = event.data?.message;
        if (!text) return;
        await memoryFromEnv().recordMessage({
          env: env(),
          role: "agent",
          text,
          sessionId: ctx.session.id,
        });
      } catch (err) {
        console.warn("[memory] record agent message failed (non-fatal):", err);
      }
    },
  },
});
