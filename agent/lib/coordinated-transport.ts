import { executionLease, executionScope } from "./execution-context.ts";
import { parseQuantityPrecision } from "./execution.ts";
import type { T212Env } from "./t212.ts";
import { isDryRun, resolveLimits } from "./state.ts";
import { executionSessionOpen } from "../../convex/executionCalendar.ts";
import { researchDay, researchSession } from "../../convex/shadowCalendar.ts";
import { resolveFencedOrder } from "./order-resolution.ts";
import type { BrokerGet } from "./reconcile-execution.ts";
import type { ExecutionScope } from "./execution-context.ts";

function resolutionStores(scope: ExecutionScope) {
  return scope.reconciliation && scope.inventory
    ? { coordination: scope.store, reconciliation: scope.reconciliation, inventory: scope.inventory } : undefined;
}

/** A fence left by an earlier run (crash, slow fill) must resolve before this scope touches the broker. */
function recoverEarlierFence(scope: ExecutionScope, get: BrokerGet): Promise<void> {
  const stores = resolutionStores(scope);
  if (!stores) return Promise.resolve();
  return scope.recovery ??= (async () => {
    const { env, account } = scope.identity;
    if (!(await scope.store.status({ env, account })).unresolvedWrite) return;
    await resolveFencedOrder({ env, account, stores, get, signal: scope.signal, wait: scope.wait, attempts: 2 });
  })();
}

/** One physical attempt; no retry crosses this boundary without durable readmission. */
export async function coordinatedBrokerRequest<T>(args: { env: T212Env; method: string; path: string; body?: unknown;
  send: (signal: AbortSignal) => Promise<Response>; error: (status: number, text: string) => Error; get: BrokerGet }): Promise<T> {
  const scope = executionScope();
  if (scope.identity.env !== args.env) throw new Error("Broker environment does not match execution owner");
  await recoverEarlierFence(scope, args.get);
  const read = args.method === "GET";
  const body = args.body as { ticker?: unknown; quantity?: unknown } | undefined;
  const ticker = typeof body?.ticker === "string" ? body.ticker : "";
  const quantity = typeof body?.quantity === "number" ? body.quantity : 0;
  if (!read && (args.method !== "POST" || args.path !== "/equity/orders/market"))
    throw new Error("This broker write is not admitted by the execution contract");
  if (!read && isDryRun()) throw new Error("DRY_RUN blocks physical broker orders");
  scope.signal?.throwIfAborted();
  const lease = await executionLease(scope);
  const { operationId, leaseUntil } = await scope.store.begin({ ...lease, key: `${lease.owner}/${scope.callId}/${args.method}/${args.path}/${ticker}`,
    kind: read ? "read" : "write", ticker, quantity, entryLimit: resolveLimits().maxNewPositionsPerDay });
  const settle = (outcome: Parameters<typeof scope.store.settle>[0]["outcome"], extras = {}) =>
    scope.store.settle({ ...lease, operationId, outcome, ...extras });
  // Readmission can complete after a local pause. Recheck immediately before fetch;
  // an expired lease, cancellation or closed market cannot authorize a delayed send.
  if (scope.signal?.aborted || Date.now() >= leaseUntil || (!read && !executionSessionOpen(Date.now(), ticker, researchSession(researchDay(Date.now()))))) {
    await settle(read ? "read-failed" : "not-sent");
    throw new Error("Broker request not sent: admission expired, cancelled or market closed");
  }
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(scope.signal ? [scope.signal] : [])]);
  let response: Response, text: string;
  try { response = await args.send(signal); text = await response.text(); }
  catch {
    await settle(read ? "read-failed" : "unknown").catch(() => {});
    throw new Error(read ? "Broker read unavailable" : "Broker order outcome unknown; reconciliation required, do not resend");
  }
  if (!response.ok) {
    // These documented validation/authentication failures prove rejection. Rate limits,
    // timeouts and server failures never prove non-placement and never replay the POST.
    const rejected = [400, 401, 403].includes(response.status);
    await settle(read ? "read-failed" : rejected ? "rejected" : "unknown", {
      retryableRejection: !read && response.status === 400 && parseQuantityPrecision(text) !== null,
    });
    if (!read && !rejected) throw new Error("Broker order outcome unknown; reconciliation required, do not resend");
    throw args.error(response.status, text);
  }
  let result: unknown;
  try { result = text ? JSON.parse(text) : undefined; }
  catch {
    await settle(read ? "read-failed" : "unknown").catch(() => {});
    throw new Error(read ? "Invalid broker read response" : "Broker order outcome unknown; reconciliation required, do not resend");
  }
  if (read) { await settle("read-completed"); return result as T; }
  const order = result as { id?: unknown; status?: unknown; quantity?: unknown; filledQuantity?: unknown;
    ticker?: unknown; instrument?: { ticker?: unknown }; side?: unknown } | null;
  const id = typeof order?.id === "number" && Number.isSafeInteger(order.id) && order.id > 0 ? order.id : undefined;
  const matches = id !== undefined && (order?.instrument?.ticker ?? order?.ticker) === ticker &&
    order?.side === (quantity > 0 ? "BUY" : "SELL") && typeof order.quantity === "number" &&
    Math.abs(Math.abs(order.quantity) - Math.abs(quantity)) < 1e-9;
  const filled = matches && order?.status === "FILLED" && typeof order.filledQuantity === "number" &&
    Math.abs(Math.abs(order.filledQuantity) - Math.abs(quantity)) < 1e-9;
  await settle(filled ? "filled" : matches ? "pending" : "unknown", id === undefined ? {} : { brokerOrderId: id });
  const stores = resolutionStores(scope);
  if (!matches || !stores) throw new Error("Broker order requires reconciliation; no additional orders are admitted");
  // Only a complete broker history, booked into the ledger, returns the order to the caller.
  const resolved = await resolveFencedOrder({ env: scope.identity.env, account: scope.identity.account, stores,
    get: args.get, signal: scope.signal, wait: scope.wait, handoff: lease });
  if (resolved.classification === "rejected") throw args.error(400, JSON.stringify({ detail: "Order ended at the broker without a fill" }));
  return { ...order, status: "FILLED", filledQuantity: order!.quantity } as T;
}
