# Plan 020: Redact Convex errors at the memory boundary

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in "STOP conditions"
> occurs, stop and report; do not improvise. Do not edit `plans/README.md`; the orchestrator does.
>
> **Drift check (run first)**: `git diff --stat 1e4cc23..HEAD -- agent/lib/memory.ts agent/lib/redact.ts`
> If either changed, compare the "Current state" excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1 (security)
- **Effort**: S
- **Risk**: LOW (error text only; success path unchanged)
- **Depends on**: plan 003 (`agent/lib/redact.ts`, merged in #87)
- **Category**: security
- **Planned at**: commit `1e4cc23`, 2026-10-02

## Why this matters

poof is an autonomous agent trading a real-money Trading 212 ISA. Every Convex function is public
and gated by one shared secret, which the agent sends as an argument: `{ token, ...args }`. When a
call's arguments are missing a field or carry an extra one, Convex's validator prints the WHOLE
argument object into its error, token included. Captured on the dev deployment with a fake token
(2026-10-01):

```
ArgumentValidationError: Object is missing the required field `schedule`. ...

Object: {token: "FAKE_TOKEN_abc123XYZ"}
Validator: v.object({schedule: v.string(), token: v.string()})
```

That text has already carried the real secret out once and forced a rotation. Plan 003 added
`redact()` and applied it to failure alerts, the order path and the cron watchdog. But most agent
tools let a Convex error propagate unredacted: `get_funnel` and `review_eval_health` have no try
block at all, and eve turns a thrown tool error into tool-result text that the model sees. From
there the secret can reach the cycle report posted to Slack, eve's event store, and any eval
transcript. The most likely trigger is ordinary: a deploy where the agent's code and the deployed
Convex functions briefly disagree on a function's arguments.

Every agent Convex call goes through exactly two private methods, `Memory.query` and
`Memory.mutation` in `agent/lib/memory.ts`. Redacting there closes the path for every tool, present
and future, in one place.

## Considered and deferred: moving the secret out of argument position

The deeper fix replaces the shared-secret argument with Convex custom-JWT auth
(`convex/auth.config.ts` with `type: "customJwt"`, `algorithm` RS256 or ES256, a JWKS URL, and
`ConvexHttpClient.setAuth(jwt)`), so the credential travels in a header that validator errors never
print, and functions check `ctx.auth.getUserIdentity()`. It also keeps the secret out of Convex's
own (private) logs. Deferred because it means editing all 45 `assertSecret(args.token)` functions,
generating and storing a signing key, hosting a JWKS endpoint (for example a Convex HTTP action),
and a two-phase rollout (accept both, then drop the token argument) so the deploy window between
Convex and the app cannot break calls. This plan closes the exposure path that matters (secret into
model, Slack, logs, artifacts) at a fraction of the cost. Revisit if the secret ever leaks again or
if Convex logs become shared.

## Current state

`agent/lib/memory.ts` (around lines 276-298):

```ts
export class Memory {
  private readonly client: ConvexLike;
  private readonly token: string;

  constructor(client: ConvexLike, token: string) {
    this.client = client;
    this.token = token;
  }

  private mutation(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.mutation(ref(name), { token: this.token, ...args });
  }
  private query(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.client.query(ref(name), { token: this.token, ...args });
  }
```

`agent/lib/redact.ts` exports `redact(text: string): string`: it replaces the literal value of every
secret env var it lists (including `CONVEX_APP_SECRET`), read on each call, plus a generic `token`
field in Convex (`token: "..."`), JSON and query-string forms. The only other Convex client,
`scripts/cron-watchdog.mjs`, already logs a redacted message (plan 003).

No code inspects extra fields on a caught Convex error (`grep -rn "err.data\|error.data\|instanceof ConvexError" agent`
finds nothing outside tests), but preserve them anyway: keep the same error object.

Conventions: `agent/lib/memory.test.ts` already builds a fake `ConvexLike` client; read it and model
the new tests on it. Tests use `node:test` and `node:assert/strict`, plain fixtures, no mocking
framework. Tests that set `process.env` must restore the previous value (delete it if it was unset).
No TypeScript parameter properties, no `any`, no `@ts-ignore`, no em-dashes.

## Scope

In scope: `agent/lib/memory.ts` (the two private methods, plus one small private helper if useful),
`agent/lib/memory.test.ts`.

Out of scope: anything under `convex/`; the JWT migration above; per-tool error handling in
`agent/tools/*`; `agent/lib/redact.ts` itself (if you believe it must change, STOP and say why).

## Steps

### Step 1: Tests first

Add to `agent/lib/memory.test.ts`, using a fake `ConvexLike` whose `query`/`mutation` reject with an
`Error` whose message is the captured validator text above (with a fake token value of 20+ chars):

1. A failing `query` (through any public facade method, e.g. `openBuys`) rejects with an error whose
   `message` does NOT contain the fake token, DOES still contain `ArgumentValidationError` and the
   `Validator:` line, with `CONVEX_APP_SECRET` set to the fake value.
2. The same with `CONVEX_APP_SECRET` unset (the generic `token: "..."` pattern must catch it).
3. The same for a failing `mutation` (e.g. `recordTrade`).
4. The rejected error is the SAME object the client threw (`assert.equal(caught, thrown)`), so its
   class and any extra fields survive; its `stack`, if present, is redacted too.
5. A non-Error rejection (e.g. a string) is rethrown as an `Error` whose message is redacted.
6. A successful call still resolves with the client's value, and the client still receives
   `{ token, ...args }` unchanged (redaction applies to errors only).

**Verify**: `node --test --experimental-strip-types agent/lib/memory.test.ts` shows tests 1-5 FAIL
(and 6 pass) before the fix.

### Step 2: Redact at the boundary

In `Memory.query` and `Memory.mutation`, catch a rejection, and before rethrowing:
- if it is an `Error`, set `err.message = redact(err.message)` and, if `err.stack` is a string,
  `err.stack = redact(err.stack)`, then rethrow the same object;
- otherwise throw `new Error(redact(String(err)))`.

Add a short comment saying why (Convex validator errors print the argument object, token included;
this is the single choke point every tool's Convex call passes through). Keep the success path
byte-identical in behaviour.

**Verify**: all memory tests pass; `pnpm typecheck` exits 0.

### Step 3: Mutation-check

For each: back up with `/bin/cp -f`, change, confirm with grep that it landed, run the memory tests,
restore with `/bin/cp -f`, confirm `git diff` shows only intended changes and tests are green.
- (a) Remove redaction from `query`: tests 1, 2, 4 go red.
- (b) Remove redaction from `mutation`: test 3 goes red.
- (c) Throw `new Error(redact(err.message))` instead of mutating in place: test 4 goes red.

**Verify**: all three observed red, green after restore.

## Done criteria

- `pnpm test` exits 0 with `ℹ fail 0` (Node 24; run `source ~/.nvm/nvm.sh` then `nvm use` as
  separate commands first) and at least 6 new tests
- `pnpm typecheck` and `npx tsc -p convex/tsconfig.json` exit 0
- `grep -n "redact" agent/lib/memory.ts` shows the import and its use in both methods
- All three mutations observed red, green after restore
- `git status --short` shows only `agent/lib/memory.ts` and `agent/lib/memory.test.ts`

## STOP conditions

- The "Current state" excerpt does not match the live code.
- Any Convex call in `agent/` bypasses `Memory.query`/`Memory.mutation` (check with
  `grep -rn "\.query(\|\.mutation(" agent --include=*.ts | grep -v test`); report it rather than
  patching it ad hoc.
- A test you add passes before the fix.

## Maintenance notes

- Any new Convex client created outside `Memory` must redact its errors the same way, or route
  through `Memory`.
- If Convex changes its validator error format (for example to quote the key), the generic pattern in
  `redact.ts` may miss the no-env-var case; the exact-value layer still covers every process that
  holds `CONVEX_APP_SECRET`, which includes Vercel and CI.
- The JWT migration remains the real fix for the credential being an argument at all; see above.
