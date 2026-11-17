// England/Wales holidays and LSE half-days, verified 17 Nov 2026:
// https://www.londonstockexchange.com/en/resources/markets-products/business-days
// https://www.gov.uk/bank-holidays
const CLOSED = new Set(["2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28",
  "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31", "2027-08-30", "2027-12-27", "2027-12-28"]);
const HALF = new Set(["2026-12-24", "2026-12-31", "2027-12-24", "2027-12-31"]);
const london = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function executionSessionOpen(now: number, ticker: string, session: { open: number; close: number } | null | "unsupported"): boolean {
  if (ticker !== "VUAGl_EQ") {
    return !!session && session !== "unsupported" && now >= session.open && now < session.close;
  }
  const parts = london.formatToParts(now);
  const get = (name: string) => parts.find(p => p.type === name)!.value;
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  if (!/^202[67]-/.test(day) || CLOSED.has(day)) return false;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  // Conservative cutoff five minutes before the closing process; never queue core overnight.
  return weekday > 0 && weekday < 6 && minutes >= 480 && minutes < (HALF.has(day) ? 745 : 985);
}
