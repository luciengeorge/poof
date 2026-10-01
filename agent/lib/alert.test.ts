import { test } from "node:test";
import assert from "node:assert/strict";
import { alert, describeFailure } from "./alert.ts";

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

/** Run `body` with these env vars set (or unset, for `undefined`), then restore the previous values. */
async function withEnv(
  values: Record<string, string | undefined>,
  body: () => void | Promise<void>,
): Promise<void> {
  const prev = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) process.env[name] = value;
    else delete process.env[name];
  }
  try {
    await body();
  } finally {
    for (const [name, value] of prev) {
      if (value !== undefined) process.env[name] = value;
      else delete process.env[name];
    }
  }
}

const FAKE_TOKEN = "FAKE_TOKEN_abc123XYZ";

// Captured verbatim from the DEV deployment on 2026-10-01 with a fake token. Convex prints the
// whole argument object, token first, when a field is missing. This is the path that leaked.
const CONVEX_MISSING_FIELD = `[Request ID: 9c9740cd81b808e1] Server Error
ArgumentValidationError: Object is missing the required field \`schedule\`. Consider wrapping the field validator in \`v.optional(...)\` if this is expected.

Object: {token: "${FAKE_TOKEN}"}
Validator: v.object({schedule: v.string(), token: v.string()})`;

// eve's real turn.failed payload: { code, details?, message, sequence, turnId }.
const turnFailed = {
  type: "turn.failed",
  data: {
    code: "TURN_FAILED",
    message: CONVEX_MISSING_FIELD,
    sequence: 7,
    turnId: "turn_test",
    details: { token: FAKE_TOKEN, note: "DETAILS_SENTINEL" },
  },
};

function assertSafeAndDiagnostic(text: string): void {
  assert.ok(text.startsWith("TURN_FAILED: [Request ID"), text);
  assert.ok(text.includes("ArgumentValidationError: Object is missing the required field `schedule`"));
  assert.ok(text.includes('Object: {token: "[REDACTED]"}'));
  assert.equal(text.includes(FAKE_TOKEN), false, "the shared secret must never reach Slack");
  assert.equal(text.includes("DETAILS_SENTINEL"), false, "details is free-form and never included");
}

test("REGRESSION: a Convex validator failure is described from code and message, token redacted", async () => {
  // The old describe() looked for data.error.message and data.reason, which eve never sends, so
  // it stringified the whole payload on every failure and shipped the token to Slack.
  await withEnv({ CONVEX_APP_SECRET: FAKE_TOKEN }, () => {
    assertSafeAndDiagnostic(describeFailure(turnFailed));
  });
});

test("the token is redacted even when this process does not hold the secret env var", async () => {
  // The generic `token: "..."` pattern must catch it on its own, not the env lookup.
  await withEnv({ CONVEX_APP_SECRET: undefined, APP_SHARED_SECRET: undefined }, () => {
    assertSafeAndDiagnostic(describeFailure(turnFailed));
  });
});

test("a payload with no code or message gets fixed text, never the stringified payload", () => {
  const text = describeFailure({ data: { reason: "boom", details: { token: FAKE_TOKEN } } });
  assert.equal(text, "(failure event carried no code or message)");
  assert.equal(describeFailure({}), "(failure event carried no code or message)");
});

test("alert redacts at the boundary: a secret in the text reaches neither the log nor Slack", async () => {
  const secret = "FAKE-convex-app-secret-0123456789";
  const posted: string[] = [];
  const logged: string[] = [];
  const recordBody: typeof globalThis.fetch = async (_input, init) => {
    posted.push(String(init?.body));
    return new Response("ok");
  };
  await withEnv({ CONVEX_APP_SECRET: secret }, () =>
    withStubbedWebhook(recordBody, async () => {
      // Replaces the helper's silent stub; the helper's finally still restores the real one.
      console.error = (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      };
      await alert(`memory call failed using ${secret}`);
    }),
  );
  assert.equal(posted.length, 1);
  assert.equal(logged.length, 1);
  for (const text of [...posted, ...logged]) {
    assert.equal(text.includes(secret), false, "the secret must not be posted or logged");
  }
  assert.deepEqual(JSON.parse(posted[0]), { text: "memory call failed using [REDACTED]" });
  assert.equal(logged[0], "[alert] memory call failed using [REDACTED]");
});
