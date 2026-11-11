import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shadowEnv, shadowKind, shadowObservation, shadowQuote, shadowScreen, shadowStart, shadowOutcome } from "./shadowTypes";

export const shadowTables = {
  shadowDays: defineTable({ env: shadowEnv, day: v.string(), frozenAt: v.number(), symbols: v.array(v.string()),
    baseline: v.union(v.number(), v.null()), baselineCount: v.number(), baselineCutoff: v.number(),
  }).index("by_env_and_day", ["env", "day"]),
  shadowRuns: defineTable({ env: shadowEnv, day: v.string(), kind: shadowKind, slot: v.number(),
    owner: v.string(), startedAt: v.number(), leaseUntil: v.number(), status: v.string(),
    finishedAt: v.optional(v.number()), reason: v.optional(v.string()), requests: v.optional(v.number()),
    observations: v.optional(v.array(shadowObservation)), quotes: v.optional(v.array(shadowQuote)),
  }).index("by_env_and_day_and_kind_and_slot", ["env", "day", "kind", "slot"])
    .index("by_env_and_status", ["env", "status"]),
  shadowCursors: defineTable({ env: shadowEnv, ticker: v.string(), through: v.number(),
  }).index("by_env_and_ticker", ["env", "ticker"]),
  shadowRevisions: defineTable({ eventId: v.id("shadowEvents"), version: v.number(), observedAt: v.number(),
    headline: v.string(), summary: v.string(), source: v.string(), publishedAt: v.number(),
  }).index("by_event", ["eventId"]),
  shadowEvents: defineTable({ env: shadowEnv, day: v.string(), ticker: v.string(), story: v.string(),
    contract: v.literal("event-relative-v1"),
    url: v.string(), headline: v.string(), summary: v.string(), source: v.string(), publishedAt: v.number(),
    firstSeenAt: v.number(), versions: v.number(), lastVersion: v.string(), state: v.string(), reason: v.optional(v.string()),
    baseline: v.union(v.number(), v.null()), baselineCutoff: v.number(),
    attemptId: v.optional(v.string()), inputCutoff: v.optional(v.number()), completedAt: v.optional(v.number()),
    committedAt: v.optional(v.number()), probability: v.optional(v.number()), model: v.optional(v.string()),
    screen: v.optional(shadowScreen), start: v.optional(shadowStart), targetClose: v.number(),
    outcome: v.optional(shadowOutcome),
  }).index("by_env_and_story_and_ticker", ["env", "story", "ticker"])
    .index("by_env_and_url_and_ticker", ["env", "url", "ticker"])
    .index("by_env_and_state_and_targetClose", ["env", "state", "targetClose"])
    .index("by_env_and_day", ["env", "day"]),
};
