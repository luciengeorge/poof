// Explicit operator invocation only. Not a tool, cron, model capability or activation action.
import { randomUUID } from "node:crypto";
import { memoryFromEnv } from "../agent/lib/memory.ts";
import { reconcileExecution } from "../agent/lib/reconcile-execution.ts";
import { resolveFencedOrder } from "../agent/lib/order-resolution.ts";
import { normalizeExecutionAccount } from "../convex/executionConfig.ts";
import { reconciliationDiagnostic, RECONCILIATION_CONFIG_ERROR } from "../agent/lib/reconciliation-diagnostics.ts";

async function main() {
  const env = process.env.TRADING212_ENV;
  const account = normalizeExecutionAccount(process.env.EXECUTION_ACCOUNT_ID);
  const apiKey = process.env.TRADING212_API_KEY;
  const apiSecret = process.env.TRADING212_API_SECRET ?? process.env.TRADING212_SECRET_KEY;
  if (process.env.EXECUTION_COORDINATION_ENABLED !== "true" || !account || !apiKey || !apiSecret || (env !== "demo" && env !== "live"))
    throw new Error(RECONCILIATION_CONFIG_ERROR);
  const memory = memoryFromEnv(undefined, { timeoutMs: 4_000 });
  if (process.argv.includes("--resolve")) {
    // --accept-filled asserts the operator has already recorded the fill in trade bookkeeping.
    const outcome = await resolveFencedOrder({ env, account, attempts: 1, acceptFilled: process.argv.includes("--accept-filled"),
      stores: { coordination: memory.executionStore(), reconciliation: memory.reconciliationStore(), inventory: memory.inventoryStore() },
      get: (path, signal) => fetch(`https://${env}.trading212.com/api/v0${path}`, { method: "GET", signal,
        headers: { Authorization: "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64") } }) });
    console.log(JSON.stringify({ released: true, classification: outcome.classification, filledQuantity: outcome.filledQuantity }));
    return;
  }
  const evidence = await reconcileExecution({ identity: { env, account, owner: `reconcile/${randomUUID()}` },
    store: memory.reconciliationStore(), apiKey, apiSecret });
  console.log(JSON.stringify({ classification: evidence.classification, reason: evidence.reason,
    historyComplete: evidence.historyComplete, matchedFillCount: evidence.matchedFillCount, canClearFence: false }));
}
main().catch(error => {
  const { exitCode, ...diagnostic } = reconciliationDiagnostic(error);
  if (exitCode === 0) console.log(JSON.stringify(diagnostic));
  else console.error(JSON.stringify(diagnostic));
  process.exitCode = exitCode;
});
