import { defineTool } from "eve/tools";
import { z } from "zod";
import { finnhubFromEnv } from "../lib/data.ts";

export default defineTool({
  description:
    "Get recent financial news. With `symbol`, returns company-specific news over [fromISO, toISO]; without it, returns general market news. Dates are YYYY-MM-DD.",
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
    if (symbol && fromISO && toISO) {
      return { news: await finnhub.getCompanyNews(symbol, fromISO, toISO) };
    }
    return { news: await finnhub.getMarketNews() };
  },
});
