// Explicit operator invocation only. Broker access is read-only GETs; never an order.
//   --account-id  print the API key's broker account ID and currency (flags not required)
//   (default)     verify EXECUTION_ACCOUNT_ID and adopt or exactly confirm the ledger baseline
import { randomUUID } from "node:crypto";
import { memoryFromEnv } from "../agent/lib/memory.ts";
import { runExecutionScope } from "../agent/lib/execution-context.ts";
import { T212Client } from "../agent/lib/t212.ts";
import { normalizeExecutionAccount } from "../convex/executionConfig.ts";

async function main() {
  const env = process.env.TRADING212_ENV as "demo" | "live" | undefined;
  const apiKey = process.env.TRADING212_API_KEY;
  const apiSecret = process.env.TRADING212_API_SECRET ?? process.env.TRADING212_SECRET_KEY;
  if (!apiKey || !apiSecret || (env !== "demo" && env !== "live")) throw new Error("Broker configuration incomplete");
  if (process.argv.includes("--account-id")) {
    const response = await fetch(`https://${env}.trading212.com/api/v0/equity/account/info`, {
      headers: { Authorization: "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64") },
      signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Account info read refused (${response.status})`);
    const info = await response.json() as { id?: unknown; currencyCode?: unknown };
    console.log(JSON.stringify({ id: info.id, currencyCode: info.currencyCode }));
    return;
  }
  const account = normalizeExecutionAccount(process.env.EXECUTION_ACCOUNT_ID);
  if (process.env.EXECUTION_COORDINATION_ENABLED !== "true" || !account) throw new Error("Execution mode configuration incomplete");
  const memory = memoryFromEnv(undefined, { timeoutMs: 4_000 });
  const store = memory.executionStore(), inventory = memory.inventoryStore();
  const identity = { env, account, owner: `prepare/${randomUUID()}` };
  const { inventoryInitialized } = await store.status({ env, account });
  try {
    await runExecutionScope({ identity, callId: "prepare", store, reconciliation: memory.reconciliationStore(), inventory },
      () => new T212Client({ env, apiKey, apiSecret }).prepareExecution());
  } finally {
    await store.release(identity).catch(() => {});
  }
  const { positions } = await inventory.positions({ env, account }) as { positions: { ticker: string; quantity: number }[] };
  console.log(JSON.stringify({ verifiedAccount: true, baseline: inventoryInitialized ? "confirmed" : "adopted", openPositions: positions.length,
    tickers: positions.map(p => `${p.ticker}:${p.quantity}`) }));
}
main().catch(error => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message.slice(0, 300) : "unexpected failure" }));
  process.exitCode = 1;
});
