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

Note: the test-count prefix is `ℹ` on Node 24 and `#` on Node 22. If you see
`#` you are on the wrong Node; plan 001 fixes that and is a dependency.

## Scope

**In scope:**
- `agent/lib/redact.ts` (create), the pure redactor
- `agent/lib/redact.test.ts` (create)
- `agent/hooks/alert-on-failure.ts`, fix `describe()` and route through the redactor
- `agent/lib/alert.ts`, redact at the boundary as defence in depth
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
- The same for `TRADING212_API_KEY`, `TRADING212_SECRET_KEY`, `FINNHUB_API_KEY`,
  `EXA_API_KEY`, `TIINGO_API_KEY`, `TYPESAFE_API_KEY`, `SLACK_ALERT_WEBHOOK_URL`.
- A generic pattern catches a `token` field even when its value is not a known
  env var, covering both `"token":"abc123"` and `token=abc123` forms.
- An empty or unset env var does **not** turn into a redactor that matches the
  empty string and destroys the whole message. This is the one that will bite:
  a naive `replaceAll("", "[REDACTED]")` corrupts everything.
- A message with no secret passes through unchanged, so diagnostics survive.

Then create `agent/lib/redact.ts` exporting a pure `redact(text: string): string`
that reads the env var names from a module-level list. Skip any env var that is
unset or shorter than, say, 8 characters.

**Verify**: `node --test --experimental-strip-types agent/lib/redact.test.ts`
→ all pass.

### Step 2: Fix `describe()` to read the fields that exist

In `agent/hooks/alert-on-failure.ts`, read `data.message` and `data.code` from
the real payload shape. Keep a fallback, but make it name the code rather than
dump the payload: a failure alert needs to say *what* failed, not carry the
whole object.

Route the result through `redact()` before it is returned.

Add a comment recording why: the previous shape never matched, so the stringify
branch ran on every failure and shipped the raw payload to Slack.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Redact at the alert boundary too

In `agent/lib/alert.ts`, apply `redact()` to the message before it is logged and
before it is POSTed. Defence in depth: a future caller that forgets is then
still safe.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Stop the watchdog logging raw errors

In `scripts/cron-watchdog.mjs`, reduce the caught error to a status and a
truncated message before logging, rather than passing the error object to
`console.error`. An error object can carry request headers and arguments.

This file is `.mjs` and outside the TypeScript build, so it cannot import
`agent/lib/redact.ts` if that would break it. Check how the file is run
(`.github/workflows/cron-watchdog.yml`) and either import it if the runtime
allows, or inline a minimal equivalent with a comment pointing at the shared
one. Do not silently duplicate the list without saying so.

**Verify**: `node --check scripts/cron-watchdog.mjs` → exit 0.

### Step 5: Prove the hook cannot leak

Add a test asserting that `describe()` applied to a realistic eve `turn.failed`
payload whose `details` contains a `token` field returns a string that does
**not** contain that token value.

**Verify**: `pnpm test` → all pass.

### Step 6: Mutation-check

1. Back up the files you changed.
2. Remove the `redact()` call from `describe()`.
3. **Confirm the mutation landed**: `grep -n "redact" agent/hooks/alert-on-failure.ts`.
   `cp` is aliased to `cp -i` here and has silently refused to overwrite before,
   producing a false green.
4. Run tests → step 5's test must go RED.
5. Restore with `/bin/cp -f`, then `git diff` to confirm only intended changes
   remain, and `pnpm test` passes.

**Verify**: you observed red under mutation and green after restore.

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
- [ ] `node --check scripts/cron-watchdog.mjs` exits 0
- [ ] `grep -n "JSON.stringify(data" agent/hooks/alert-on-failure.ts` returns **no match**
- [ ] `grep -n "console.error(\"\[cron-watchdog\] check failed:\", err)" scripts/cron-watchdog.mjs` returns **no match**
- [ ] The step-5 test exists and went red under mutation
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
