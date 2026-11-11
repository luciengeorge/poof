import { researchSession, shadowTick } from "../../../convex/shadowCalendar.ts";
import type { ForecastRow, RunRecord } from "./store.ts";

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
export function shadowReport(day: string, events: ForecastRow[], runs: RunRecord[], now: number, truncated = false) {
  const states: Record<string, number> = {}, reasons: Record<string, number> = {};
  for (const row of events) {
    states[row.state] = (states[row.state] ?? 0) + 1;
    if (row.reason) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  }
  const scored = events.filter((e) => e.state === "scored" && e.outcome);
  const clusters = new Map<string, number[]>();
  for (const e of scored) clusters.set(e.story, [...(clusters.get(e.story) ?? []), e.outcome!.brier]);
  const session = researchSession(day);
  const expected = { positions: 0, news: 0 };
  if (session && session !== "unsupported") for (let t = session.open; t < Math.min(now, session.close); t += 60_000) {
    if ([12, 15, 18].includes(new Date(t).getUTCHours())) continue;
    if (!("reason" in shadowTick(t, 5, 2))) expected.positions++;
    if (!("reason" in shadowTick(t, 15))) expected.news++;
  }
  const coverage = Object.fromEntries((["positions", "news"] as const).map((kind) => {
    const observed = runs.filter((r) => r.kind === kind);
    const completed = observed.filter((r) => r.status === "completed").length;
    return [kind, { expected: expected[kind], attempted: observed.length, completed,
      failed: observed.filter((r) => r.status === "failed").length,
      skipped: observed.filter((r) => r.status === "skipped").length,
      missing: Math.max(0, expected[kind] - observed.length),
      positionStateUnavailable: observed.filter((r) => r.reason === "position-state-unavailable").length,
      freshQuotes: observed.reduce((n, r) => n + (r.quotes?.length ?? 0), 0) }];
  }));
  const horizons: Record<string, number> = {};
  const runReasons: Record<string, number> = {};
  for (const run of runs) if (run.reason) runReasons[run.reason] = (runReasons[run.reason] ?? 0) + 1;
  for (const e of events) if (e.start && e.committedAt) {
    const days = Math.round((Date.parse(e.start.sessionDay) - Date.parse(day)) / 86_400_000);
    horizons[`${days}-calendar-days`] = (horizons[`${days}-calendar-days`] ?? 0) + 1;
  }
  const calibration = Array.from({ length: 10 }, (_, bin) => {
    const rows = scored.filter((e) => Math.min(9, Math.floor(e.probability! * 10)) === bin);
    return { lower: bin / 10, upper: (bin + 1) / 10, count: rows.length,
      meanProbability: mean(rows.map((e) => e.probability!)), observedRate: mean(rows.map((e) => e.outcome!.up ? 1 : 0)) };
  });
  return { contract: "event-relative-v1", day, truncated, states, reasons, runReasons, coverage, horizons, calibration,
    requests: runs.reduce((n, r) => n + (r.requests ?? 0), 0),
    scored: scored.length, uniqueStoryClusters: clusters.size, tradingDateClusters: scored.length ? 1 : 0,
    brier: mean(scored.map((e) => e.outcome!.brier)), constantBrier: scored.length ? 0.25 : null,
    frozenBaseRateBrier: mean(scored.flatMap((e) => e.outcome!.baseRateBrier === null ? [] : [e.outcome!.baseRateBrier])),
    baselineUnavailable: scored.filter((e) => e.outcome!.baseRateBrier === null).length,
    storyWeightedBrier: mean([...clusters.values()].map((xs) => mean(xs)!)),
    note: "Descriptive research only. One date is one date cluster; no confidence interval or alpha claim. Exact-headline/URL dedup may miss syndication with different headlines. Missing ticks include disabled/deployment gaps. Exclusion windows are omitted from expected ticks." };
}
