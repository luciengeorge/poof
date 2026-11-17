import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shadowEnv } from "./shadowTypes";
import { orderEvidence } from "./reconciliationTypes";
import { reconciledFill } from "./inventoryTypes";

export const executionTables = {
  executionAccounts: defineTable({ env: shadowEnv, account: v.string(), owner: v.string(), generation: v.number(),
    leaseUntil: v.number(), draining: v.boolean(), activeReads: v.array(v.id("executionOperations")),
    activeWrite: v.optional(v.id("executionOperations")),
    reconciliationFor: v.optional(v.id("executionOperations")),
    reconciliationReads: v.optional(v.number()),
    inventoryInitialized: v.optional(v.boolean()),
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
    readRequests: v.number(), evidence: orderEvidence, fills: v.optional(v.array(reconciledFill)),
  }).index("by_env_and_account_and_owner", ["env", "account", "owner"]),
  positionGenerations: defineTable({ env: shadowEnv, account: v.string(), ticker: v.string(), generation: v.number(),
    status: v.union(v.literal("open"), v.literal("closed")), quantity: v.number(), averagePrice: v.number(),
    brokerAveragePrice: v.optional(v.number()),
    instrumentCurrency: v.union(v.literal("USD"), v.literal("GBP")), realizedPnlGbp: v.number(),
    origin: v.union(v.literal("broker-baseline"), v.literal("reconciled-buy")),
    openedAt: v.optional(v.number()), closedAt: v.optional(v.number()), observedAt: v.number(),
  }).index("by_env_and_account_and_ticker_and_generation", ["env", "account", "ticker", "generation"])
    .index("by_env_and_account_and_status", ["env", "account", "status"]),
  reconciledFills: defineTable({ env: shadowEnv, account: v.string(), operationId: v.id("executionOperations"),
    positionGenerationId: v.id("positionGenerations"), fill: reconciledFill, fingerprint: v.string(),
  }).index("by_env_and_account_and_fillId", ["env", "account", "fill.id"])
    .index("by_operationId", ["operationId"]),
  inventoryReceipts: defineTable({ env: shadowEnv, account: v.string(), evidenceId: v.id("executionEvidence"),
    operationId: v.id("executionOperations"), positionGenerationId: v.optional(v.id("positionGenerations")),
    fingerprint: v.string(), observedQuantity: v.number(), appliedFills: v.number(), recordedAt: v.number(),
  }).index("by_evidenceId", ["evidenceId"]),
};
