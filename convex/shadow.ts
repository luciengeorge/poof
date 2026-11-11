import { query, mutation, type MutationCtx } from "./_generated/server";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { assertSecret } from "./auth";
import { nextResearchSession, researchDay, researchSession, shadowTick } from "./shadowCalendar";
import { shadowEnv, shadowKind, shadowObservation, shadowQuote, shadowScreen, shadowStart, shadowOutcome } from "./shadowTypes";

// Shadow-only headroom. These limits never modify or reserve live-trading state.
const limiter = new RateLimiter(components.rateLimiter, {
  finnhub: { kind: "token bucket", rate: 20, period: 60_000, capacity: 2 },
  tiingo: { kind: "fixed window", rate: 2, period: 3_600_000 },
  jev: { kind: "fixed window", rate: 40, period: 86_400_000 },
  forecast: { kind: "fixed window", rate: 20, period: 86_400_000 },
});
const credentials = { token: v.string(), env: shadowEnv };
declare const process: { env: Record<string, string | undefined> };
function assertEnabled() {
  if (process.env.SHADOW_RESEARCH_ENABLED !== "true" || process.env.SHADOW_FEED_QUOTAS_VERIFIED !== "true") {
    throw new Error("Shadow research disabled");
  }
}
const ownership = { ...credentials, runId: v.id("shadowRuns"), owner: v.string() };
async function owned(ctx: MutationCtx, args: { runId: Id<"shadowRuns">; owner: string; env: string }) {
  assertEnabled();
  const run = await ctx.db.get(args.runId);
  if (!run || run.env !== args.env || run.owner !== args.owner || run.status !== "running" || run.leaseUntil <= Date.now()) {
    throw new Error("Shadow lease unavailable");
  }
  return run;
}

export const claim = mutation({
  args: { ...credentials, kind: shadowKind, owner: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    assertEnabled();
    const now = Date.now();
    const tick = shadowTick(now, args.kind === "news" ? 15 : 5, args.kind === "positions" ? 2 : 0);
    if ([12, 15, 18].includes(new Date(now).getUTCHours())) return { reason: "live-window" };
    const day = researchDay(now);
    const calendar = researchSession(day);
    if (calendar === "unsupported") return { reason: "calendar-unsupported" };
    if (args.kind !== "score" && "reason" in tick) return { reason: tick.reason };
    const slot = args.kind === "score" ? Math.floor(now / 3_600_000) : (tick.slot ?? -1);
    const exists = await ctx.db.query("shadowRuns").withIndex("by_env_and_day_and_kind_and_slot", (q) =>
      q.eq("env", args.env).eq("day", day).eq("kind", args.kind).eq("slot", slot)).first();
    if (exists) return { reason: "already-attempted" };
    const active = await ctx.db.query("shadowRuns").withIndex("by_env_and_status", (q) => q.eq("env", args.env).eq("status", "running")).take(10);
    if (active.some((r) => r.leaseUntil > now)) return { reason: "another-shadow-run-active" };
    for (const row of active) await ctx.db.patch(row._id, { status: "failed", reason: "lease-expired", finishedAt: now });
    for (const state of ["new", "attempting", "committed"]) {
      const abandoned = await ctx.db.query("shadowEvents").withIndex("by_env_and_state_and_targetClose", (q) =>
        q.eq("env", args.env).eq("state", state)).take(100);
      for (const event of abandoned) if (now - (event.committedAt ?? event.inputCutoff ?? event.firstSeenAt) > 240_000) {
        await ctx.db.patch(event._id, { state: "unscoreable", reason: `${state}-expired` });
      }
    }
    const runId = await ctx.db.insert("shadowRuns", { env: args.env, day, kind: args.kind, slot,
      owner: args.owner, startedAt: now, leaseUntil: now + 240_000, status: "running" });
    return { runId, day, slot, startedAt: now };
  },
});

export const permit = mutation({
  args: { ...ownership, provider: v.union(v.literal("finnhub"), v.literal("tiingo"), v.literal("jev")) },
  handler: async (ctx, args) => {
    assertSecret(args.token); const run = await owned(ctx, args);
    const limit = await limiter.limit(ctx, args.provider, { key: args.provider === "jev" ? `${args.env}:${run.day}` : "shadow" });
    if (limit.ok) await ctx.db.patch(run._id, { requests: (run.requests ?? 0) + 1 });
    return limit.ok;
  },
});

export const inputs = mutation({
  args: ownership,
  handler: async (ctx, args) => {
    assertSecret(args.token); const run = await owned(ctx, args);
    let day = await ctx.db.query("shadowDays").withIndex("by_env_and_day", (q) => q.eq("env", args.env).eq("day", run.day)).first();
    if (!day) {
      const shortlist = await ctx.db.query("funnelItems").withIndex("by_day_and_score", (q) => q.eq("day", run.day)).order("desc").take(60);
      const symbols = [...new Set(shortlist.map((i) => i.ticker))].filter((s) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(s) && s !== "SPY").slice(0, 12);
      const session = researchSession(run.day);
      const cutoff = session && session !== "unsupported" ? session.open : run.startedAt;
      const past = await ctx.db.query("shadowEvents").withIndex("by_env_and_state_and_targetClose", (q) =>
        q.eq("env", args.env).eq("state", "scored").lt("targetClose", cutoff)).order("desc").take(200);
      const next = nextResearchSession(run.startedAt);
      const bucket = next ? Math.round((Date.parse(next.day) - Date.parse(run.day)) / 86_400_000) : 0;
      const sample = past.filter((e) => e.outcome && e.outcome.scoredAt < cutoff && e.start && e.committedAt &&
        Math.round((Date.parse(e.start.sessionDay) - Date.parse(researchDay(e.committedAt))) / 86_400_000) === bucket);
      const baseline = sample.length >= 20 ? sample.filter((e) => e.outcome?.up).length / sample.length : null;
      const id = await ctx.db.insert("shadowDays", { env: args.env, day: run.day, frozenAt: Date.now(), symbols,
        baseline, baselineCount: sample.length, baselineCutoff: cutoff });
      day = (await ctx.db.get(id))!;
    }
    const rows = await ctx.db.query("trades").withIndex("by_env_side_status", (q) =>
      q.eq("env", args.env).eq("side", "BUY").eq("status", "placed")).take(21);
    const held = rows.filter((r) => !r.dryRun && r.ticker !== "VUAGl_EQ").slice(0, 4).map((r) => ({
      ticker: r.ticker, generation: String(r._id), thesis: r.thesis, openedAt: r.createdAt,
      observedAt: r.lastSeenAt ?? null,
    }));
    const cursors = await Promise.all([...new Set([...held.map((r) => r.ticker.replace(/_US_EQ$/i, "")), ...day.symbols])].slice(0, 16).map(async (ticker) => {
      const row = await ctx.db.query("shadowCursors").withIndex("by_env_and_ticker", (q) => q.eq("env", args.env).eq("ticker", ticker)).first();
      return { ticker, through: row?.through ?? run.startedAt - 36 * 3_600_000 };
    }));
    // Existing records have original order quantity, not broker-observed quantity. Never invent
    // a coherent snapshot from them. A remains quote collection until that data contract exists.
    return { day, held, cursors, positionStateAvailable: false as const, reason: "position-state-unavailable" };
  },
});

export const finish = mutation({
  args: { ...ownership, status: v.union(v.literal("completed"), v.literal("failed"), v.literal("skipped")),
    reason: v.optional(v.string()), observations: v.array(shadowObservation), quotes: v.array(shadowQuote) },
  handler: async (ctx, args) => {
    assertSecret(args.token); await owned(ctx, args);
    if (args.observations.length > 4 || args.quotes.length > 16) throw new Error("Shadow observation cap");
    // No complete broker-quantity snapshot is available yet; reject manufactured exit evidence.
    if (args.observations.length) throw new Error("Confirmed position snapshot unavailable");
    await ctx.db.patch(args.runId, { status: args.status, reason: args.reason?.slice(0, 120),
      finishedAt: Date.now(), quotes: args.quotes, observations: args.observations });
  },
});

export const ingest = mutation({
  args: { ...ownership, ticker: v.string(), through: v.number(), truncated: v.boolean(),
    items: v.array(v.object({ story: v.string(), url: v.string(), headline: v.string(), summary: v.string(),
      source: v.string(), publishedAt: v.number(), firstSeenAt: v.number(), eligible: v.boolean(), reason: v.optional(v.string()) })) },
  handler: async (ctx, args) => {
    assertSecret(args.token); const run = await owned(ctx, args);
    if (run.kind !== "news" || args.items.length > 50 || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(args.ticker) ||
        !Number.isFinite(args.through) || args.through > Date.now()) throw new Error("Invalid news batch");
    const day = await ctx.db.query("shadowDays").withIndex("by_env_and_day", (q) => q.eq("env", args.env).eq("day", run.day)).unique();
    if (!day) throw new Error("Cohort not frozen");
    const held = await ctx.db.query("trades").withIndex("by_env_side_status", (q) =>
      q.eq("env", args.env).eq("side", "BUY").eq("status", "placed")).take(21);
    if (!day.symbols.includes(args.ticker) && !held.some((r) => !r.dryRun && r.ticker === `${args.ticker}_US_EQ`)) throw new Error("Outside shadow cohort");
    const ids: Id<"shadowEvents">[] = [];
    for (const item of args.items) {
      if (!item.story || item.headline.length > 500 || item.summary.length > 2_000 || item.url.length > 1_000 ||
          item.story.length > 350 || item.source.length > 120 || !Number.isFinite(item.publishedAt) ||
          !Number.isFinite(item.firstSeenAt) || item.firstSeenAt > Date.now()) throw new Error("Invalid news item");
      let existing = await ctx.db.query("shadowEvents").withIndex("by_env_and_story_and_ticker", (q) =>
        q.eq("env", args.env).eq("story", item.story).eq("ticker", args.ticker)).first();
      if (!existing && item.url) existing = await ctx.db.query("shadowEvents").withIndex("by_env_and_url_and_ticker", (q) =>
        q.eq("env", args.env).eq("url", item.url).eq("ticker", args.ticker)).first();
      if (existing) {
        if (existing.lastVersion !== `${item.headline}\n${item.summary}`) {
          await ctx.db.insert("shadowRevisions", { eventId: existing._id, version: existing.versions + 1,
            observedAt: item.firstSeenAt, headline: item.headline, summary: item.summary,
            source: item.source, publishedAt: item.publishedAt });
          await ctx.db.patch(existing._id, { versions: existing.versions + 1, lastVersion: `${item.headline}\n${item.summary}` });
        }
        continue; // Never update the original forecast evidence or ask the model again for a correction.
      }
      const { eligible, reason, ...evidence } = item;
      const session = researchSession(researchDay(item.firstSeenAt));
      const allowed = eligible && item.publishedAt > 0 && item.publishedAt <= item.firstSeenAt &&
        item.firstSeenAt - item.publishedAt <= 900_000 && session && session !== "unsupported" &&
        item.firstSeenAt >= session.open && item.firstSeenAt < session.close;
      const id = await ctx.db.insert("shadowEvents", { ...evidence, env: args.env, day: run.day, ticker: args.ticker,
        contract: "event-relative-v1",
        versions: 1, lastVersion: `${item.headline}\n${item.summary}`, state: allowed ? "new" : "ineligible",
        reason: allowed ? undefined : (reason ?? "ineligible-at-ingest"), baseline: day.baseline, baselineCutoff: day.baselineCutoff, targetClose: 0 });
      if (allowed) ids.push(id);
    }
    // Cursor and durable rows commit together. A truncated feed never claims complete processing.
    if (!args.truncated) {
      const cursor = await ctx.db.query("shadowCursors").withIndex("by_env_and_ticker", (q) => q.eq("env", args.env).eq("ticker", args.ticker)).first();
      if (!cursor) await ctx.db.insert("shadowCursors", { env: args.env, ticker: args.ticker, through: args.through });
      else await ctx.db.patch(cursor._id, { through: Math.max(cursor.through, args.through) });
    }
    return ids;
  },
});

export const attempt = mutation({
  args: { ...ownership, eventId: v.id("shadowEvents"), attemptId: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token); await owned(ctx, args);
    const row = await ctx.db.get(args.eventId);
    if (!row || row.env !== args.env || row.state !== "new") return null;
    const now = Date.now();
    const limit = await limiter.limit(ctx, "forecast", { key: `${args.env}:${row.day}` });
    if (!limit.ok || now - row.publishedAt > 15 * 60_000) {
      await ctx.db.patch(row._id, { state: "unscoreable", reason: limit.ok ? "stale-before-attempt" : "forecast-budget" });
      return null;
    }
    await ctx.db.patch(row._id, { state: "attempting", attemptId: args.attemptId, inputCutoff: now });
    return { ...row, inputCutoff: now };
  },
});

export const prediction = mutation({
  args: { ...ownership, eventId: v.id("shadowEvents"), attemptId: v.string(),
    probability: v.union(v.number(), v.null()), model: v.string(), completedAt: v.number(), screen: v.optional(shadowScreen),
    reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    assertSecret(args.token); await owned(ctx, args);
    const row = await ctx.db.get(args.eventId);
    if (!row || row.env !== args.env || row.state !== "attempting" || row.attemptId !== args.attemptId) return null;
    const now = Date.now();
    if (!Number.isFinite(args.completedAt) || args.completedAt > now || args.completedAt < row.inputCutoff! ||
        (args.probability !== null && (!Number.isFinite(args.probability) || args.probability < 0 || args.probability > 1))) throw new Error("Invalid prediction");
    const session = nextResearchSession(now);
    await ctx.db.patch(row._id, { state: args.probability === null || !session ? "unscoreable" : "committed",
      reason: args.probability === null ? (args.reason ?? "abstained") : session ? undefined : "calendar-unsupported",
      ...(args.probability !== null ? { probability: args.probability } : {}),
      model: args.model.slice(0, 100), screen: args.screen, completedAt: args.completedAt, committedAt: now,
      targetClose: session?.close ?? 0 });
    return session ? { committedAt: now, session } : null;
  },
});

export const attachStart = mutation({
  args: { ...ownership, eventId: v.id("shadowEvents"), start: v.union(shadowStart, v.null()) },
  handler: async (ctx, args) => {
    assertSecret(args.token); await owned(ctx, args);
    const row = await ctx.db.get(args.eventId);
    if (!row || row.env !== args.env || row.state !== "committed") return false;
    const start = args.start; const now = Date.now(); const commit = row.committedAt!;
    const session = nextResearchSession(commit);
    if (start && (start.stock.symbol !== row.ticker || start.proxy.symbol !== "SPY" ||
        !session || start.sessionOpen !== session.open || start.sessionDay !== session.day ||
        start.sessionClose !== row.targetClose || now - commit > 60_000 ||
        [start.stock, start.proxy].some((q) => q.price <= 0 || !Number.isFinite(q.price) || !Number.isFinite(q.at) || q.at < commit || q.at > now || now - q.at > 60_000) ||
        Math.abs(start.stock.at - start.proxy.at) > 5_000 || Math.max(start.stock.at, start.proxy.at) >= start.sessionOpen)) throw new Error("Invalid starting pair");
    await ctx.db.patch(row._id, start ? { state: "awaiting-outcome", start } : { state: "unscoreable", reason: "starting-pair-unavailable" });
    return true;
  },
});

export const due = query({
  args: { ...credentials, now: v.number() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    // Wait until the next day for final EOD data; missing bars remain pending.
    return await ctx.db.query("shadowEvents").withIndex("by_env_and_state_and_targetClose", (q) =>
      q.eq("env", args.env).eq("state", "awaiting-outcome").lt("targetClose", args.now - 12 * 3_600_000)).take(50);
  },
});
export const score = mutation({
  args: { ...ownership, eventId: v.id("shadowEvents"), outcome: shadowOutcome },
  handler: async (ctx, args) => {
    assertSecret(args.token); await owned(ctx, args);
    const row = await ctx.db.get(args.eventId);
    if (!row || row.env !== args.env || row.state !== "awaiting-outcome") return false;
    const o = args.outcome;
    if (![o.scoredAt, o.relativeReturn, o.brier, ...(o.baseRateBrier === null ? [] : [o.baseRateBrier])].every(Number.isFinite) ||
        o.source.length > 120 || o.scoredAt > Date.now() || o.scoredAt < row.targetClose ||
        o.up !== (o.relativeReturn > 0) || Math.abs(o.brier - (row.probability! - (o.up ? 1 : 0)) ** 2) > 1e-10 ||
        o.constantBrier !== 0.25 || (row.baseline === null ? o.baseRateBrier !== null :
          o.baseRateBrier === null || Math.abs(o.baseRateBrier - (row.baseline - (o.up ? 1 : 0)) ** 2) > 1e-10)) throw new Error("Invalid outcome");
    await ctx.db.patch(row._id, { state: "scored", outcome: o }); return true;
  },
});

export const report = query({
  args: { ...credentials, day: v.string() },
  handler: async (ctx, args) => {
    assertSecret(args.token);
    const events = await ctx.db.query("shadowEvents").withIndex("by_env_and_day", (q) => q.eq("env", args.env).eq("day", args.day)).take(801);
    const runs = await ctx.db.query("shadowRuns").withIndex("by_env_and_day_and_kind_and_slot", (q) => q.eq("env", args.env).eq("day", args.day)).take(150);
    return { events: events.slice(0, 800), runs, truncated: events.length > 800 || runs.length === 150 };
  },
});
