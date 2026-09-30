/**
 * One-shot first purchase of the index core.
 *
 * The sweep sizes every core order from the held position's `currentPrice`, because nothing
 * outside Trading 212 prices VUAGl_EQ. Until a sliver is held there is no price, so the sweep
 * reports "not-bootstrapped" and sends nothing. This script places that first sliver by hand.
 *
 * It is also where the quote currency is checked. Every core valuation treats the Trading 212
 * price as pounds; a pence (GBX) or dollar listing would misvalue the core by 100x or by the FX
 * rate. A listing's currency does not change, and the instruments endpoint allows about one call
 * a minute, so it is checked once here instead of every cycle.
 *
 * DRY RUN BY DEFAULT. Nothing is sent without --apply.
 *
 * Usage:
 *   TRADING212_API_KEY=... TRADING212_API_SECRET=... \
 *     node --experimental-strip-types scripts/bootstrap-core.ts --env live [--apply]
 *
 * Flags:
 *   --env demo|live   override TRADING212_ENV (default: TRADING212_ENV, else "demo")
 *   --apply           actually place the order
 */
import { T212Client, type T212Env } from "../agent/lib/t212.ts";
import { CORE_FLOOR_QUANTITY, CORE_TICKER, coreCurrencyProblem, isCore } from "../agent/lib/core.ts";
import { placeWithPrecision } from "../agent/lib/orders.ts";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const env = flag(argv, "--env") ?? process.env.TRADING212_ENV ?? "demo";
  if (env !== "demo" && env !== "live") {
    throw new Error(`--env must be "demo" or "live", got "${env}"`);
  }
  const apiKey = process.env.TRADING212_API_KEY;
  const apiSecret = process.env.TRADING212_API_SECRET ?? process.env.TRADING212_SECRET_KEY;
  if (!apiKey || !apiSecret) {
    throw new Error("TRADING212_API_KEY and TRADING212_API_SECRET (or TRADING212_SECRET_KEY) must be set");
  }
  const client = new T212Client({ apiKey, apiSecret, env: env as T212Env });
  const apply = argv.includes("--apply");
  console.log(`account: ${env}`);

  const problem = coreCurrencyProblem(await client.getInstruments());
  if (problem) throw new Error(problem);
  console.log(`${CORE_TICKER} quotes in GBP`);

  const [account, pending] = await Promise.all([
    client.getBrokerSnapshot({ fresh: true }),
    client.getPendingOrders(),
  ]);
  if (pending.some((o) => isCore(o.ticker))) {
    throw new Error(`a ${CORE_TICKER} order is already pending; not placing another`);
  }
  const held = account.positions.find((p) => isCore(p.ticker));
  if (held && held.quantity > 0) {
    console.log(`${CORE_TICKER} already held (${held.quantity} at ${held.currentPrice}); nothing to do`);
    return;
  }
  console.log(`free cash: ${account.cash.free}`);

  if (!apply) {
    console.log(`\nDRY RUN. Would buy ${CORE_FLOOR_QUANTITY} ${CORE_TICKER} at market. Re-run with --apply.`);
    return;
  }
  const outcome = await placeWithPrecision(client, CORE_TICKER, CORE_FLOOR_QUANTITY, 1);
  if ("skipped" in outcome) throw new Error(outcome.skipped);
  console.log(`placed: ${outcome.quantity} ${CORE_TICKER}, order ${outcome.order.id}`);
}

main().catch((err) => {
  console.error("bootstrap failed:", err);
  process.exit(1);
});
