import { defineTool } from "eve/tools";
import { z } from "zod";

import { FUNNEL_CHUNKS } from "../lib/funnel.ts";
import { memoryFromEnv } from "../lib/memory.ts";

const DEFAULT_LIMIT = 15;

export default defineTool({
  description:
    "The day's shortlist from the wide funnel: every S&P 500 name's news, screened by Jev before the cycle and ranked in code by freshCatalyst x (1 - pricedIn) x strategy-bucket weight x recency. Returns the top items with their signals, plus how much of the universe was covered today. Use it as the FIRST place to look for candidates, then read the underlying stories. It is a ranking, not a filter: an item low on this list can still be worth a look if you have a reason.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe(`How many items, default ${DEFAULT_LIMIT}`),
  }),
  async execute({ limit }) {
    const memory = memoryFromEnv();
    const day = new Date().toISOString().slice(0, 10);
    const [items, chunks] = await Promise.all([
      memory.topFunnelItems(day, limit ?? DEFAULT_LIMIT),
      memory.funnelChunksForDay(day),
    ]);
    const done = chunks.filter((c) => c.status === "done");
    const coverage = {
      chunksDone: done.length,
      chunksTotal: FUNNEL_CHUNKS,
      tickersScanned: done.reduce((n, c) => n + (c.tickers ?? 0), 0),
      itemsStored: done.reduce((n, c) => n + (c.items ?? 0), 0),
      // Honest about partial coverage. A shortlist from one chunk is a quarter of the universe,
      // and the agent should know that before treating it as "the market's news today".
      note:
        done.length === 0
          ? "The funnel has not run for today. Fall back to get_news."
          : done.length < FUNNEL_CHUNKS
            ? `Only ${done.length} of ${FUNNEL_CHUNKS} slices of the universe have been screened so far today.`
            : "Full universe screened.",
    };
    return {
      day,
      coverage,
      items: items.map((i) => ({
        ticker: i.ticker,
        score: i.score,
        headline: i.headline,
        summary: i.summary,
        source: i.source,
        url: i.url,
        publishedAt: new Date(i.publishedAt).toISOString(),
        freshCatalyst: i.freshCatalyst,
        pricedIn: i.pricedIn,
        strategyTag: i.strategyTag,
        strategyTagConfidence: i.strategyTagConfidence,
      })),
    };
  },
});
