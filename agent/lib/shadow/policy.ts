import { researchDay, researchSession } from "../../../convex/shadowCalendar.ts";

export interface TimedQuote { symbol: string; price: number; at: number }
export function validQuote(q: TimedQuote, now: number, earliest = 0): boolean {
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(q.symbol) && Number.isFinite(q.price) && q.price > 0 &&
    Number.isFinite(q.at) && q.at >= earliest && q.at <= now && now - q.at <= 60_000;
}
export function startPair(stock: TimedQuote, proxy: TimedQuote, committedAt: number, now: number): boolean {
  return proxy.symbol === "SPY" && stock.symbol !== "SPY" && now >= committedAt && now - committedAt <= 60_000 &&
    validQuote(stock, now, committedAt) && validQuote(proxy, now, committedAt) && Math.abs(stock.at - proxy.at) <= 5_000;
}
export function newsEligibility(publishedAt: number, firstSeenAt: number): string | null {
  if (!Number.isFinite(publishedAt) || publishedAt <= 0 || publishedAt > firstSeenAt) return "invalid-publication-time";
  if (firstSeenAt - publishedAt > 15 * 60_000) return "stale-on-arrival";
  const session = researchSession(researchDay(firstSeenAt));
  if (!session || session === "unsupported" || firstSeenAt < session.open || firstSeenAt >= session.close) return "outside-session";
  return null;
}
/** Conservative exact-story clustering. Broader syndication is additionally clustered by date in reports. */
export function storyKey(headline: string, publishedAt: number): string {
  return `${new Date(publishedAt).toISOString().slice(0, 10)}:${headline.normalize("NFKC")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 300)}`;
}
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(name)) url.searchParams.delete(name);
    url.searchParams.sort();
    return url.toString().slice(0, 1_000);
  } catch { return ""; }
}
export interface PriceBasis { rawClose: number; adjustedClose: number; day: string }
export function relativeOutcome(
  p: number, baseline: number | null, start: { stock: TimedQuote; proxy: TimedQuote; sessionDay: string },
  bars: { stockStart: PriceBasis; stockEnd: PriceBasis; proxyStart: PriceBasis; proxyEnd: PriceBasis },
) {
  if (!Number.isFinite(p) || p < 0 || p > 1 || (baseline !== null && (!Number.isFinite(baseline) || baseline < 0 || baseline > 1))) return null;
  const xs = [bars.stockStart, bars.stockEnd, bars.proxyStart, bars.proxyEnd];
  if (xs.some((b) => !Number.isFinite(b.rawClose) || !Number.isFinite(b.adjustedClose) || b.rawClose <= 0 || b.adjustedClose <= 0)) return null;
  const startDay = researchDay(start.stock.at);
  if (bars.stockStart.day !== startDay || bars.proxyStart.day !== startDay ||
      bars.stockEnd.day !== start.sessionDay || bars.proxyEnd.day !== start.sessionDay ||
      !validQuote(start.stock, start.stock.at) || !validQuote(start.proxy, start.proxy.at)) return null;
  // Convert the intraday RAW start to the SAME adjusted basis as both EOD bars from this response.
  const stockReturn = bars.stockEnd.adjustedClose / (start.stock.price * bars.stockStart.adjustedClose / bars.stockStart.rawClose) - 1;
  const proxyReturn = bars.proxyEnd.adjustedClose / (start.proxy.price * bars.proxyStart.adjustedClose / bars.proxyStart.rawClose) - 1;
  const relativeReturn = stockReturn - proxyReturn;
  const up = relativeReturn > 0;
  const y = up ? 1 : 0;
  return { up, relativeReturn, brier: (p - y) ** 2, constantBrier: 0.25,
    baseRateBrier: baseline === null ? null : (baseline - y) ** 2 };
}
