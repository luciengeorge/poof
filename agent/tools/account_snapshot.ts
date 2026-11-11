import { defineTool } from "eve/tools";
import { z } from "zod";
import { memoryFromEnv } from "../lib/memory.ts";
import { withAmbientReadOnly } from "../lib/ambient-permissions.ts";

export default withAmbientReadOnly("account_snapshot", defineTool({
  description: "Read the last stored account cycles and trades. Historical snapshots only, not a current broker audit; cite their dates. Does not change memories or query the broker.",
  inputSchema: z.object({}),
  async execute() {
    const env = process.env.TRADING212_ENV === "live" ? "live" : "demo";
    return { note: "Historical stored snapshot; do not present as current broker holdings.",
      data: await memoryFromEnv().recallRecent(env, { cycleLimit: 2, tradeLimit: 8, messageLimit: 0 }) };
  },
}));
