# Plan 003: Stop failure payloads carrying the shared secret to Slack

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- agent/hooks/alert-on-failure.ts agent/lib/alert.ts scripts/cron-watchdog.mjs`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (a pure-function redactor plus a shape fix; the only way to break it is to over-redact and lose diagnostics)
- **Depends on**: plans/001-reinstall-dependency-tree.md
- **Category**: security
- **Planned at**: commit `0859c96`, 2026-09-30
- **Amended at**: commit `003bf9d`, 2026-10-01 (real Convex error format, full secret list, `describe` moved to `agent/lib/alert.ts`, watchdog imports the redactor)

## Why this matters

`luciengeorge/poof` is a **public** GitHub repository, so its Actions logs are
world-readable. The Convex deployment URL is public too, and a single shared
secret is the only thing gating every function on it.

`agent/hooks/alert-on-failure.ts` tries to extract a short message from a
failure event, and falls back to stringifying the whole payload if it cannot
find one. It can never find one: it looks for `data.error.message` and
`data.reason`, but eve's actual `turn.failed` payload is
`{ code, details?, message, sequence, turnId }`. **Neither field it looks for
exists**, so the fallback runs every single time, sending up to 500 characters
of raw failure payload to Slack.

Convex serialises the offending argument object into its validation errors, and
`agent/lib/memory.ts` sends `{ token: this.token, ...args }` on every call, so
`token` is the first key in that object. This is not hypothetical: the secret
was already burned once by exactly this path, via an `ArgumentValidationError`
from `memory:latestCronRun`, and had to be rotated.

Current exposure was checked on 2026-09-30 and is clean: zero failed turns since
the last rotation, `cron-watchdog` 9/9 successful, and GitHub masked every
secret in the failing eval logs. So this is a live hazard that has not yet
fired again, not an active incident. **GitHub's masking covers the Actions half
but is exact-substring only** and is defeated by JSON escaping, base64, or a
value split across lines. Slack has no masking at all, and Slack is where this
hook sends.

## Current state

`agent/hooks/alert-on-failure.ts` in full as of `0859c96`:

```ts
function describe(event: { data?: unknown }): string {
  const data = event?.data as
    | { error?: { message?: string }; reason?: string }
    | undefined;
  const msg = data?.error?.message ?? data?.reason;
  if (msg) return String(msg).slice(0, 500);
  try {
    return JSON.stringify(data ?? {}).slice(0, 500);
  } catch {
    return "(unserializable failure payload)";
  }
}
```

eve's real payload shape, from
`node_modules/eve/dist/src/protocol/message.d.ts:735-741`:

```ts
export declare function createTurnFailedEvent(input: {
    readonly code: string;
    readonly details?: JsonObject;
    readonly message: string;
    readonly sequence: number;
    readonly turnId: string;
}): TurnFailedStreamEvent;
```

`agent/lib/alert.ts` logs the string and POSTs it to `SLACK_ALERT_WEBHOOK_URL`.
Its tests (`agent/lib/alert.test.ts`, 5 tests) stub `globalThis.fetch`,
`console.error` and the webhook env var with a `withStubbedWebhook` helper at
the top of the file; reuse it.

**What Convex's validation errors actually look like.** Captured on 2026-10-01
from the DEV deployment with a fake token (`memory:latestCronRun` called with a
missing field, then an extra field). This is the leak path, and the exact text
your tests should use:

```
[Request ID: 9c9740cd81b808e1] Server Error
ArgumentValidationError: Object is missing the required field `schedule`. Consider wrapping the field validator in `v.optional(...)` if this is expected.

Object: {token: "FAKE_TOKEN_abc123XYZ"}
Validator: v.object({schedule: v.string(), token: v.string()})
```

```
ArgumentValidationError: Object contains extra field `extra` that is not in the validator.

Object: {extra: 1.0, schedule: "cycle", token: "FAKE_TOKEN_abc123XYZ"}
Validator: v.object({schedule: v.string(), token: v.string()})
```

Note the form: **unquoted key, colon, space, double-quoted value**
(`token: "..."`). That is neither JSON (`"token":"..."`) nor a query string
(`token=...`). A type mismatch on one field prints only that field
(`Path: .schedule` / `Value: 42.0`), so it does not leak; a missing or extra
field prints the whole object, and `token` is in it.

**Secret env vars this process can hold** (from every `process.env.X` read in
`agent/`, `scripts/` and `convex/`, plus `npx vercel env ls production`):
`CONVEX_APP_SECRET`, `APP_SHARED_SECRET`, `CONVEX_DEPLOY_KEY`,
`TRADING212_API_KEY`, `TRADING212_API_SECRET`, `TRADING212_SECRET_KEY`,
`FINNHUB_API_KEY`, `EXA_API_KEY`, `TIINGO_API_KEY`, `TYPESAFE_API_KEY`,
`SLACK_ALERT_WEBHOOK_URL`, `ROUTE_AUTH_BASIC_PASSWORD`. `agent/lib/t212.ts`
accepts the T212 secret under either `TRADING212_API_SECRET` or
`TRADING212_SECRET_KEY`, so both are listed.

`scripts/cron-watchdog.mjs` already imports TypeScript from `agent/lib`
(`import { heartbeatUtcDay, lastExpectedCycleDay } from "../agent/lib/cron-watchdog.ts";`),
and `.github/workflows/cron-watchdog.yml` runs it with `node-version: 24`, which
strips types natively. So it can import the redactor the same way.

`scripts/cron-watchdog.mjs` passes the secret into a Convex call and logs raw
errors:

```js
const run = await client.query(anyApi.memory.latestCronRun, {
  token: convexSecret,
  schedule: "cycle",
});
...
} catch (err) {
  console.error("[cron-watchdog] check failed:", err);
  process.exit(1);
}
```

Conventions: this repo favours small pure functions with their own unit tests.
`agent/lib/leak-guard.ts` may already exist in a sibling project; check whether
poof has an equivalent before writing a new one, and reuse it if so.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Tests | `pnpm test` | exit 0, `ℹ fail 0` (see note) |
| Convex typecheck | `npx tsc -p convex/tsconfig.json` | exit 0 |

| Build (eve validates hooks) | `pnpm build` | exit 0 |

Node version: the repo needs Node 24 (`.nvmrc`) but the default shell is Node
22. Run `source ~/.nvm/nvm.sh && nvm use` in every shell before any command.
Node 24 prints `ℹ pass N`; `# pass N` means you skipped `nvm use`, not that
plan 001 is undone (it is DONE).

## Scope

**In scope:**
- `agent/lib/redact.ts` (create), the pure redactor
- `agent/lib/redact.test.ts` (create)
- `agent/hooks/alert-on-failure.ts`: delete the local `describe()` and import
  `describeFailure` from `agent/lib/alert.ts` instead
- `agent/lib/alert.ts`: add the exported `describeFailure`, and redact at the
  boundary as defence in depth
- `agent/lib/alert.test.ts`: tests for both
- `scripts/cron-watchdog.mjs`, stop logging raw error objects

**Out of scope** (do NOT touch, even though they look related):
- Moving the secret out of the Convex argument position. That is the deeper fix
  (the validator errors before any app code can redact) but it is an M-sized
  change across 42 public functions and it is not this plan.
- Rotating `CONVEX_APP_SECRET`. Checked on 2026-09-30, no evidence of exposure
  since the last rotation. The operator decides when; do not do it here.
- Every other `console.warn(..., err)` in `agent/`. Fix the paths that carry
  Convex arguments; a blanket sweep is a separate, larger change.
- `.github/workflows/*.yml`. GitHub's own masking covers those and changing
  workflow files risks breaking CI for no security gain here.

## Git workflow

- Branch: `advisor/003-redact-failure-payloads`
- One or two commits. Conventional commits, imperative subject, body explaining
  why, matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the redactor, tests first

Create `agent/lib/redact.test.ts` before the implementation. It must cover:

- A string containing the value of `CONVEX_APP_SECRET` has it replaced.
- The same for every name in the "Secret env vars" list in Current state. Set
  each to a distinct fake value of 20+ characters in the test, and restore the
  previous env afterwards.
- A generic pattern catches a `token` field even when its value is not a known
  env var (the watchdog and any process missing the env var depend on this). It
  must cover all three forms, with the **Convex form first because it is the
  real leak path**: `token: "abc123"` (use the captured
  `ArgumentValidationError` text from Current state verbatim as the fixture),
  `"token":"abc123"`, and `token=abc123`. The rest of the message (the
  `Object is missing the required field` line, the `Validator:` line) must
  survive, so the alert still says what went wrong.
- An empty or unset env var does **not** turn into a redactor that matches the
  empty string and destroys the whole message. This is the one that will bite:
  a naive `replaceAll("", "[REDACTED]")` corrupts everything.
- A message with no secret passes through unchanged, so diagnostics survive.

Then create `agent/lib/redact.ts` exporting a pure `redact(text: string): string`
that keeps the env var NAMES in a module-level list but reads their VALUES from
`process.env` on every call (not at import), so tests can set them and a value
set after import is still caught. Skip any env var that is unset or shorter than
8 characters. Replace with a fixed marker such as `[REDACTED]`.

**Verify**: `node --test --experimental-strip-types agent/lib/redact.test.ts`
→ all pass.

### Step 2: Replace `describe()` with a tested `describeFailure` in `agent/lib/alert.ts`

Move the logic out of the hook file: eve discovers hooks from `agent/hooks/`, so
keep that file to its default `defineHook` export and put testable logic in
`agent/lib`, the way `agent/hooks/trace-cycle.ts` imports its helpers.

In `agent/lib/alert.ts`, export `describeFailure(event: { data?: unknown }): string`.
It reads `data.message` and `data.code` from eve's real payload shape, returns
something like `` `${code}: ${message}` `` truncated to 500 characters, and never
stringifies the whole payload (including `details`). If neither field is a
string, return a fixed text naming that the payload had no message. Route the
result through `redact()` before returning it.

In `agent/hooks/alert-on-failure.ts`, delete the local `describe()` and call the
imported `describeFailure(event)` in both handlers. Change nothing else there.

Add a comment recording why: the previous shape never matched, so the stringify
branch ran on every failure and shipped the raw payload to Slack.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Redact at the alert boundary too

In `agent/lib/alert.ts`, apply `redact()` to the message before it is logged and
before it is POSTed. Defence in depth: a future caller that forgets is then
still safe.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Stop the watchdog logging raw errors

In `scripts/cron-watchdog.mjs`, reduce the caught error to a truncated,
redacted message before logging, rather than passing the error object to
`console.error`. An error object can carry request arguments. Import `redact`
from `../agent/lib/redact.ts`, the same way the file already imports
`../agent/lib/cron-watchdog.ts`. Do not duplicate the list.

**Verify**: `node --check scripts/cron-watchdog.mjs` → exit 0.

### Step 5: Prove the failure path cannot leak

In `agent/lib/alert.test.ts` add:

1. `describeFailure` on a realistic eve `turn.failed` payload
   (`{ code, message, sequence, turnId, details }`) whose `message` is the
   captured Convex `ArgumentValidationError` text carrying
   `token: "FAKE_TOKEN_abc123XYZ"` and whose `details` also holds a `token`:
   the result contains `ArgumentValidationError`, does **not** contain
   `FAKE_TOKEN_abc123XYZ`, and does not contain `details`' contents.
2. With no env var set for it, the same assertion holds (the generic pattern,
   not the env lookup, must catch it).
3. `alert()` redacts at the boundary: call `alert()` with text containing a
   fake `CONVEX_APP_SECRET` value (set the env var in the test), using
   `withStubbedWebhook` with a fetch that records the request body and a
   `console.error` stub that records its arguments. Assert neither the POSTed
   body nor the logged text contains the value.

**Verify**: `pnpm test` → all pass.

### Step 6: Mutation-check

For each: back up with `/bin/cp -f`, make the change, **confirm it landed with
grep and read the line** (`cp` is aliased to `cp -i` here and has silently
refused before), run the tests, restore with `/bin/cp -f`, then confirm with
`git diff <file>` and a green run.

- **A.** Remove the `redact()` call from `describeFailure`. Step 5 tests 1 and 2
  must go RED.
- **B.** Remove the `redact()` call from `alert()`. Step 5 test 3 must go RED.
- **C.** Remove the unquoted-key (`token: "..."`) form from the generic pattern,
  keeping the other two. The Convex-form redact test and step 5 test 2 must go
  RED. This is the mutation that proves the real leak path is covered.
- **D.** Remove the "skip unset or short env vars" guard. The empty-env-var test
  must go RED.

**Verify**: all four went red, and everything is green after each restore.

## Test plan

- `agent/lib/redact.test.ts`: the cases in step 1, especially the empty-env-var
  case.
- A test in the hook's own test file (create if absent) for step 5.
- Model structure on any existing `agent/lib/*.test.ts`; they use `node:test`
  with `node:assert/strict` and plain fixtures, no mocking framework.

Verification: `pnpm test` → all pass, new tests included.

## Done criteria

ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0`
- [ ] `pnpm build` exits 0
- [ ] `node --check scripts/cron-watchdog.mjs` exits 0
- [ ] `grep -n "JSON.stringify(data" agent/hooks/alert-on-failure.ts` returns **no match**
- [ ] `grep -n "console.error(\"\[cron-watchdog\] check failed:\", err)" scripts/cron-watchdog.mjs` returns **no match**
- [ ] All four step-6 mutations went red, and green after restore
- [ ] `grep -n "describe(" agent/hooks/alert-on-failure.ts` returns no match, and
      `grep -n "describeFailure" agent/hooks/alert-on-failure.ts` matches
- [ ] No secret VALUE appears in any file you wrote
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The "Current state" excerpts do not match the live files.
- eve's `turn.failed` payload shape in the installed
  `node_modules/eve/dist/src/protocol/message.d.ts` differs from the excerpt
  above. The whole fix depends on that shape; do not guess it.
- You find a secret value committed anywhere in the repo. Report the
  `file:line` and the credential type, never the value, and stop.
- Redacting breaks an existing test that depends on full error text.
- You conclude the fix requires moving the secret out of the Convex argument
  position. It does not for this plan, and that change is explicitly out of
  scope.

## Maintenance notes

- A reviewer should check the empty-env-var case specifically. A redactor built
  from unset variables that matches the empty string will replace between every
  character and destroy all diagnostics, which is a worse failure than the one
  being fixed.
- The deeper issue remains open and is deliberately deferred: `assertSecret`
  runs *inside* the handler, i.e. after Convex's own argument validator, so a
  validation error is generated before any application code can redact it.
  Convex's server-side error text is outside our control. Redaction only helps
  once the error reaches our process. Moving the secret to a header or a
  per-deployment mechanism is the real fix and should be considered if this
  path ever fires again.
- Exposure was clean when this plan was written (2026-09-30): no failed turns
  since the last rotation, watchdog 9/9, GitHub masking held. If a turn fails
  between now and this landing, re-check before assuming that is still true.
