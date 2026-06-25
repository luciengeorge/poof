/** US-market-time helpers. Use `Intl` with America/New_York so DST is handled automatically. */

export function nyParts(date: Date): { weekday: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // hour can format as "24" at midnight in some environments; normalize to 0.
  const hour = Number(get("hour")) % 24;
  return { weekday: get("weekday"), hour, minute: Number(get("minute")) };
}

/** True during US regular trading hours (Mon–Fri, 09:30–16:00 ET). DST-aware via Intl. */
export function isUsMarketOpen(date: Date): boolean {
  const { weekday, hour, minute } = nyParts(date);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** Calendar date in America/New_York as YYYY-MM-DD (the trading "day" key). */
export function etDateString(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
