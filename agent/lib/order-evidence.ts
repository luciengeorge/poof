import type { FencedOrder, OrderEvidence } from "./reconciliation-store.ts";

const states = new Set(["LOCAL", "UNCONFIRMED", "CONFIRMED", "NEW", "CANCELLING", "CANCELLED", "PARTIALLY_FILLED", "FILLED", "REJECTED", "REPLACING", "REPLACED"]);
const object = (x: unknown): Record<string, unknown> | null => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : null;
export function matchesOrder(value: unknown, expected: FencedOrder): { status: string; filled: number } | null {
  const o = object(value), instrument = object(o?.instrument);
  const createdAt = typeof o?.createdAt === "string" ? Date.parse(o.createdAt) : NaN;
  if (o?.id !== expected.brokerOrderId || (instrument?.ticker ?? o?.ticker) !== expected.ticker ||
      o?.side !== (expected.quantity > 0 ? "BUY" : "SELL") || typeof o.quantity !== "number" || !Number.isFinite(o.quantity) ||
      Math.abs(Math.abs(o.quantity) - Math.abs(expected.quantity)) > 1e-9 || typeof o.filledQuantity !== "number" ||
      !Number.isFinite(o.filledQuantity) || Math.abs(o.filledQuantity) > Math.abs(expected.quantity) + 1e-9 ||
      typeof o.status !== "string" || !states.has(o.status) || !Number.isFinite(createdAt) ||
      createdAt < expected.startedAt - 10_000 || createdAt > Date.now()) return null;
  const filled = Math.abs(o.filledQuantity);
  if ((o.status === "FILLED" && Math.abs(filled - Math.abs(expected.quantity)) > 1e-9) ||
      (o.status === "REJECTED" && filled !== 0)) return null;
  return { status: o.status, filled };
}

/** Parse only a cursor, never follow a provider URL. Bounded pagination is not absence proof. */
export function nextHistoryCursor(path: unknown, ticker: string): number | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return null;
  const url = new URL(path, "https://reconciliation.invalid");
  if (url.origin !== "https://reconciliation.invalid" || !["/api/v0/equity/history/orders", "/equity/history/orders"].includes(url.pathname) || url.hash ||
      [...url.searchParams.keys()].some(k => !["cursor", "ticker", "limit"].includes(k)) ||
      url.searchParams.getAll("cursor").length !== 1 ||
      (url.searchParams.has("ticker") && (url.searchParams.getAll("ticker").length !== 1 || url.searchParams.get("ticker") !== ticker)) ||
      (url.searchParams.has("limit") && (url.searchParams.getAll("limit").length !== 1 || url.searchParams.get("limit") !== "50"))) return null;
  const raw = url.searchParams.get("cursor")!;
  if (!/^\d+$/.test(raw)) return null;
  const cursor = Number(raw);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
}

/** Describes a known order only. No output proves a position generation closed or allows a resend. */
export function classifyOrderEvidence(expected: FencedOrder, pending: unknown, history: unknown[], historyComplete: boolean, portfolio: unknown): OrderEvidence {
  const unknown = (reason: OrderEvidence["reason"]): OrderEvidence => ({ classification: "unknown", historyComplete, matchedFillCount: 0, reason });
  if (!Array.isArray(pending) || pending.length > 128 || !Array.isArray(portfolio) || portfolio.length > 128 || history.length > 150)
    return unknown("invalid-response");
  if (pending.some(x => !Number.isSafeInteger(object(x)?.id) || (object(x)!.id as number) <= 0) ||
      history.some(x => !Number.isSafeInteger(object(object(x)?.order)?.id) || (object(object(x)?.order)!.id as number) <= 0))
    return unknown("invalid-response");
  const quantities: number[] = [];
  for (const item of portfolio) {
    const position = object(item);
    if (!position || typeof position.ticker !== "string" || typeof position.quantity !== "number" ||
        !Number.isFinite(position.quantity) || position.quantity < 0) return unknown("invalid-response");
    if (position.ticker === expected.ticker) quantities.push(position.quantity);
  }
  if (quantities.length > 1) return unknown("invalid-response");
  const positionQuantity = quantities[0] ?? 0; // An observed quantity, NEVER proof a POST did not send.
  const active = pending.filter(x => object(x)?.id === expected.brokerOrderId);
  if (active.length > 1) return unknown("order-mismatch");
  const orders: unknown[] = active.length ? active : history.filter(x => object(object(x)?.order)?.id === expected.brokerOrderId).map(x => object(x)!.order);
  if (!orders.length) return { ...unknown(historyComplete ? "not-found" : "history-incomplete"), positionQuantity };
  const parsed = orders.map(x => matchesOrder(x, expected));
  if (parsed.some(x => !x) || parsed.some(x => x!.status !== parsed[0]!.status || x!.filled !== parsed[0]!.filled))
    return { ...unknown("order-mismatch"), positionQuantity };
  const { status, filled } = parsed[0]!;
  // Pending is an earlier observation and stays pending even if the subsequent portfolio is flat.
  const classification = active.length ? filled > 0 ? "partial" : "pending" :
    status === "FILLED" ? "filled" : ["REJECTED", "CANCELLED"].includes(status) && filled === 0 ? "rejected" :
    filled > 0 ? "partial" : "unknown";
  const fills = new Map<number, string>();
  for (const item of history) {
    const row = object(item);
    if (object(row?.order)?.id !== expected.brokerOrderId) continue;
    const fill = object(row?.fill);
    if (!fill) continue; // A rejected/cancelled order need not have a fill.
    if (!Number.isSafeInteger(fill.id) || (fill.id as number) <= 0 || typeof fill.quantity !== "number" ||
        !Number.isFinite(fill.quantity) || fill.quantity === 0 || fill.type !== "TRADE" ||
        typeof fill.price !== "number" || !Number.isFinite(fill.price) || fill.price <= 0 ||
        typeof fill.filledAt !== "string" || !Number.isFinite(Date.parse(fill.filledAt)))
      return { ...unknown("invalid-response"), positionQuantity };
    const fingerprint = JSON.stringify([fill.quantity, fill.price, fill.filledAt]);
    const previous = fills.get(fill.id as number);
    if (previous !== undefined && previous !== fingerprint) return { ...unknown("order-mismatch"), positionQuantity };
    fills.set(fill.id as number, fingerprint);
  }
  return { classification, filledQuantity: filled, positionQuantity, historyComplete, matchedFillCount: fills.size,
    reason: active.length ? "pending-order" : historyComplete ? "matched-history" : "history-incomplete" };
}
