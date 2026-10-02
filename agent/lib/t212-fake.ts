import type { CashBalance, T212Position } from "./t212.ts";
import { CORE_TICKER } from "./core.ts";

/**
 * Fixed positions so an eval's arithmetic is reproducible run to run: one winner, one loser and
 * the index core, which production always holds and which manage_positions, review_performance,
 * the risk gate and the core sweep all treat specially. US prices are USD, the core's GBP.
 *
 * Chosen so no exit fires: AAPL is +6%, under the +8.7% at which the default trailing stop arms,
 * and KO is -4%, above the -10% default stop. No stored entry means no max-hold clock either. Two
 * stocks leave two of the four concurrent-position slots free for a BUY.
 */
export const FAKE_POSITIONS: T212Position[] = [
  {
    ticker: "AAPL_US_EQ",
    quantity: 0.15,
    averagePrice: 220,
    currentPrice: 233.2,
    ppl: 1.49,
    maxBuy: 0.85,
    maxSell: 0.15,
    pieQuantity: 0,
  },
  {
    ticker: "KO_US_EQ",
    quantity: 0.5,
    averagePrice: 70,
    currentPrice: 67.2,
    ppl: -1.05,
    maxBuy: 2.97,
    maxSell: 0.5,
    pieQuantity: 0,
  },
  {
    ticker: CORE_TICKER,
    quantity: 0.4,
    averagePrice: 108,
    currentPrice: 111.2,
    ppl: 1.28,
    maxBuy: 1.34,
    maxSell: 0.4,
    pieQuantity: 0,
  },
];

/**
 * Fixed cash, GBP. `free` covers one BUY at the gate's 15-30% trade size without selling the
 * core. `total` is free + invested + ppl, and matches free plus the positions valued at USD->GBP
 * 0.75, so the account-value reconciliation stays quiet at any realistic FX rate.
 */
export const FAKE_CASH: CashBalance = {
  total: 245.92,
  free: 150,
  blocked: 0,
  invested: 94.2,
  pieCash: 0,
  result: 0,
  ppl: 1.72,
};

const ROUTES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ["GET /equity/account/cash", FAKE_CASH],
  ["GET /equity/portfolio", FAKE_POSITIONS],
  // No pending orders. The order executor reads these with no fallback, so rejecting this path
  // would fail every submit_orders call.
  ["GET /equity/orders", []],
]);

/**
 * A canned Trading 212 wire, for CI only.
 *
 * WHY A FAKE FETCH RATHER THAN A FAKE CLIENT. T212Client owns the response parsing, the snapshot
 * cache and the 429 backoff, and those are exactly the parts a behavioural eval should still
 * exercise. Faking the wire keeps all of it in the loop and fakes only the network.
 *
 * Anything without a canned response REJECTS, order placement included. An empty `{}` would let a
 * tool that starts calling a new endpoint carry on with nonsense; a rejection fails the eval
 * loudly and names the path, and the fix is a new entry in ROUTES.
 */
export function fakeT212Fetch(): typeof fetch {
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url).pathname.replace(/^\/api\/v0/, "");
    const key = `${method} ${path}`;
    if (!ROUTES.has(key)) {
      throw new Error(`t212-fake: no canned response for ${key}`);
    }
    return new Response(JSON.stringify(ROUTES.get(key)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return fake as typeof fetch;
}
