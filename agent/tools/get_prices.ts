import { defineTool } from "eve/tools";
import { z } from "zod";
import { finnhubFromEnv } from "../lib/data.ts";

export default defineTool({
  description:
    "Get the latest price quote for one or more US stock/ETF tickers (e.g. AAPL, SPY). Returns current price, previous close, and % change per symbol.",
  inputSchema: z.object({
    symbols: z.array(z.string().min(1)).min(1).max(40),
  }),
  async execute({ symbols }) {
    const finnhub = finnhubFromEnv();
    const quotes = await Promise.all(symbols.map((s) => finnhub.getQuote(s)));
    return { quotes };
  },
});
