import { test } from "node:test";
import assert from "node:assert/strict";
import { alert } from "./alert.ts";

const WEBHOOK = "https://hooks.example.invalid/services/T000/B000/xxx";

/** Run `body` with the webhook env var and global fetch stubbed, then restore both. */
async function withStubbedWebhook(
  fetchImpl: typeof globalThis.fetch,
  body: () => Promise<void>,
): Promise<void> {
  const prevUrl = process.env.SLACK_ALERT_WEBHOOK_URL;
  const prevFetch = globalThis.fetch;
  const prevError = console.error;
  process.env.SLACK_ALERT_WEBHOOK_URL = WEBHOOK;
  globalThis.fetch = fetchImpl;
  console.error = () => {}; // the alert path logs by design; keep the test output readable
  try {
    await body();
  } finally {
    console.error = prevError;
    globalThis.fetch = prevFetch;
    if (prevUrl !== undefined) process.env.SLACK_ALERT_WEBHOOK_URL = prevUrl;
    else delete process.env.SLACK_ALERT_WEBHOOK_URL;
  }
}

test("a HANGING webhook does not hang the caller: alert resolves at the deadline", async () => {
  // The hang case, not the error case. Hooks run inline in eve's event pipeline, so without a
  // deadline this would stall a live trading cycle. Without the fix, this test never finishes.
  const neverSettles: typeof globalThis.fetch = () => new Promise<Response>(() => {});
  await withStubbedWebhook(neverSettles, async () => {
    const started = Date.now();
    await alert("hanging webhook", 20);
    assert.ok(
      Date.now() - started < 5_000,
      "alert must abandon a hanging webhook, not await it indefinitely",
    );
  });
});

test("a webhook that errors is still swallowed, never thrown at the hook", async () => {
  const boom: typeof globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  await withStubbedWebhook(boom, async () => {
    await alert("erroring webhook", 20); // must not reject
  });
});

test("a healthy webhook is posted once, as JSON, with the alert text", async () => {
  const posted: { url: string; body: unknown }[] = [];
  const ok: typeof globalThis.fetch = async (input, init) => {
    posted.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response("ok");
  };
  await withStubbedWebhook(ok, async () => {
    await alert("all good");
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, WEBHOOK);
  assert.deepEqual(posted[0].body, { text: "all good" });
});

test("with no webhook configured, alert logs and makes no request at all", async () => {
  const prevUrl = process.env.SLACK_ALERT_WEBHOOK_URL;
  const prevFetch = globalThis.fetch;
  const prevError = console.error;
  const logged: unknown[][] = [];
  delete process.env.SLACK_ALERT_WEBHOOK_URL;
  globalThis.fetch = () => {
    throw new Error("alert must not fetch when SLACK_ALERT_WEBHOOK_URL is unset");
  };
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    await alert("no webhook here");
  } finally {
    console.error = prevError;
    globalThis.fetch = prevFetch;
    if (prevUrl !== undefined) process.env.SLACK_ALERT_WEBHOOK_URL = prevUrl;
  }
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], ["[alert]", "no webhook here"]);
});

test("the alert text is never the secret: only the message is logged", async () => {
  const prevUrl = process.env.SLACK_ALERT_WEBHOOK_URL;
  const prevFetch = globalThis.fetch;
  const prevError = console.error;
  const logged: string[] = [];
  process.env.SLACK_ALERT_WEBHOOK_URL = WEBHOOK;
  globalThis.fetch = async () => new Response("ok");
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    await alert("cycle invariant violated");
  } finally {
    console.error = prevError;
    globalThis.fetch = prevFetch;
    if (prevUrl !== undefined) process.env.SLACK_ALERT_WEBHOOK_URL = prevUrl;
    else delete process.env.SLACK_ALERT_WEBHOOK_URL;
  }
  for (const line of logged) {
    assert.equal(line.includes(WEBHOOK), false, "the webhook URL is a secret and must not be logged");
  }
});
