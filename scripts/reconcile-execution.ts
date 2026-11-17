// Explicit operator invocation only. Not a tool, cron, model capability or activation action.
import { randomUUID } from "node:crypto";
import { memoryFromEnv } from "../agent/lib/memory.ts";
import { reconcileExecution } from "../agent/lib/reconcile-execution.ts";
import { normalizeExecutionAccount } from "../convex/executionConfig.ts";
import { reconciliationDiagnostic, RECONCILIATION_CONFIG_ERROR } from "../agent/lib/reconciliation-diagnostics.ts";

async function main() {
  const env = process.env.TRADING212_ENV;
  const account = normalizeExecutionAccount(process.env.EXECUTION_ACCOUNT_ID);
  const apiKey = process.env.TRADING212_API_KEY;
  const apiSecret = process.env.TRADING212_API_SECRET ?? process.env.TRADING212_SECRET_KEY;
  if (process.env.EXECUTION_COORDINATION_ENABLED !== "true" || !account || !apiKey || !apiSecret || (env !== "demo" && env !== "live"))
    throw new Error(RECONCILIATION_CONFIG_ERROR);
  const evidence = await reconcileExecution({ identity: { env, account, owner: `reconcile/${randomUUID()}` },
    store: memoryFromEnv(undefined, { timeoutMs: 4_000 }).reconciliationStore(), apiKey, apiSecret });
  console.log(JSON.stringify({ classification: evidence.classification, reason: evidence.reason,
    historyComplete: evidence.historyComplete, matchedFillCount: evidence.matchedFillCount, canClearFence: false }));
}
main().catch(error => {
  const { exitCode, ...diagnostic } = reconciliationDiagnostic(error);
  if (exitCode === 0) console.log(JSON.stringify(diagnostic));
  else console.error(JSON.stringify(diagnostic));
  process.exitCode = exitCode;
});
