import { defineHook } from "eve/hooks";
import { coordinationEnabled } from "../lib/execution-context.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";

export default defineHook({ events: {
  async "turn.settled"(event, ctx) {
    if (!coordinationEnabled() || ctx.session.parent || !process.env.EXECUTION_ACCOUNT_ID) return;
    try {
      await memoryFromEnv(undefined, { timeoutMs: 4_000 }).executionStore().release({ env: tradingEnv(),
        account: process.env.EXECUTION_ACCOUNT_ID, owner: `${ctx.session.id}/${event.data.turnId}` });
    } catch { console.warn("[execution] owner remains fenced; reconciliation may be required"); }
  },
} });
