/** US-market-time helpers, computed in America/New_York so DST is handled automatically. */
import { formatInTimeZone } from "date-fns-tz";

const ET = "America/New_York";

// NYSE full-day closures, ET calendar date (YYYY-MM-DD). Observed date used when a
// holiday falls on a weekend. Covers 2026-2027; last updated 2026: refresh yearly.
const US_MARKET_HOLIDAYS = new Set<string>([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // Martin Luther King Jr. Day
  "2026-02-16", // Washington's Birthday (Presidents' Day)
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed; July 4 falls on Saturday)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // Martin Luther King Jr. Day
  "2027-02-15", // Washington's Birthday (Presidents' Day)
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (observed; June 19 falls on Saturday)
  "2027-07-05", // Independence Day (observed; July 4 falls on Sunday)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving Day
  "2027-12-24", // Christmas Day (observed; December 25 falls on Saturday)
]);

export function nyParts(date: Date): { weekday: string; hour: number; minute: number } {
  // formatInTimeZone renders the instant in ET regardless of the host tz; "H"/"m" are
  // unpadded 24h hour/minute, "EEE" the short weekday ("Mon").
  return {
    weekday: formatInTimeZone(date, ET, "EEE"),
    hour: Number(formatInTimeZone(date, ET, "H")),
    minute: Number(formatInTimeZone(date, ET, "m")),
  };
}

/** True during US regular trading hours (Mon-Fri, 09:30-16:00 ET). DST-aware. */
export function isUsMarketOpen(date: Date): boolean {
  const { weekday, hour, minute } = nyParts(date);
  if (weekday === "Sat" || weekday === "Sun") return false;
  if (US_MARKET_HOLIDAYS.has(etDateString(date))) return false;
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** Calendar date in America/New_York as YYYY-MM-DD (the trading "day" key). */
export function etDateString(date: Date): string {
  return formatInTimeZone(date, ET, "yyyy-MM-dd");
}
