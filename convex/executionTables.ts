import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shadowEnv } from "./shadowTypes";
import { orderEvidence } from "./reconciliationTypes";

export const executionTables = {
  executionAccounts: defineTable({ env: shadowEnv, account: v.string(), owner: v.string(), generation: v.number(),
    leaseUntil: v.number(), draining: v.boolean(), activeReads: v.array(v.id("executionOperations")),
    activeWrite: v.optional(v.id("executionOperations")),
    reconciliationFor: v.optional(v.id("executionOperations")),
    reconciliationReads: v.optional(v.number()),
  }).index("by_env_and_account", ["env", "account"]),
  executionOperations: defineTable({ env: shadowEnv, account: v.string(), key: v.string(), owner: v.string(), generation: v.number(),
    kind: v.union(v.literal("read"), v.literal("write")), ticker: v.string(), quantity: v.number(),
    day: v.string(), state: v.string(), attempt: v.number(), startedAt: v.number(), finishedAt: v.optional(v.number()),
    retryableRejection: v.optional(v.boolean()), brokerOrderId: v.optional(v.number()),
  }).index("by_env_and_account_and_key", ["env", "account", "key"]),
  executionDays: defineTable({ env: shadowEnv, account: v.string(), day: v.string(), baselineEntries: v.number(), entryLimit: v.number() })
    .index("by_env_and_account_and_day", ["env", "account", "day"]),
  executionEntries: defineTable({ env: shadowEnv, account: v.string(), day: v.string(), operationId: v.id("executionOperations"), released: v.boolean() })
    .index("by_env_and_account_and_day_and_released", ["env", "account", "day", "released"])
    .index("by_operationId", ["operationId"]),
  executionEvidence: defineTable({ env: shadowEnv, account: v.string(), owner: v.string(), generation: v.number(),
    operationId: v.id("executionOperations"), brokerOrderId: v.number(), observedAt: v.number(), recordedAt: v.number(),
    readRequests: v.number(), evidence: orderEvidence,
  }).index("by_env_and_account_and_owner", ["env", "account", "owner"]),
};
