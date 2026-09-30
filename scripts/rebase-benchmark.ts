/**
 * One-shot correction of the SPY benchmark baseline.
 *
 * The stored baseline was captured when the account held GBP 50 and was then FUNDED to about
 * GBP 250. Nothing in the benchmark distinguishes a deposit from a gain, so the scorecard
 * reported roughly +400% against SPY's +4%. Total realised P&L over all closed trades is a
 * few pounds, so the account plainly did not quadruple by trading.
 *
 * The usual fix is to chain-link across the cash flow (see `rebaseForCashFlow` in
 * agent/lib/benchmark.ts), but the deposit predates every equity record we have: the `cycles`
 * table starts 2026-07-15. There is nothing to chain-link across. So this script restates the
 * baseline outright from the first date with a trustworthy equity reading. Alpha before that
 * date is unmeasurable, and inventing a pre-deposit series to pretend otherwise would be worse
 * than admitting the gap.
 *
 * DRY RUN BY DEFAULT. It prints the current baseline, the proposed one, and the alpha each
 * would report. Nothing is written without --apply.
 *
 * Usage:
 *   CONVEX_URL=... CONVEX_APP_SECRET=... FINNHUB_API_KEY=... \
 *     node --experimental-strip-types scripts/rebase-benchmark.ts \
 *     --env live --date 2026-07-15 --equity 252.17 --spy 754.81
 *
 * Flags:
 *   --date YYYY-MM-DD   new inception date (required)
 *   --equity <gbp>      new inception equity (required)
 *   --spy <usd>         new inception SPY price (required)
 *   --env demo|live     override TRADING212_ENV (default: TRADING212_ENV, else "demo")
 *   --current-equity    override the equity used for the alpha preview (default: latest cycle)
 *   --current-spy       override the SPY price used for the preview (default: live quote)
 *   --apply             actually write the new baseline
 */
import { memoryFromEnv, type Env } from "../agent/lib/memory.ts";
import { computeAlpha, type Benchmark } from "../agent/lib/benchmark.ts";
import { finnhubFromEnv } from "../agent/lib/data.ts";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function requiredNumber(argv: string[], name: string): number {
  const raw = flag(argv, name);
  const n = Number(raw);
  if (raw === undefined || !Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} is required and must be a positive number, got "${raw}"`);
  }
  return n;
}

function optionalNumber(argv: string[], name: string): number | undefined {
  const raw = flag(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return n;
}

function parseEnvFlag(argv: string[]): Env {
  const env = flag(argv, "--env") ?? process.env.TRADING212_ENV ?? "demo";
  if (env !== "demo" && env !== "live") {
    throw new Error(`--env must be "demo" or "live", got "${env}"`);
  }
  return env;
}

function describe(label: string, b: Benchmark): string {
  return `${label}: inception ${b.inceptionDate}, equity GBP ${b.inceptionEquity.toFixed(2)}, SPY USD ${b.inceptionSpyPrice.toFixed(2)}`;
}

function describeAlpha(label: string, b: Benchmark, equity: number, spy: number): string {
  const a = computeAlpha(b, equity, spy);
  return `${label}: account ${a.accountReturnPct.toFixed(2)}%, SPY ${a.spyReturnPct.toFixed(2)}%, alpha ${a.alphaPct.toFixed(2)}pp`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const env = parseEnvFlag(argv);
  const apply = argv.includes("--apply");

  const date = flag(argv, "--date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date is required as YYYY-MM-DD, got "${date}"`);
  }
  const proposed: Benchmark = {
    inceptionDate: date,
    inceptionEquity: requiredNumber(argv, "--equity"),
    inceptionSpyPrice: requiredNumber(argv, "--spy"),
  };

  const memory = memoryFromEnv();
  const recall = (await memory.recallRecent(env, {
    cycleLimit: 1,
    tradeLimit: 1,
    messageLimit: 1,
  })) as {
    benchmark: Benchmark | null;
    cycles: { equity: number; createdAt: number }[];
  };

  if (!recall.benchmark) {
    throw new Error(`no benchmark row for env "${env}"; nothing to rebase`);
  }
  console.log(describe("current ", recall.benchmark));
  console.log(describe("proposed", proposed));

  // Alpha preview. Both readings are best-effort: a missing quote must not stop the operator
  // seeing the two baselines side by side.
  const currentEquity = optionalNumber(argv, "--current-equity") ?? recall.cycles[0]?.equity;
  let currentSpy = optionalNumber(argv, "--current-spy");
  if (currentSpy === undefined) {
    try {
      currentSpy = (await finnhubFromEnv().getQuote("SPY")).price;
    } catch (err) {
      console.warn("SPY quote failed, pass --current-spy to see the alpha preview:", err);
    }
  }
  if (currentEquity && currentSpy) {
    console.log(`measured at: equity GBP ${currentEquity.toFixed(2)}, SPY USD ${currentSpy.toFixed(2)}`);
    console.log(describeAlpha("before  ", recall.benchmark, currentEquity, currentSpy));
    console.log(describeAlpha("after   ", proposed, currentEquity, currentSpy));
  } else {
    const missing = [
      currentEquity ? null : "equity (no cycle row; pass --current-equity)",
      currentSpy ? null : "SPY price (pass --current-spy)",
    ].filter(Boolean);
    console.log(`alpha preview skipped, missing ${missing.join(" and ")}`);
  }

  if (!apply) {
    console.log("\nDRY RUN. Nothing written. Re-run with --apply to overwrite the baseline.");
    return;
  }

  await memory.overwriteBenchmark({ env, ...proposed });
  const after = (await memory.getBenchmark(env)) as Benchmark;
  console.log(`\nwritten. ${describe("stored  ", after)}`);
}

main().catch((err) => {
  console.error("rebase failed:", err);
  process.exit(1);
});
