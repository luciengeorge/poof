import { defineTool } from "eve/tools";
import { z } from "zod";
import { exaFromEnv } from "../lib/exa.ts";

export default defineTool({
  description:
    "Deep web search (via Exa) for fresh, relevant context on a company, ticker, sector, or market event — beyond the headline feed. Returns title, url, date, and a short text/summary per result. Use to pressure-test a thesis with current sources. Remember: public news is priced in fast, so weight genuinely recent, material items.",
  inputSchema: z.object({
    query: z.string().min(1),
    numResults: z.number().int().min(1).max(15).optional(),
    category: z
      .string()
      .optional()
      .describe('e.g. "news", "company" (defaults to "news")'),
    startPublishedDate: z
      .string()
      .optional()
      .describe("ISO date; bias to results published on/after it"),
  }),
  async execute({ query, numResults, category, startPublishedDate }) {
    const exa = exaFromEnv();
    const results = await exa.search(query, {
      numResults: numResults ?? 5,
      category: category ?? "news",
      startPublishedDate,
      text: { maxCharacters: 800 },
      summary: true,
    });
    return { results };
  },
});
