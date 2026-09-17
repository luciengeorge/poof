import { defineTool } from "eve/tools";
import { z } from "zod";
import { finnhubFromEnv } from "../lib/data.ts";
import { jevFromEnv } from "../lib/jev.ts";
import { screenNews } from "../lib/jev-shadow.ts";

export default defineTool({
  description:
    "Get recent financial news. With `symbol`, returns company-specific news over [fromISO, toISO]; without it, returns general market news. Dates are YYYY-MM-DD. When Jev is configured each item also carries `jevScreen`: `freshCatalyst` and `pricedIn` (probabilities 0..1) and a `strategyTag` with its confidence. Use it to RANK what to read first, not as a filter: it has no calibration record yet, so an item it scores low still deserves a look if the headline is specific.",
  inputSchema: z.object({
    symbol: z.string().min(1).optional(),
    fromISO: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    toISO: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  }),
  async execute({ symbol, fromISO, toISO }) {
    const finnhub = finnhubFromEnv();
    const news =
      symbol && fromISO && toISO
        ? await finnhub.getCompanyNews(symbol, fromISO, toISO)
        : await finnhub.getMarketNews();
    // Annotation only. Without a key, or on any failure, the items come back exactly as before.
    const jev = jevFromEnv();
    return { news: jev ? await screenNews(jev, news) : news };
  },
});
