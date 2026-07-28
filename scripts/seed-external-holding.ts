/**
 * One-shot seed for the ADVISORY-ONLY external SHOP holding.
 *
 * This writes a single row to the `externalHoldings` Convex table: a position held in a
 * SEPARATE brokerage account that the agent has no API access to and can NEVER trade. It does
 * NOT touch the trading account, the broker, `trades`, `riskState`, or anything the risk gate
 * reads. Nothing here can affect `accountValueGbp` or position sizing.
 *
 * Usage (reads both values from the environment; the secret is never printed):
 *   CONVEX_URL=... CONVEX_APP_SECRET=... TRADING212_ENV=live \
 *     node --experimental-strip-types scripts/seed-external-holding.ts
 *
 * Flags:
 *   --env demo|live   override TRADING212_ENV (default: TRADING212_ENV, else "demo")
 *   --remove          delete the row instead of upserting it
 *
 * The upsert is keyed on (env, ticker), so re-running it updates the existing row rather than
 * creating a duplicate. Safe to run more than once.
 */
import { memoryFromEnv, type Env, type ExternalHoldingRecord } from "../agent/lib/memory.ts";

const HOLDING: Omit<ExternalHoldingRecord, "env"> = {
  ticker: "SHOP",
  shares: 83.03770915,
  costBasisGbp: 9982.65, // total GBP cost, about GBP 120.22 per share
  currency: "USD",
  accountLabel: "external brokerage",
  taxable: true, // UK GIA: realising the loss has CGT value
  intent: "exit",
};

function parseEnvFlag(argv: string[]): Env {
  const i = argv.indexOf("--env");
  const raw = i >= 0 ? argv[i + 1] : process.env.TRADING212_ENV;
  const env = raw ?? "demo";
  if (env !== "demo" && env !== "live") {
    throw new Error(`--env must be "demo" or "live", got "${env}"`);
  }
  return env;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const env = parseEnvFlag(argv);
  const remove = argv.includes("--remove");

  // memoryFromEnv throws a clear error naming the missing variable, without echoing its value.
  const memory = memoryFromEnv();

  if (remove) {
    await memory.removeExternalHolding(env, HOLDING.ticker);
    console.log(`removed external holding ${HOLDING.ticker} (env=${env})`);
    return;
  }

  await memory.upsertExternalHolding({ env, ...HOLDING });
  console.log(
    `upserted external holding ${HOLDING.ticker} (env=${env}): ` +
      `${HOLDING.shares} shares, cost GBP ${HOLDING.costBasisGbp}, intent=${HOLDING.intent}, ` +
      `taxable=${HOLDING.taxable}. Advisory only: the agent cannot trade this account.`,
  );

  const stored = await memory.listExternalHoldings(env);
  console.log(
    `externalHoldings now holds ${stored.length} row(s) for env=${env}: ` +
      stored.map((h) => h.ticker).join(", "),
  );
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
