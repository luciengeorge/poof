import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  loadThreadContextMessages,
  slackChannel,
} from "eve/channels/slack";

export default slackChannel({
  credentials: connectSlackCredentials("slack/poof"),
  // On each @mention, also pull in any thread replies posted since the agent last
  // answered, so follow-up mentions carry the full conversation (not just the mention).
  // (Follow-ups still need to @mention the bot — Slack only routes mentions/DMs to apps.)
  async onAppMention(ctx, message) {
    const auth = defaultSlackAuth(message, ctx);
    if (!auth) return null;
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
});
