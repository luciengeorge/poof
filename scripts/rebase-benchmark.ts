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
 *   --fx <usd->gbp>     inception USD -> GBP rate, e.g. 0.7386233 for GBPUSD 1.35387. Optional,
 *                       but without it SPY's return is compared in USD against a GBP account
 *                       and alpha is reported as "USD-unadjusted". OMITTING IT CLEARS any rate
 *                       already stored, so pass it on every rebase you want measured in GBP.
 *   --current-fx        override the current USD -> GBP used for the preview (default: live)
 *   --env demo|live     override TRADING212_ENV (default: TRADING212_ENV, else "demo")
 *   --current-equity    override the equity used for the alpha preview (default: latest cycle)
 *   --current-spy       override the SPY price used for the preview (default: live quote)
 *   --benchmark-ticker VUAGl_EQ
 *                       measure against the index core instead of SPY. --spy then carries the
 *                       core's GBP price at inception (read it from the held position in Trading
 *                       212), the inception rate is 1, and --fx must be omitted or 1. OMITTING
 *                       THIS FLAG returns the baseline to SPY, so pass it on every core rebase.
 *   --current-core      the core's current GBP price for the preview. Nothing outside Trading
 *                       212 prices it, so there is no live default: without it, a core baseline
 *                       gets no preview line.
 *   --apply             actually write the new baseline
 */
import { memoryFromEnv, type Env } from "../agent/lib/memory.ts";
import { computeAlpha, isCoreBenchmark, type Benchmark } from "../agent/lib/benchmark.ts";
import { CORE_TICKER } from "../agent/lib/core.ts";
import { finnhubFromEnv } from "../agent/lib/data.ts";
import { resolveUsdGbp } from "../agent/lib/fx.ts";

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

function parseBenchmarkTicker(argv: string[]): string | undefined {
  const ticker = flag(argv, "--benchmark-ticker");
  if (ticker !== undefined && ticker !== CORE_TICKER) {
    throw new Error(
      `--benchmark-ticker must be "${CORE_TICKER}" (omit it for SPY), got "${ticker}"`,
    );
  }
  return ticker;
}

function describe(label: string, b: Benchmark): string {
  if (isCoreBenchmark(b)) {
    return `${label}: inception ${b.inceptionDate}, equity GBP ${b.inceptionEquity.toFixed(2)}, ${CORE_TICKER} GBP ${b.inceptionSpyPrice.toFixed(2)}, FX 1`;
  }
  const fx = b.inceptionFxRate === undefined ? "none" : b.inceptionFxRate.toFixed(7);
  return `${label}: inception ${b.inceptionDate}, equity GBP ${b.inceptionEquity.toFixed(2)}, SPY USD ${b.inceptionSpyPrice.toFixed(2)}, FX USD->GBP ${fx}`;
}

function describeAlpha(
  label: string,
  b: Benchmark,
  equity: number,
  spy: number,
  fx: number | undefined,
): string {
  const a = computeAlpha(b, equity, spy, fx);
  const name = isCoreBenchmark(b) ? CORE_TICKER : "SPY";
  return `${label}: account ${a.accountReturnPct.toFixed(2)}%, ${name} ${a.spyReturnPct.toFixed(2)}% (${a.spyReturnBasis}), alpha ${a.alphaPct.toFixed(2)}pp`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const env = parseEnvFlag(argv);
  const apply = argv.includes("--apply");

  const date = flag(argv, "--date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date is required as YYYY-MM-DD, got "${date}"`);
  }
  const benchmarkTicker = parseBenchmarkTicker(argv);
  const fxFlag = optionalNumber(argv, "--fx");
  if (benchmarkTicker !== undefined && fxFlag !== undefined && fxFlag !== 1) {
    throw new Error(`${CORE_TICKER} is quoted in GBP, so its inception rate is 1; got --fx ${fxFlag}`);
  }
  const proposed: Benchmark = {
    inceptionDate: date,
    inceptionEquity: requiredNumber(argv, "--equity"),
    inceptionSpyPrice: requiredNumber(argv, "--spy"),
    inceptionFxRate: benchmarkTicker !== undefined ? 1 : fxFlag,
    benchmarkTicker,
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

  // Alpha preview. Every reading is best-effort: a missing quote must not stop the operator
  // seeing the two baselines side by side. Each baseline is priced in its own instrument: SPY in
  // USD at the live rate, the core in GBP at a rate of 1.
  const currentEquity = optionalNumber(argv, "--current-equity") ?? recall.cycles[0]?.equity;
  const needsSpy = !isCoreBenchmark(recall.benchmark) || !isCoreBenchmark(proposed);
  let currentSpy = optionalNumber(argv, "--current-spy");
  if (needsSpy && currentSpy === undefined) {
    try {
      currentSpy = (await finnhubFromEnv().getQuote("SPY")).price;
    } catch (err) {
      console.warn("SPY quote failed, pass --current-spy to see the alpha preview:", err);
    }
  }
  // resolveUsdGbp never throws: it degrades to the hardcoded 0.75 with source "fallback". That
  // is not a measurement, and this preview is the evidence the operator reads before --apply, so
  // a fallback must NOT produce a "(GBP)" line priced at 0.75. Drop it and let the preview say
  // USD-unadjusted instead.
  let currentFx = optionalNumber(argv, "--current-fx");
  if (needsSpy && currentFx === undefined) {
    const resolved = await resolveUsdGbp();
    currentFx = resolved.source === "fallback" ? undefined : resolved.rate;
  }
  const currentCore = optionalNumber(argv, "--current-core");
  if (currentEquity) {
    console.log(
      `measured at: equity GBP ${currentEquity.toFixed(2)}, SPY USD ${currentSpy?.toFixed(2) ?? "none"}, FX USD->GBP ${currentFx?.toFixed(7) ?? "none"}, ${CORE_TICKER} GBP ${currentCore?.toFixed(2) ?? "none"}`,
    );
    for (const [label, b] of [
      ["before  ", recall.benchmark],
      ["after   ", proposed],
    ] as const) {
      if (isCoreBenchmark(b)) {
        console.log(
          currentCore
            ? describeAlpha(label, b, currentEquity, currentCore, 1)
            : `${label}: preview skipped, pass --current-core`,
        );
      } else {
        console.log(
          currentSpy
            ? describeAlpha(label, b, currentEquity, currentSpy, currentFx)
            : `${label}: preview skipped, pass --current-spy`,
        );
      }
    }
  } else {
    console.log("alpha preview skipped, missing equity (no cycle row; pass --current-equity)");
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
