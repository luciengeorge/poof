import { defineTool } from "eve/tools";
import { z } from "zod";
import { finnhubFromEnv } from "../lib/data.ts";
import { nextEarnings, heldThroughEarnings } from "../lib/earnings.ts";
import { etDateString } from "../lib/clock.ts";

const DAY = 86_400_000;

export default defineTool({
  description:
    "For each US ticker (plain symbol like get_prices, e.g. NKE, AAPL), return the NEXT scheduled earnings date, how many days away it is, and the session (bmo/amc). Use this on EVERY candidate in the Signal/Size step: holding a position THROUGH an earnings print is uncontrolled binary/gap risk a stop can't protect. `heldThroughInDefaultWindow` is true when earnings fall within ~10 days (the assumed hold window) — if so, either set `maxHoldDays` to exit before the date, size it as a deliberate earnings play (small enough that a ~10-15% gap is acceptable), or drop it. Always pass the next earnings date into the thesis you send to red_team. Dates may be estimates; treat an unconfirmed date as if it could come sooner.",
  inputSchema: z.object({
    symbols: z.array(z.string().min(1)).min(1).max(20),
  }),
  async execute({ symbols }) {
    const finnhub = finnhubFromEnv();
    const today = etDateString(new Date());
    const to = etDateString(new Date(Date.now() + 90 * DAY)); // Finnhub max window
    const earnings = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const events = await finnhub.getEarningsCalendar(symbol, today, to);
          const next = nextEarnings(events, today);
          return {
            symbol,
            next,
            heldThroughInDefaultWindow: heldThroughEarnings(next),
          };
        } catch (err) {
          console.warn(`[earnings] ${symbol} lookup failed (non-fatal):`, err);
          return {
            symbol,
            next: null,
            heldThroughInDefaultWindow: false,
            error: "lookup failed",
          };
        }
      }),
    );
    return { today, earnings };
  },
});
