import { randomUUID } from "node:crypto";
import { memoryFromEnv } from "../memory.ts";
import { HttpJevClient } from "../jev.ts";
import { timeoutFetch } from "../fetch-timeout.ts";
import { adjustedBars, shadowFinnhub, ShadowBudgetError } from "./providers.ts";
import { runShadow, shadowDue, shadowEnabled } from "./run.ts";
import type { ShadowKind } from "./store.ts";

export async function runShadowSchedule(kind: ShadowKind, env = process.env): Promise<void> {
  // Gate before constructing a client, reading holdings, or making any request.
  if (!shadowEnabled(env, kind) || !shadowDue(kind, Date.now())) return;
  if (env.TRADING212_ENV !== "demo" && env.TRADING212_ENV !== "live") throw new Error("Shadow requires explicit TRADING212_ENV");
  if (kind === "score" ? !env.TIINGO_API_KEY : !env.FINNHUB_API_KEY ||
      (kind === "news" && env.SHADOW_FORECASTS_ENABLED === "true" && !env.TYPESAFE_API_KEY)) {
    throw new Error("Shadow provider configuration unavailable");
  }
  const store = memoryFromEnv(undefined, { timeoutMs: 4_000 }).shadowStore();
  const result = await runShadow(kind, env.TRADING212_ENV, randomUUID(), (lease) => {
    const jevFetch: typeof fetch = async (input, init) => {
      if (!(await store.permit(lease, "jev"))) throw new ShadowBudgetError("shadow-jev-budget");
      return timeoutFetch(8_000)(input, init);
    };
    return { store, now: Date.now, forecastsEnabled: env.SHADOW_FORECASTS_ENABLED === "true",
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      news: shadowFinnhub(store, lease, env.FINNHUB_API_KEY ?? ""),
      jev: new HttpJevClient(env.TYPESAFE_API_KEY ?? "", jevFetch),
      bars: (symbol, from, to) => adjustedBars(store, lease, env.TIINGO_API_KEY ?? "", symbol, from, to) };
  }, store);
  console.log(`[shadow-${kind}] ${result}`);
}
