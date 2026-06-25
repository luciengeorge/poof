import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { buildRiskSnapshot } from "../lib/execution.ts";
import { loadRiskState, fxRateFromEnv } from "../lib/state.ts";

export default defineTool({
  description:
    "Read the live Trading 212 account: available cash, open positions, and computed equity (account currency, GBP). Call this before proposing trades so sizing is grounded in real buying power.",
  inputSchema: z.object({}),
  async execute() {
    const client = t212FromEnv();
    const [cash, positions] = await Promise.all([
      client.getCash(),
      client.getPortfolio(),
    ]);
    const fxRate = fxRateFromEnv();
    const snap = buildRiskSnapshot({
      cash,
      positions,
      fxRate,
      ...loadRiskState(),
    });
    return {
      freeCash: snap.cash,
      equity: snap.equity,
      positions: snap.positions,
      fxRate,
    };
  },
});
