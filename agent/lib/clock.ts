/** US-market-time helpers, computed in America/New_York so DST is handled automatically. */
import { formatInTimeZone } from "date-fns-tz";

const ET = "America/New_York";

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
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** Calendar date in America/New_York as YYYY-MM-DD (the trading "day" key). */
export function etDateString(date: Date): string {
  return formatInTimeZone(date, ET, "yyyy-MM-dd");
}
