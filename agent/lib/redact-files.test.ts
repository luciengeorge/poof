import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/redact-files.mjs is what the evals workflow runs over the files it uploads to a public
// repo. Its test lives here because `pnpm test` only globs agent/. It runs the real script in a
// child process, as the workflow does, with ONLY the fake env below, so a secret in the shell
// running the tests can neither leak into nor satisfy these assertions.
const SCRIPT = fileURLToPath(new URL("../../scripts/redact-files.mjs", import.meta.url));

const CONVEX_SECRET = "FAKE-convex-app-secret-0123456789";
const GATEWAY_KEY = "FAKE-ai-gateway-key-9876543210";
const ENV = { CONVEX_APP_SECRET: CONVEX_SECRET, AI_GATEWAY_API_KEY: GATEWAY_KEY };

function runScript(files: string[]): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...files], {
    env: ENV,
    encoding: "utf8",
  });
}

function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "redact-files-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rewrites each file in place: secret env values and a Convex token field come out redacted", () => {
  withTempDir((dir) => {
    const file = join(dir, "junit.xml");
    writeFileSync(
      file,
      `model call failed with key ${GATEWAY_KEY}\n` +
        `memory read failed: Object: {token: "FAKE_TOKEN_abc123XYZ"} (secret ${CONVEX_SECRET})\n`,
    );
    const stdout = runScript([file]);
    assert.equal(
      readFileSync(file, "utf8"),
      "model call failed with key [REDACTED]\n" +
        'memory read failed: Object: {token: "[REDACTED]"} (secret [REDACTED])\n',
    );
    for (const value of [GATEWAY_KEY, CONVEX_SECRET, "FAKE_TOKEN_abc123XYZ"]) {
      assert.ok(!stdout.includes(value), "the script's own output must not carry a secret");
    }
  });
});

test("a Convex error inside summary.json's JSON is caught by the secret's value and stays valid JSON", () => {
  // JSON escapes the quotes around the token (`token: \"...\"`), which the token-field pattern
  // does not match. The exact-value layer still does, because the job holds the secret.
  withTempDir((dir) => {
    const file = join(dir, "summary.json");
    const error = `ArgumentValidationError: Object: {token: "${CONVEX_SECRET}"}`;
    writeFileSync(file, JSON.stringify({ evals: [{ id: "cycle/runs-cleanly", error }] }, null, 2));
    runScript([file]);
    const out = readFileSync(file, "utf8");
    assert.ok(!out.includes(CONVEX_SECRET));
    assert.deepEqual(JSON.parse(out), {
      evals: [{ id: "cycle/runs-cleanly", error: 'ArgumentValidationError: Object: {token: "[REDACTED]"}' }],
    });
  });
});

test("a missing file is skipped and the files after it are still redacted", () => {
  // An eval run that dies early writes no summary; that must not leave the junit file unredacted.
  withTempDir((dir) => {
    const file = join(dir, "junit.xml");
    writeFileSync(file, `key ${GATEWAY_KEY}`);
    runScript([join(dir, "summary.json"), file]);
    assert.equal(readFileSync(file, "utf8"), "key [REDACTED]");
  });
});
