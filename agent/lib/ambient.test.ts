import { test } from "node:test";
import assert from "node:assert/strict";
import type { SlackInboundMessageContext, SlackMessage } from "eve/channels/slack";
import { routeSlackMessage, skipAmbientMessage, CHANNEL_GOAL } from "./ambient.ts";

function message(over: Partial<SlackMessage> = {}): SlackMessage {
  return {
    text: "Why did Poof skip a trade?", markdown: "Why did Poof skip a trade?",
    ts: "2", threadTs: "2", channelId: "CPOOF", teamId: "T1", raw: {},
    author: { userId: "U1", isBot: false, isMe: false, userName: undefined, fullName: undefined },
    attachments: [], ...over,
  } as SlackMessage;
}
function context(over: Partial<SlackInboundMessageContext> = {}): SlackInboundMessageContext {
  return {
    slack: { codeChannel: false }, isBotMentioned: () => false,
    isSubscribed: async () => false, ...over,
  } as SlackInboundMessageContext;
}

test("ambient routing: bots are dropped and mentions/DMs bypass the model", async () => {
  const screen = async () => { throw new Error("must not screen"); };
  assert.equal(await routeSlackMessage(context(), message({ author: undefined }), screen), null);
  assert.equal(await routeSlackMessage(context(), message({ author: { ...message().author!, isBot: true } }), screen), null);
  assert.ok((await routeSlackMessage(context({ isBotMentioned: () => true }), message(), screen))?.auth);
  assert.ok((await routeSlackMessage(context(), message({ raw: { channel_type: "im" } } as Partial<SlackMessage>), screen))?.auth);
});

test("ambient routing: only watched channels and followed replies are screened", async () => {
  const previous = process.env.SLACK_CHANNEL_ID;
  const enabled = process.env.AMBIENT_LISTENING_ENABLED;
  process.env.AMBIENT_LISTENING_ENABLED = "true";
  process.env.SLACK_CHANNEL_ID = "CPOOF";
  try {
    let calls = 0;
    const screen = async () => { calls++; return false; };
    assert.equal(await routeSlackMessage(context(), message({ channelId: "COTHER" }), screen), null);
    const route = await routeSlackMessage(context(), message(), screen);
    assert.equal(route?.status, "deferred");
    assert.deepEqual(route?.context, [CHANNEL_GOAL]);
    const followed = await routeSlackMessage(context({ isSubscribed: async () => true }), message({ channelId: "COTHER", threadTs: "1" }), screen);
    assert.equal(followed?.status, "deferred");
    assert.equal(calls, 2);
    assert.equal(await routeSlackMessage(context(), message(), async () => true), null);
    assert.equal((await routeSlackMessage(context({ edit: {} } as Partial<SlackInboundMessageContext>), message(), async () => { throw new Error("edit must bypass"); }))?.status, "deferred");
  } finally {
    if (enabled === undefined) delete process.env.AMBIENT_LISTENING_ENABLED;
    else process.env.AMBIENT_LISTENING_ENABLED = enabled;
    if (previous === undefined) delete process.env.SLACK_CHANNEL_ID;
    else process.env.SLACK_CHANNEL_ID = previous;
  }
});

test("a context loading error lets the agent decide instead of dropping the message", async () => {
  const ctx = context();
  Object.defineProperty(ctx, "thread", { get() { throw new Error("Slack unavailable"); } });
  assert.equal(await skipAmbientMessage(ctx, message(), CHANNEL_GOAL), false);
});

test("ambient defaults off before subscriptions, context or model access", async () => {
  const screen = async () => { throw new Error("disabled mode must not screen"); };
  assert.equal(await routeSlackMessage(context({ isSubscribed: async () => { throw new Error("disabled"); } }), message({ threadTs: "1" }), screen, false), null);
  assert.ok((await routeSlackMessage(context({ isBotMentioned: () => true }), message(), screen, false))?.auth);
});
