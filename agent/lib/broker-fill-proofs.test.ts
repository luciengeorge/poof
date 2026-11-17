import { test } from "node:test";
import assert from "node:assert/strict";
import { brokerFillProofs } from "./broker-fill-proofs.ts";
import type { OrderEvidence } from "./reconciliation-store.ts";

const at = Date.parse("2026-11-17T15:00:00Z");
const expected = { operationId: "opaque", brokerOrderId: 123, ticker: "AAPL_US_EQ", quantity: -1, startedAt: at };
const order = { id: 123, ticker: expected.ticker, quantity: 1, side: "SELL", filledQuantity: 1, status: "FILLED", createdAt: new Date(at).toISOString() };
const fill = { id: 456, quantity: -1, price: 90, type: "TRADE", filledAt: new Date(at).toISOString(),
  walletImpact: { currency: "GBP", realisedProfitLoss: -7 } };
const evidence: OrderEvidence = { classification: "filled", filledQuantity: 1, positionQuantity: 0,
  historyComplete: true, matchedFillCount: 1, reason: "matched-history" };

test("only a complete known-order fill set becomes a normalized immutable GBP proof", t => {
  t.mock.method(Date, "now", () => at + 60_000);
  const rows = [{ order, fill }, { order, fill }];
  assert.deepEqual(brokerFillProofs(expected, rows, evidence, at + 60_000), [{ id: 456, quantity: 1, price: 90,
    filledAt: at, walletCurrency: "GBP", realizedPnlGbp: -7 }]);
  assert.equal(brokerFillProofs(expected, rows, { ...evidence, historyComplete: false }, at + 60_000), undefined);
  assert.equal(brokerFillProofs(expected, rows, { ...evidence, matchedFillCount: 2 }, at + 60_000), undefined);
});

test("missing/foreign SELL P&L, conflicting fill details and unrelated orders never become bookkeeping proofs", t => {
  t.mock.method(Date, "now", () => at + 60_000);
  for (const invalid of [
    { ...fill, walletImpact: { currency: "GBP" } },
    { ...fill, walletImpact: { currency: "USD", realisedProfitLoss: -7 } },
    { ...fill, filledAt: new Date(at + 120_000).toISOString() },
  ]) assert.equal(brokerFillProofs(expected, [{ order, fill: invalid }], evidence, at + 60_000), undefined);
  assert.equal(brokerFillProofs(expected, [{ order, fill }, { order, fill: { ...fill, walletImpact: { currency: "GBP", realisedProfitLoss: 99 } } }], evidence, at + 60_000), undefined);
  assert.equal(brokerFillProofs(expected, [{ order: { ...order, id: 999 }, fill }], evidence, at + 60_000), undefined);
});

test("BUY proofs cannot realize position profit and an empty history cannot manufacture a zero-fill rejection", t => {
  t.mock.method(Date, "now", () => at + 60_000);
  const buy = { ...expected, quantity: 1 }, buyOrder = { ...order, side: "BUY" };
  const buyFill = { ...fill, quantity: 1, walletImpact: { currency: "GBP" } };
  assert.equal(brokerFillProofs(buy, [{ order: buyOrder, fill: buyFill }], evidence, at + 60_000)![0].realizedPnlGbp, 0);
  assert.equal(brokerFillProofs(buy, [{ order: buyOrder, fill: { ...buyFill, walletImpact: { currency: "GBP", realisedProfitLoss: 1 } } }], evidence, at + 60_000), undefined);
  const rejected = { ...evidence, classification: "rejected" as const, filledQuantity: 0, matchedFillCount: 0 };
  assert.equal(brokerFillProofs(expected, [], rejected, at + 60_000), undefined);
  assert.deepEqual(brokerFillProofs(expected, [{ order: { ...order, status: "REJECTED", filledQuantity: 0 } }], rejected, at + 60_000), []);
});
