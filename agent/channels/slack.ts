import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  slackChannel,
} from "eve/channels/slack";
import { routeSlackMessage } from "../lib/ambient.ts";
import { memoryFromEnv, type Env } from "../lib/memory.ts";

// Best-effort capture of an inbound user message to durable memory. Fire-and-forget;
// a memory failure must never affect message handling. (Agent replies are captured
// separately by the message.completed hook in agent/hooks/record-messages.ts.)
function recordUserMessage(m: {
  markdown: string;
  threadTs: string;
  author?: { userId: string };
}): void {
  if (!m.markdown) return;
  void (async () => {
    try {
      const env = (process.env.TRADING212_ENV ?? "demo") as Env;
      await memoryFromEnv().recordMessage({
        env,
        role: "user",
        text: m.markdown,
        slackUser: m.author?.userId,
        threadTs: m.threadTs,
      });
    } catch (err) {
      console.warn("[memory] record user message failed (non-fatal):", err);
    }
  })();
}

export default slackChannel({
  credentials: connectSlackCredentials("slack/poof"),
  turnPolicy: "queue",
  threadContext: { since: "last-agent-reply" },
  async onMessage(ctx, message) {
    const route = await routeSlackMessage(ctx, message);
    if (route && route.auth.attributes.poofAmbient !== "true" && !ctx.edit) recordUserMessage(message);
    return route;
  },
});
