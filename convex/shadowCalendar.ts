// NYSE published calendar, verified 2026-11-11. Research only: never changes the live clock.
// https://www.nyse.com/trade/hours-calendars
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);
const EARLY = new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
const DAY = 86_400_000;
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23",
});
export function researchDay(ms: number): string {
  const parts = formatter.formatToParts(ms);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export interface ResearchSession { day: string; open: number; close: number }
export function researchSession(day: string): ResearchSession | null | "unsupported" {
  if (!/^202[67]-\d{2}-\d{2}$/.test(day)) return "unsupported";
  const noon = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(noon) || new Date(noon).toISOString().slice(0, 10) !== day) return "unsupported";
  const weekday = new Date(noon).getUTCDay();
  if (weekday === 0 || weekday === 6 || HOLIDAYS.has(day)) return null;
  const etHour = Number(formatter.formatToParts(noon).find((p) => p.type === "hour")!.value);
  const offset = 12 - etHour;
  return { day, open: Date.parse(`${day}T09:30:00Z`) + offset * 3_600_000,
    close: Date.parse(`${day}T${EARLY.has(day) ? "13" : "16"}:00:00Z`) + offset * 3_600_000 };
}
export function nextResearchSession(ms: number): ResearchSession | null {
  const start = Date.parse(`${researchDay(ms)}T12:00:00Z`);
  for (let n = 0; n < 10; n++) {
    const session = researchSession(new Date(start + n * DAY).toISOString().slice(0, 10));
    if (session === "unsupported") return null;
    if (session && session.open > ms) return session;
  }
  return null;
}
export function shadowTick(ms: number, interval: number, offset = 0) {
  const day = researchDay(ms);
  const session = researchSession(day);
  if (session === "unsupported") return { day, reason: "calendar-unsupported" } as const;
  if (!session || ms < session.open || ms >= session.close) return { day, reason: "market-closed" } as const;
  // Delay tolerance is one minute; a late invocation cannot impersonate an earlier observation.
  const minutes = Math.floor((ms - session.open) / 60_000);
  if (minutes % interval !== offset) return { day, reason: "not-due" } as const;
  // Reserve the whole legacy cron window and catch-up window; no added feed load during either.
  const utc = new Date(ms).getUTCHours();
  if (utc === 15 || utc === 18) return { day, reason: "live-window" } as const;
  return { day, slot: Math.floor(minutes / interval), session } as const;
}
export function recentResearchObservation(seenAt: number, now: number): boolean {
  if (!Number.isFinite(seenAt) || seenAt > now || now - seenAt > 4 * DAY) return false;
  const seen = researchSession(researchDay(seenAt));
  if (!seen || seen === "unsupported" || seenAt < seen.open || seenAt >= seen.close) return false;
  const current = researchSession(researchDay(now));
  if (!current || current === "unsupported") return false;
  if (seen.day === current.day) return true;
  return nextResearchSession(seen.close)?.day === current.day;
}
