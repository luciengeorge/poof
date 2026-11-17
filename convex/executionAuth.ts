import { assertSecret } from "./auth";
import { normalizeExecutionAccount } from "./executionConfig";
declare const process: { env: Record<string, string | undefined> };

export function authorizeExecution(args: { token: string; account: string }, requireEnabled = true): void {
  assertSecret(args.token);
  const account = normalizeExecutionAccount(process.env.EXECUTION_ACCOUNT_ID);
  if ((requireEnabled && process.env.EXECUTION_COORDINATION_ENABLED !== "true") || !account || args.account !== account)
    throw new Error("Execution coordination unavailable");
}
