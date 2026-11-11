import { timingSafeEqual, createHash } from "node:crypto";
import { FinnhubProvider } from "./data.ts";
import { HttpJevClient } from "./jev.ts";
import { timeoutFetch } from "./fetch-timeout.ts";
import { connectSlackCredentials } from "@vercel/connect/eve";
import { resolveSlackBotToken } from "eve/channels/slack";

export function authorizedReadiness(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
}
export async function activationReadiness(env = process.env) {
  const fetcher = timeoutFetch(8_000);
  const checks: Record<string, boolean | string> = {};
  const check = async (name: string, fn: () => Promise<boolean>) => {
    try { checks[name] = await fn(); } catch { checks[name] = false; }
  };
  // Operator-only, bounded probe. No broker, model turn, live memory or order functions.
  if ([12, 15, 18].includes(new Date().getUTCHours())) return { deferred: "live-window" };
  const news = new FinnhubProvider({ apiKey: env.FINNHUB_API_KEY ?? "", maxRetries: 0, timeoutMs: 8_000 });
  await check("timestampedQuote", async () => {
    const q = await news.getQuote("AAPL");
    return q.price > 0 && !!q.timestamp && Date.now() - q.timestamp < 86_400_000;
  });
  const now = Date.now(), to = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const from = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
  await check("companyNews", async () => Array.isArray(await news.getCompanyNews("AAPL", from, to)));
  for (const ticker of ["AAPL", "SPY"]) await check(`adjustedBars${ticker}`, async () => {
    const url = new URL(`https://api.tiingo.com/tiingo/daily/${ticker}/prices`);
    url.search = new URLSearchParams({ startDate: from, endDate: to, token: env.TIINGO_API_KEY ?? "" }).toString();
    const res = await fetcher(url);
    if (!res.ok) return false;
    const rows: unknown = await res.json();
    return Array.isArray(rows) && rows.some((r) => r && Number.isFinite(r.close) && r.close > 0 && Number.isFinite(r.adjClose) && r.adjClose > 0);
  });
  await check("jev", async () => {
    const r = await new HttpJevClient(env.TYPESAFE_API_KEY ?? "", fetcher).ask("This is a connectivity test.", {
      connectivityTest: { type: "noul", instructions: "Is this text a connectivity test?" },
    });
    return Number.isFinite(r.answers.connectivityTest.noul);
  });
  await check("slackHistory", async () => {
    const token = await resolveSlackBotToken(connectSlackCredentials("slack/poof").botToken);
    const url = new URL("https://slack.com/api/conversations.history");
    url.search = new URLSearchParams({ channel: env.SLACK_CHANNEL_ID ?? "", limit: "1" }).toString();
    const res = await fetcher(url, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json() as { ok?: boolean };
    checks.slackScopes = res.headers.get("x-oauth-scopes") ?? "unreported";
    return body.ok === true;
  });
  return { checks, commit: env.VERCEL_GIT_COMMIT_SHA ?? "local", allPassed: Object.entries(checks).every(([k, v]) => k === "slackScopes" || v === true) };
}
