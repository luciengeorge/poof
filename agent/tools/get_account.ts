import { defineTool } from "eve/tools";
import { z } from "zod";
import { t212FromEnv } from "../lib/t212.ts";
import { buildRiskSnapshot } from "../lib/execution.ts";
import { loadRiskState } from "../lib/state.ts";
import { fxForCycle } from "../lib/fx.ts";

export default defineTool({
  description:
    "Read the live Trading 212 account. Returns accountValueGbp (the authoritative total account value in GBP), cashGbp (free cash), deployedGbp (value of holdings), and per-position GBP values. All figures are GBP. Call this before proposing trades so sizing is grounded in real buying power.",
  inputSchema: z.object({}),
  async execute() {
    const client = t212FromEnv();
    const [cash, positions] = await Promise.all([
      client.getCash(),
      client.getPortfolio(),
    ]);
    const fx = await fxForCycle();
    const snap = buildRiskSnapshot({
      cash,
      positions,
      fxRate: fx.rate,
      ...loadRiskState(),
    });
    return {
      accountValueGbp: snap.equity,
      cashGbp: snap.cash,
      deployedGbp: snap.equity - snap.cash,
      positions: snap.positions,
      fx: { rate: fx.rate, source: fx.source, fallbackUsed: fx.source === "fallback" },
    };
  },
});
