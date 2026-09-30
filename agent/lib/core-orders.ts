/**
 * Broker IO for the index core (see core.ts): the end-of-cycle sweep of idle cash into the core,
 * and the sale that raises cash for a stock buy the gate rejected for want of it.
 *
 * NOT THROUGH THE RISK GATE. The gate bounds stock risk; the core is where money waits when the
 * stock sleeve has no use for it. So a halt, which blocks stock buys, never stops the sweep and
 * never sells the core. (A halt rejects stock buys before cash is checked, so it cannot trigger a
 * funding sale either.)
 *
 * NOT TRADES. Core orders never reach the `trades` table, which feeds win rate, per-tag stats,
 * calibration and attribution: index rebalances there would pollute the one measurement of
 * whether stock picking works. They are returned to the calling tool and kept in `coreOrders`.
 *
 * PRICE. Sized only from Trading 212's own price on the held core (constants and reasons in
 * core.ts). Not held and nothing pending means no price, so nothing is sized and nothing is sent:
 * the first purchase is made by hand, never by a blind fixed-quantity order from here.
 */
import {
  CORE_CASH_BUFFER_PCT,
  CORE_FLOOR_QUANTITY,
  CORE_MIN_ORDER_GBP,
  CORE_TICKER,
  fundingSale,
  fxForHolding,
  isCore,
  sweepQuantity,
} from "./core.ts";
import { accountValueGbp, brokerSnapshotWithFx, DEFAULT_QUANTITY_PRECISION } from "./execution.ts";
import { placeWithPrecision, type OrderExecClient } from "./orders.ts";
import { etDateString } from "./clock.ts";
import type { FxResolution } from "./fx.ts";
import type { BrokerAccountSnapshot, T212Order } from "./t212.ts";
import type { CoreOrderRecord, Env } from "./memory.ts";

export type CoreAction = "sweep" | "fund";

export type CoreStatus =
  /** Sent to Trading 212. */
  | "placed"
  /** DRY_RUN: what would have been sent. */
  | "simulated"
  /** Trading 212 refused it, or it rounds to nothing at the allowed precision. */
  | "rejected"
  /** A core order is already waiting (in summer until the next London open); never stack one. */
  | "pending"
  /** The core is not held, so there is no price to size from. Nothing sent. */
  | "not-bootstrapped"
  /** This cycle already sold core to fund a stock buy: the sweep leaves that cash alone, and a
   * second funding sale is refused. */
  | "funds-raised"
  /** Under the minimum order, at the floor, or no shortfall. */
  | "nothing-to-do"
  /** An error. Nothing was decided on; see `detail`. */
  | "failed";

export interface CoreResult {
  action: CoreAction;
  status: CoreStatus;
  /** Signed shares: positive buys, negative sells. 0 when nothing was sent. */
  quantity: number;
  /** GBP value of `quantity` at the price it was sized from. */
  notionalGbp: number;
  priceGbp?: number;
  dryRun: boolean;
  /** One plain sentence for the agent's report. */
  detail: string;
  order?: T212Order;
}

export interface CoreOpts {
  client: OrderExecClient;
  fx: FxResolution;
  dryRun: boolean;
  /** The durable per-cycle marker store the stock path already uses (orderIntents). */
  hasOrderIntent: (key: string) => Promise<boolean>;
  now?: Date;
}

/**
 * The marker a funding sale leaves for the sweep. In winter London is still open at the cycle, so
 * the sale fills at once and its proceeds show as free cash, which the sweep would otherwise buy
 * straight back. Dry runs use their own key so a simulation can never block a real sale.
 */
export function coreFundingKey(now: Date, dryRun: boolean): string {
  return `${etDateString(now)}:${CORE_TICKER}:FUND${dryRun ? ":dry-run" : ""}`;
}

const gbp = (n: number): string => `£${n.toFixed(2)}`;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface HeldCore {
  quantity: number;
  priceGbp: number;
  equity: number;
  freeCash: number;
}

/** Read the core's holding and price from one broker snapshot, or say why it cannot be used. */
async function readCore(
  opts: CoreOpts,
  action: CoreAction,
): Promise<HeldCore | CoreResult> {
  const base = { action, quantity: 0, notionalGbp: 0, dryRun: opts.dryRun };
  const [account, pending]: [BrokerAccountSnapshot, T212Order[]] = await Promise.all([
    opts.client.getBrokerSnapshot(),
    opts.client.getPendingOrders(),
  ]);
  if (pending.some((o) => isCore(o.ticker))) {
    return {
      ...base,
      status: "pending",
      detail: `a ${CORE_TICKER} order is already pending; not placing another`,
    };
  }
  const held = account.positions.find((p) => isCore(p.ticker));
  const priceGbp = held ? held.currentPrice * fxForHolding(held.ticker, opts.fx.rate) : Number.NaN;
  if (!held || !(held.quantity > 0) || !(priceGbp > 0)) {
    return {
      ...base,
      status: "not-bootstrapped",
      detail:
        `the index core ${CORE_TICKER} is not held, so Trading 212 gives no price to size from; ` +
        "nothing was sent",
    };
  }
  return {
    quantity: held.quantity,
    priceGbp,
    equity: accountValueGbp(brokerSnapshotWithFx(account, opts.fx)),
    freeCash: account.cash.free,
  };
}

async function send(
  opts: CoreOpts,
  action: CoreAction,
  magnitude: number,
  priceGbp: number,
  describe: (notional: number) => string,
): Promise<CoreResult> {
  const sign = action === "sweep" ? 1 : -1;
  const base = { action, priceGbp, dryRun: opts.dryRun };
  if (opts.dryRun) {
    const notionalGbp = magnitude * priceGbp;
    return {
      ...base,
      status: "simulated",
      quantity: sign * magnitude,
      notionalGbp,
      detail: `DRY RUN: would have ${describe(notionalGbp)}`,
    };
  }
  const outcome = await placeWithPrecision(opts.client, CORE_TICKER, magnitude, sign);
  if ("skipped" in outcome) {
    return { ...base, status: "rejected", quantity: 0, notionalGbp: 0, detail: outcome.skipped };
  }
  const notionalGbp = Math.abs(outcome.quantity) * priceGbp;
  return {
    ...base,
    status: "placed",
    quantity: outcome.quantity,
    notionalGbp,
    order: outcome.order,
    detail: describe(notionalGbp),
  };
}

/**
 * Buy the core with free cash above the buffer. Runs once, at the end of the cycle, after every
 * stock order: see record_cycle for why it lives there.
 */
export async function sweepCore(opts: CoreOpts): Promise<CoreResult> {
  const base = { action: "sweep" as const, quantity: 0, notionalGbp: 0, dryRun: opts.dryRun };
  try {
    if (await opts.hasOrderIntent(coreFundingKey(opts.now ?? new Date(), opts.dryRun))) {
      return {
        ...base,
        status: "funds-raised",
        detail: "this cycle sold index core to fund a stock buy, so its cash is left for that buy",
      };
    }
    const core = await readCore(opts, "sweep");
    if ("status" in core) return core;
    const quantity = sweepQuantity({
      freeCash: core.freeCash,
      equity: core.equity,
      corePrice: core.priceGbp,
      precision: DEFAULT_QUANTITY_PRECISION,
      // The sweep runs after the cycle's stock orders, so nothing is still owed to a stock buy.
      reservedForStocks: 0,
    });
    if (quantity <= 0) {
      return {
        ...base,
        priceGbp: core.priceGbp,
        status: "nothing-to-do",
        detail:
          `free cash ${gbp(core.freeCash)} is within the ${CORE_CASH_BUFFER_PCT * 100}% buffer ` +
          `plus the ${gbp(CORE_MIN_ORDER_GBP)} minimum; nothing swept`,
      };
    }
    return await send(opts, "sweep", quantity, core.priceGbp, (n) =>
      `swept ${gbp(n)} of idle cash into the index core ${CORE_TICKER}`,
    );
  } catch (err) {
    return { ...base, status: "failed", detail: `index core sweep failed: ${errorText(err)}` };
  }
}

/**
 * Sell just enough core to cover a stock buy's cash shortfall plus the buffer, never below the
 * floor. The stock is NOT retried in this batch (sale proceeds are unsettled, see validateOrders):
 * the agent re-decides next cycle with the cash in hand, and if it no longer wants the stock, that
 * cycle's sweep returns the cash to the core. The owner chose this one-cycle lag.
 */
export async function fundFromCore(
  opts: CoreOpts & {
    shortfall: number;
    recordOrderIntent: (key: string) => Promise<void>;
  },
): Promise<CoreResult> {
  const base = { action: "fund" as const, quantity: 0, notionalGbp: 0, dryRun: opts.dryRun };
  if (!(opts.shortfall > 0)) {
    return { ...base, status: "nothing-to-do", detail: "no cash shortfall to fund" };
  }
  const key = coreFundingKey(opts.now ?? new Date(), opts.dryRun);
  let result: CoreResult;
  try {
    if (await opts.hasOrderIntent(key)) {
      return {
        ...base,
        status: "funds-raised",
        detail: "cash was already raised from the index core this cycle; not selling twice",
      };
    }
    const core = await readCore(opts, "fund");
    if ("status" in core) return core;
    const quantity = fundingSale({
      shortfall: opts.shortfall,
      equity: core.equity,
      coreQuantity: core.quantity,
      corePrice: core.priceGbp,
      precision: DEFAULT_QUANTITY_PRECISION,
    });
    if (quantity <= 0) {
      return {
        ...base,
        priceGbp: core.priceGbp,
        status: "nothing-to-do",
        detail: `the index core is at its floor of ${CORE_FLOOR_QUANTITY} shares; nothing to sell`,
      };
    }
    result = await send(opts, "fund", quantity, core.priceGbp, (n) =>
      `raised ${gbp(n)} from the index core; the stock can be bought next cycle`,
    );
  } catch (err) {
    return { ...base, status: "failed", detail: `index core funding failed: ${errorText(err)}` };
  }
  if (result.status === "placed" || result.status === "simulated") {
    try {
      await opts.recordOrderIntent(key);
    } catch (err) {
      console.warn("[core] funding marker write failed:", err);
      result.detail +=
        "; WARNING: the funding marker could not be saved, so this cycle's sweep may buy it back";
    }
  }
  return result;
}

/** The audit row for a core order that was attempted, or null when nothing was attempted. */
export function coreOrderRecord(result: CoreResult, env: Env): CoreOrderRecord | null {
  if (result.status !== "placed" && result.status !== "simulated" && result.status !== "rejected") {
    return null;
  }
  return {
    env,
    action: result.action,
    status: result.status,
    quantity: result.quantity,
    priceGbp: result.priceGbp ?? 0,
    notionalGbp: result.notionalGbp,
    dryRun: result.dryRun,
    detail: result.detail,
    ...(typeof result.order?.id === "number" ? { orderId: result.order.id } : {}),
  };
}
