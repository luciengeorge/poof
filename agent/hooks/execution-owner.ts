import { defineHook } from "eve/hooks";
import { coordinationEnabled } from "../lib/execution-context.ts";
import { memoryFromEnv } from "../lib/memory.ts";
import { tradingEnv } from "../lib/risk-runtime.ts";
import { normalizeExecutionAccount } from "../../convex/executionConfig.ts";

export default defineHook({ events: {
  async "turn.settled"(event, ctx) {
    const account = normalizeExecutionAccount(process.env.EXECUTION_ACCOUNT_ID);
    if (!coordinationEnabled() || ctx.session.parent || !account) return;
    try {
      await memoryFromEnv(undefined, { timeoutMs: 4_000 }).executionStore().release({ env: tradingEnv(),
        account, owner: `${ctx.session.id}/${event.data.turnId}` });
    } catch { console.warn("[execution] owner remains fenced; reconciliation may be required"); }
  },
} });
