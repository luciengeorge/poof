import { defineChannel, GET } from "eve/channels";
import { activationReadiness, authorizedReadiness } from "../lib/activation-readiness.ts";

export default defineChannel({ routes: [
  GET("/ops/activation-readiness", async (request) => {
    if (!authorizedReadiness(request, process.env.CONVEX_APP_SECRET)) return new Response(null, { status: 401 });
    const flags = Object.fromEntries(["AMBIENT_LISTENING_ENABLED", "SHADOW_RESEARCH_ENABLED", "SHADOW_FEED_QUOTAS_VERIFIED",
      "SHADOW_POSITIONS_ENABLED", "SHADOW_NEWS_ENABLED", "SHADOW_FORECASTS_ENABLED", "SHADOW_SCORE_ENABLED"].map((k) => [k, process.env[k] === "true"]));
    return Response.json({ flags, ...(new URL(request.url).searchParams.get("probe") === "1" ? await activationReadiness() : {}) },
      { headers: { "cache-control": "no-store" } });
  }),
] });
