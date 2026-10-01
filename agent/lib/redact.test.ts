import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact.ts";

// Every secret this process can hold. Pinned here rather than imported, so dropping a name from
// the redactor's list fails a test instead of silently un-redacting that secret.
const SECRET_ENV_NAMES = [
  "CONVEX_APP_SECRET",
  "APP_SHARED_SECRET",
  "CONVEX_DEPLOY_KEY",
  "TRADING212_API_KEY",
  "TRADING212_API_SECRET",
  "TRADING212_SECRET_KEY",
  "FINNHUB_API_KEY",
  "EXA_API_KEY",
  "TIINGO_API_KEY",
  "TYPESAFE_API_KEY",
  "SLACK_ALERT_WEBHOOK_URL",
  "ROUTE_AUTH_BASIC_PASSWORD",
];

const fakeValue = (name: string): string => `FAKE-${name}-not-a-real-value`;

/** Run `body` with exactly `values` set among the secret env vars (the rest unset), then restore. */
function withSecretEnv(values: Record<string, string>, body: () => void): void {
  const prev = new Map(SECRET_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of SECRET_ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
  try {
    body();
  } finally {
    for (const [name, value] of prev) {
      if (value !== undefined) process.env[name] = value;
      else delete process.env[name];
    }
  }
}

const allFake = (): Record<string, string> =>
  Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, fakeValue(name)]));

// Captured verbatim from the DEV deployment on 2026-10-01 with a fake token: memory:latestCronRun
// called with a missing field. This is the shape that has already leaked the secret once.
const CONVEX_MISSING_FIELD = `[Request ID: 9c9740cd81b808e1] Server Error
ArgumentValidationError: Object is missing the required field \`schedule\`. Consider wrapping the field validator in \`v.optional(...)\` if this is expected.

Object: {token: "FAKE_TOKEN_abc123XYZ"}
Validator: v.object({schedule: v.string(), token: v.string()})`;

const CONVEX_EXTRA_FIELD = `ArgumentValidationError: Object contains extra field \`extra\` that is not in the validator.

Object: {extra: 1.0, schedule: "cycle", token: "FAKE_TOKEN_abc123XYZ"}
Validator: v.object({schedule: v.string(), token: v.string()})`;

test("the value of CONVEX_APP_SECRET is replaced wherever it appears", () => {
  const secret = "FAKE-convex-app-secret-0123456789";
  withSecretEnv({ CONVEX_APP_SECRET: secret }, () => {
    assert.equal(
      redact(`query failed with secret ${secret} (retrying ${secret})`),
      "query failed with secret [REDACTED] (retrying [REDACTED])",
    );
  });
});

test("every secret env var's value is replaced, each read at call time", () => {
  // Set after import on purpose: a value cached at import would miss all of these.
  const message = SECRET_ENV_NAMES.map((name) => `${name} leaked: ${fakeValue(name)}`).join("\n");
  const expected = SECRET_ENV_NAMES.map((name) => `${name} leaked: [REDACTED]`).join("\n");
  withSecretEnv(allFake(), () => {
    assert.equal(redact(message), expected);
  });
});

test("Convex's validator error: the token is caught with no env var set, the diagnosis survives", () => {
  // The watchdog, and any process missing the env var, depends on the pattern alone.
  withSecretEnv({}, () => {
    assert.equal(
      redact(CONVEX_MISSING_FIELD),
      CONVEX_MISSING_FIELD.replace('token: "FAKE_TOKEN_abc123XYZ"', 'token: "[REDACTED]"'),
    );
    assert.equal(
      redact(CONVEX_EXTRA_FIELD),
      CONVEX_EXTRA_FIELD.replace('token: "FAKE_TOKEN_abc123XYZ"', 'token: "[REDACTED]"'),
    );
  });
});

test("a JSON token field is caught with no env var set", () => {
  withSecretEnv({}, () => {
    assert.equal(
      redact('{"token":"abc123","schedule":"cycle"}'),
      '{"token":"[REDACTED]","schedule":"cycle"}',
    );
  });
});

test("a query-string token is caught with no env var set", () => {
  withSecretEnv({}, () => {
    assert.equal(
      redact("GET /api/query?token=abc123&schedule=cycle failed"),
      "GET /api/query?token=[REDACTED]&schedule=cycle failed",
    );
  });
});

test("an empty env var never becomes a pattern that matches between every character", () => {
  // A naive replaceAll("", marker) inserts the marker between every character and destroys the
  // whole message, which is worse than the leak it was meant to stop.
  const empty = Object.fromEntries(SECRET_ENV_NAMES.map((name) => [name, ""]));
  withSecretEnv(empty, () => {
    assert.equal(redact("T212 returned 429 on /equity/portfolio"), "T212 returned 429 on /equity/portfolio");
  });
});

test("a secret shorter than 8 characters is skipped, so common words survive", () => {
  withSecretEnv({ CONVEX_APP_SECRET: "cycle" }, () => {
    assert.equal(redact("cron cycle failed"), "cron cycle failed");
  });
});

test("a message with no secret passes through unchanged", () => {
  // The Validator line names the token field with no value, and must stay readable.
  const message =
    "memory:latestCronRun failed: Validator: v.object({schedule: v.string(), token: v.string()})";
  withSecretEnv(allFake(), () => {
    assert.equal(redact(message), message);
  });
});
