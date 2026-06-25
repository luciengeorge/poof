import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  loadThreadContextMessages,
  slackChannel,
} from "eve/channels/slack";
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
  // On each @mention, also pull in any thread replies posted since the agent last
  // answered, so follow-up mentions carry the full conversation (not just the mention).
  // (Follow-ups still need to @mention the bot — Slack only routes mentions/DMs to apps.)
  async onAppMention(ctx, message) {
    const auth = defaultSlackAuth(message, ctx);
    if (!auth) return null;
    recordUserMessage(message);
    const prior = await loadThreadContextMessages(ctx.thread, message, {
      since: "last-agent-reply",
    });
    if (prior.length === 0) return { auth };
    const transcript = prior
      .map((m) => `${m.isMe ? "you" : (m.user ?? "user")}: ${m.markdown}`)
      .join("\n");
    return {
      auth,
      context: [
        `Recent thread messages since your last reply:\n\n${transcript}`,
      ],
    };
  },
  // DMs deliver every message (no @mention needed). Record them too.
  async onDirectMessage(ctx, message) {
    const auth = defaultSlackAuth(message, ctx);
    if (!auth) return null;
    recordUserMessage(message);
    return { auth };
  },
});
