import { AsyncLocalStorage } from "node:async_hooks";
import { memoryFromEnv } from "./memory.ts";
import { tradingEnv } from "./risk-runtime.ts";
import type { ExecutionIdentity, ExecutionLease, ExecutionStore } from "./execution-store.ts";
import { normalizeExecutionAccount } from "../../convex/executionConfig.ts";

interface Caller { session?: { id: string; turn: { id: string }; parent?: unknown }; callId?: string; abortSignal?: AbortSignal }
export interface ExecutionScope { identity: ExecutionIdentity; callId: string; signal?: AbortSignal; store: ExecutionStore }
const execution = new AsyncLocalStorage<ExecutionScope | undefined>();
export function coordinationEnabled(): boolean { return process.env.EXECUTION_COORDINATION_ENABLED === "true"; }
export function withExecutionContext<T>(ctx: Caller | undefined, run: () => T): T {
  if (!coordinationEnabled()) return run();
  // Child reviewers never receive a root account owner. A broker call without a scope fails closed.
  if (!ctx?.session?.id || !ctx.session.turn?.id || !ctx.callId || ctx.session.parent) return execution.run(undefined, run);
  const account = normalizeExecutionAccount(process.env.EXECUTION_ACCOUNT_ID);
  if (!account) return execution.run(undefined, run);
  return execution.run({ identity: { env: tradingEnv(), account, owner: `${ctx.session.id}/${ctx.session.turn.id}` },
    callId: ctx.callId, signal: ctx.abortSignal, store: memoryFromEnv(undefined, { timeoutMs: 4_000 }).executionStore() }, run);
}
/** Also used by tests to exercise the physical transport with a fake durable store. */
export function runExecutionScope<T>(scope: ExecutionScope, run: () => T): T { return execution.run(scope, run); }
export function executionScope(): ExecutionScope {
  const scope = execution.getStore();
  if (!scope) throw new Error("Broker access requires a trusted execution context");
  return scope;
}
export async function executionLease(scope: ExecutionScope): Promise<ExecutionLease> {
  const { generation } = await scope.store.claim(scope.identity);
  return { ...scope.identity, generation };
}
