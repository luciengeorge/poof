import { defineTool } from "eve/tools";
import { z } from "zod";
import { finnhubFromEnv, type Quote } from "../lib/data.ts";

export default defineTool({
  description:
    "Get the latest price quote for one or more US stock/ETF tickers (e.g. AAPL, SPY). Returns current price, previous close, and % change per symbol. A symbol lookup can fail (e.g. rate limit); failed symbols are omitted from `quotes` and listed in `failures` instead of failing the whole batch.",
  inputSchema: z.object({
    symbols: z.array(z.string().min(1)).min(1).max(40),
  }),
  async execute({ symbols }) {
    const finnhub = finnhubFromEnv();
    const results = await Promise.allSettled(
      symbols.map((s) => finnhub.getQuote(s)),
    );
    const quotes: Quote[] = [];
    const failures: { symbol: string; error: string }[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled") quotes.push(r.value);
      else failures.push({ symbol: symbols[i], error: String(r.reason) });
    }
    return { quotes, failures };
  },
});
