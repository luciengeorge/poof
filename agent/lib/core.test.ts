import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORE_CASH_BUFFER_PCT,
  CORE_FLOOR_QUANTITY,
  CORE_MIN_ORDER_GBP,
  CORE_PRICE_MARGIN,
  CORE_TICKER,
  fundingSale,
  fxForHolding,
  isCore,
  sweepQuantity,
} from "./core.ts";

const EQUITY = 1000;
const BUFFER = CORE_CASH_BUFFER_PCT * EQUITY; // 30

function sweep(over: Partial<Parameters<typeof sweepQuantity>[0]> = {}): number {
  return sweepQuantity({
    freeCash: BUFFER + 100,
    equity: EQUITY,
    corePrice: 100,
    precision: 6,
    reservedForStocks: 0,
    ...over,
  });
}

function fund(over: Partial<Parameters<typeof fundingSale>[0]> = {}): number {
  return fundingSale({
    shortfall: 120,
    equity: EQUITY,
    coreQuantity: 9,
    corePrice: 100,
    precision: 6,
    ...over,
  });
}

test("isCore recognises only the core ticker", () => {
  assert.equal(isCore(CORE_TICKER), true);
  assert.equal(isCore("VUAG"), false);
  assert.equal(isCore("AAPL_US_EQ"), false);
});

test("fxForHolding: 1 for the GBP-quoted core, the USD rate for everything else", () => {
  assert.equal(fxForHolding(CORE_TICKER, 0.755), 1);
  assert.equal(fxForHolding("AAPL_US_EQ", 0.755), 0.755);
});

test("sweepQuantity buys the excess above the buffer, sized a margin below the price", () => {
  const qty = sweep();
  // 100 GBP excess at 100 GBP, sized against 101: 0.990099 shares.
  assert.equal(qty, 0.990099);
  assert.ok(qty * 100 * (1 + CORE_PRICE_MARGIN) <= 100, "a fill a margin higher still fits");
});

test("sweepQuantity is 0 with zero or negative excess", () => {
  assert.equal(sweep({ freeCash: BUFFER }), 0);
  assert.equal(sweep({ freeCash: BUFFER - 10 }), 0);
  assert.equal(sweep({ freeCash: 0 }), 0);
});

test("sweepQuantity is 0 just under the minimum order and buys at the minimum", () => {
  assert.equal(sweep({ freeCash: BUFFER + CORE_MIN_ORDER_GBP - 0.01 }), 0);
  assert.ok(sweep({ freeCash: BUFFER + CORE_MIN_ORDER_GBP }) > 0);
});

test("sweepQuantity leaves cash reserved for stocks alone", () => {
  assert.equal(sweep({ reservedForStocks: 100 }), 0);
  assert.equal(sweep({ reservedForStocks: 50 }), 0.495049);
});

test("sweepQuantity honours the instrument's precision and refuses a bad price", () => {
  assert.equal(sweep({ freeCash: BUFFER + 250, precision: 0 }), 2);
  assert.equal(sweep({ corePrice: 0 }), 0);
  assert.equal(sweep({ corePrice: Number.NaN }), 0);
  assert.equal(sweep({ equity: Number.NaN }), 0);
});

test("fundingSale covers the shortfall plus the buffer, sized a margin below the price", () => {
  const qty = fund();
  // 120 shortfall + 30 buffer = 150 GBP at 100, sized against 99: 1.515151 shares.
  assert.equal(qty, 1.515151);
  assert.ok(qty * 100 >= 150, "the sale covers the target at the last price");
});

test("fundingSale is 0 for a zero or negative shortfall", () => {
  assert.equal(fund({ shortfall: 0 }), 0);
  assert.equal(fund({ shortfall: -50 }), 0);
});

test("fundingSale caps a shortfall larger than the whole core at the floor", () => {
  const qty = fund({ shortfall: 5000, coreQuantity: 2 });
  assert.equal(qty, 2 - CORE_FLOOR_QUANTITY);
  assert.ok(2 - qty >= CORE_FLOOR_QUANTITY - 1e-9, "the floor is kept");
});

test("fundingSale sells nothing when the core is exactly at, or below, the floor", () => {
  assert.equal(fund({ coreQuantity: CORE_FLOOR_QUANTITY }), 0);
  assert.equal(fund({ coreQuantity: CORE_FLOOR_QUANTITY / 2 }), 0);
  assert.equal(fund({ coreQuantity: 0 }), 0);
});

test("fundingSale keeps the floor after rounding to the instrument's precision", () => {
  const coreQuantity = 1.3;
  const qty = fund({ shortfall: 5000, coreQuantity, precision: 0 });
  assert.equal(qty, 1);
  assert.ok(coreQuantity - qty >= CORE_FLOOR_QUANTITY);
});

test("fundingSale refuses a bad price or equity rather than guessing", () => {
  assert.equal(fund({ corePrice: 0 }), 0);
  assert.equal(fund({ corePrice: Number.NaN }), 0);
  assert.equal(fund({ equity: Number.NaN }), 0);
});
