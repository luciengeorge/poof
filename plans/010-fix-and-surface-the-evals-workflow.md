# Plan 010: Fix the evals workflow and make its failure loud

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- .github/workflows/evals.yml agent/lib/t212.ts agent/lib/t212.test.ts agent/lib/state.ts .env.example`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.
>
> **Secrets discipline**: `luciengeorge/poof` is a PUBLIC repository, so Actions
> logs are world-readable. Never add a step that prints an error object, a
> request, a response body, or `env` in a way that could carry a credential.
> GitHub masks values injected through `secrets.*`, but masking is exact-substring
> and is defeated by JSON escaping or by a value that gets split across a line.
> Refer to credentials by NAME only, here and in anything you write.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-reinstall-dependency-tree.md (so a local run is evidence), plans/009 (CI conventions this extends)
- **Category**: dx
- **Planned at**: commit `0859c96`, 2026-09-30

## Why this matters

poof is an autonomous agent trading a REAL Trading 212 UK ISA with about £250
of real money. Its behavioural safety guards (check earnings before buying,
red-team before buying, manage exits before opening entries, never send an
instrument to the broker twice) are asserted by the eval suite in `evals/`,
which runs nightly in GitHub Actions. That suite has not passed once in the
last twelve scheduled runs. Every run since 2026-09-18 has failed, and nobody
noticed, because the only signal a scheduled workflow gives when it fails is a
red tick on a page nobody opens.

The root cause is credentials: the workflow runs against the Trading 212 DEMO
host but injects the LIVE account's API credentials, so every broker call
returns `401` and the agent can never reach `submit_orders`. That is what
actually fails the suite.

This is one of four measurement systems in poof found broken at the same time,
and every one of them reported healthy. The specific thing this plan fixes is
not the 401. It is that **a broken instrument reported healthy for twelve
days.** So this plan does three things: remove the live broker credential from
CI entirely and replace it with a deterministic fake, make the failure page
somebody, and make the failure diagnosable.

## Current state

### The workflow

`.github/workflows/evals.yml` as of `0859c96` (whole file, 45 lines). The
relevant part is the `env:` block, lines 22-30:

```yaml
    env:
      DRY_RUN: "true" # never place real orders in evals
      TRADING212_ENV: "demo" # hit the demo account only
      AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
      FINNHUB_API_KEY: ${{ secrets.FINNHUB_API_KEY }}
      EXA_API_KEY: ${{ secrets.EXA_API_KEY }}
      CONVEX_URL: ${{ secrets.CONVEX_URL }}
      CONVEX_APP_SECRET: ${{ secrets.CONVEX_APP_SECRET }}
      TRADING212_API_KEY: ${{ secrets.TRADING212_API_KEY }}
      TRADING212_SECRET_KEY: ${{ secrets.TRADING212_SECRET_KEY }}
```

and the last step, lines 38-45:

```yaml
      - name: Upload eval artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eval-artifacts
          path: .eve/
          if-no-files-found: ignore
```

The file header comment already claims those two `TRADING212_*` secrets are
"(demo keys)". They are not: they are the live account's, which is why the
demo host rejects them.

### The evidence

`gh run list --workflow=evals.yml --limit 12` returns twelve rows, all
`completed  failure`, from 2026-09-18 to 2026-09-29.

From the newest run's log (`gh run view 36584971859 --log-failed`):

- 31 occurrences of `T212Error: Trading 212 API error 401: \n` (the response
  body is empty, so nothing sensitive is in the log today, but see the secrets
  note above: keep it that way).
- `Results: 6 passed, 1 failed (7 total)` / `Gates: 14 passed, 6 failed`.
- The one failing eval is `cycle/buy-path-guards`, with `gates 1/7`. Its six
  failed gates are all downstream of one thing: the agent never reached
  `submit_orders`, because every broker read 401'd.
- `No files were found with the provided path: .eve/. No artifacts will be
  uploaded.`

### Why nothing was uploaded

From the same log:

```
##[group]Run actions/upload-artifact@v4
  name: eval-artifacts
  include-hidden-files: false
No files were found with the provided path: .eve/. No artifacts will be uploaded.
```

`actions/upload-artifact@v4` excludes dotfiles and dot-directories unless
`include-hidden-files: true` is set. `.eve/` is a dot-directory, so the entire
artifact was filtered out. eve does write it: `node_modules/eve/dist/src/evals/runner/run-evals.js`
calls `writeArtifacts(resolveArtifactDirectory(appRoot), summary)`, and
`resolveArtifactDirectory` returns `join(appRoot, ".eve", "evals", <timestamp>)`.
`.eve` is also in `.gitignore`, so it never collides with tracked files.

### The second, quieter problem

Look again at `6 passed, 1 failed`. Six of the seven evals go GREEN against a
broker that returns 401 to every single call. `cycle/runs-cleanly`,
`cycle/earnings-guard`, `cycle/red-team-before-buy` and
`cycle/strategy-tag-on-buy` all passed, because their assertions are
CONDITIONAL ("if the agent bought, then...") and the agent never bought. The
logs say so out loud (`PASSED VACUOUSLY (no submit_orders in this run)`),
which is `evals/lib/cycle-invariants.ts` doing its job. `cycle/buy-path-guards`
exists precisely to close that hole. Fixing the broker makes the other six
evals mean something again, not just the failing one.

### What the evals need from the broker

The whole cycle touches only three Trading 212 endpoints. Verified by grepping
the tools:

| Endpoint | Method | Reached by |
|---|---|---|
| `/equity/account/cash` | GET | `getCash`, `getBrokerSnapshot` |
| `/equity/portfolio` | GET | `getPortfolio`, `getBrokerSnapshot` |
| `/equity/orders/market` | POST | `placeMarketOrder`, **only when `DRY_RUN=false`** |

Callers: `agent/tools/get_account.ts:14`, `agent/tools/review_performance.ts:31`,
`agent/tools/record_cycle.ts:35`, `agent/tools/manage_positions.ts:29`,
`agent/lib/orders.ts:179`. No tool calls `getInstruments`, `getOrders`,
`getPosition`, `placeLimitOrder` or `cancelOrder`.

So the evals do not need a broker account. They need two GET responses.

### The client and its factory

`agent/lib/t212.ts:2-9`:

```ts
export type T212Env = "demo" | "live";
export type TimeValidity = "DAY" | "GTC";

const HOSTS: Record<T212Env, string> = {
  demo: "https://demo.trading212.com/api/v0",
  live: "https://live.trading212.com/api/v0",
};
```

`agent/lib/t212.ts:250-270` (the factory you will modify):

```ts
// Per-process singleton so every tool invoked within one serverless invocation (one cycle)
// shares the same client, and thus the same getCash/getPortfolio cache. Only memoized for
// the default (no injected fetchImpl) path; callers that pass a fetchImpl (tests) always get
// a fresh client.
let singleton: T212Client | null = null;

export function t212FromEnv(fetchImpl?: typeof fetch): T212Client {
  if (!fetchImpl && singleton) return singleton;
  const apiKey = process.env.TRADING212_API_KEY;
  // Accept either name: TRADING212_API_SECRET (docs) or TRADING212_SECRET_KEY.
  const apiSecret =
    process.env.TRADING212_API_SECRET ?? process.env.TRADING212_SECRET_KEY;
  const env = (process.env.TRADING212_ENV ?? "demo") as T212Env;
  if (!apiKey || !apiSecret) {
    throw new Error(
      "TRADING212_API_KEY and TRADING212_API_SECRET (or TRADING212_SECRET_KEY) must be set",
    );
  }
  const client = new T212Client({ apiKey, apiSecret, env, fetchImpl });
  if (!fetchImpl) singleton = client;
  return client;
}
```

The constructor already takes `fetchImpl`, `agent/lib/t212.ts:108-113`:

```ts
  constructor(cfg: T212Config) {
    this.base = HOSTS[cfg.env];
    this.auth = buildAuthHeader(cfg.apiKey, cfg.apiSecret);
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }
```

The two payload shapes, `agent/lib/t212.ts:18-36`:

```ts
export interface CashBalance {
  total: number;
  free: number;
  blocked: number;
  invested: number;
  pieCash: number;
  result: number;
  ppl: number;
}

export interface T212Position {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  ppl: number;
  maxBuy: number;
  maxSell: number;
  pieQuantity: number;
}
```

Tickers on this API carry a `_US_EQ` suffix (`"AAPL_US_EQ"`), mapped back to a
plain symbol by `t212TickerToFinnhubSymbol` in `agent/lib/execution.ts:65`.
Existing fixtures use that shape: see `agent/lib/t212.test.ts:99`.

### The DRY_RUN kill switch

`agent/lib/state.ts:144-147`:

```ts
/** DRY_RUN defaults ON (safe). Only `DRY_RUN=false` enables real order placement. */
export function isDryRun(): boolean {
  return process.env.DRY_RUN !== "false";
}
```

This is the interlock you will hang the fake broker off. Read it before step 2.

### The Slack alert precedent

`.github/workflows/cron-watchdog.yml` is the pattern to follow. Its script,
`scripts/cron-watchdog.mjs`, posts to Slack itself and then `process.exit(1)`:

```js
async function postSlackAlert(webhookUrl, text) {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("[cron-watchdog] failed to post Slack alert:", err);
  }
}
```

and the workflow passes it `SLACK_ALERT_WEBHOOK_URL: ${{ secrets.SLACK_ALERT_WEBHOOK_URL }}`.
So `SLACK_ALERT_WEBHOOK_URL` already exists as a repo secret. There is also a
runtime helper at `agent/lib/alert.ts` (`alert(text)`), but it is a TypeScript
module on the trading path with a hook-safety contract in its doc comment; do
not import it into a workflow step. Post from the workflow with `curl`, or with
a tiny `.mjs` script in `scripts/`, mirroring `cron-watchdog.mjs`.

### Conventions

- Pure, unit-tested functions; IO at the edges. Comments explain WHY, at
  length, and are not written on every line.
- No em-dashes anywhere.
- **NEVER use TypeScript parameter properties** (`constructor(private readonly x)`).
  `--experimental-strip-types` cannot erase them and the test file dies with a
  bare "test failed". Assign fields in the constructor body, as
  `T212Client` does.
- Tests are `node:test` + `node:assert/strict`, plain object fixtures, no
  mocking framework. `agent/lib/t212.test.ts` and `agent/lib/data.test.ts` are
  the exemplars; both build a `fakeFetch` helper returning a real `Response`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck (app) | `pnpm typecheck` | exit 0 |
| Typecheck (convex) | `npx tsc -p convex/tsconfig.json` | exit 0 |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |
| One test file | `node --test --experimental-strip-types agent/lib/t212.test.ts` | all pass |
| Build | `pnpm build` | exit 0 |
| Workflow history | `gh run list --workflow=evals.yml --limit 12` | 12 rows |
| Trigger the workflow | `gh workflow run evals.yml` | queued |
| Watch a run | `gh run watch <id>` | terminal verdict |
| Failed-step log | `gh run view <id> --log-failed` | log text |
| Lint the YAML | `node -e "process.stdout.write('ok')"` (see step 5 for the real check) | see step 5 |

Node must be 24.x. `pnpm eval` and `eve` refuse to start on Node 22 with
`eve requires Node.js >=24`. Plan 001 fixes that; if you hit this message, STOP.

## Scope

**In scope:**
- `agent/lib/t212-fake.ts` (create), the canned wire responses
- `agent/lib/t212-fake.test.ts` (create), its tests, including the interlock
- `agent/lib/t212.ts`, `t212FromEnv` only, to select the fake
- `agent/lib/t212.test.ts`, tests for the new `t212FromEnv` branch
- `.github/workflows/evals.yml`, env block, artifact upload, alert step
- `scripts/eval-alert.mjs` (create, only if you choose the script route in step 6)
- `.env.example`, document the new flag
- `plans/README.md`, status row

**Out of scope** (do NOT touch, even though they look related):
- **Anything under `evals/`.** The eval definitions are correct. `buy-path-guards`
  failing when no BUY happens is the guard working, not a bug. Do not weaken an
  assertion, do not add a hint to a prompt (`evals/cycle/buy-path-guards.eval.ts`
  says in a comment why hints destroy the measurement), do not delete an eval.
- **`agent/lib/alert.ts`, `agent/hooks/*`, `agent/lib/eval-health.ts`.** The
  ONLINE eval path (production cycle traces) is a different system from the CI
  eval suite. This plan touches only CI.
- **`T212Client`'s request/caching/retry logic** (`agent/lib/t212.ts:130-250`).
  You are injecting a fake `fetch`, not a fake client, so that the real parsing,
  caching and 429 handling still runs in CI. Changing the client would defeat
  that.
- **The risk gate, position sizing, or exit constants.** Nothing in this plan
  may change what a live cycle does.
- **Provisioning, rotating, or reading any credential.** You cannot create
  Trading 212 demo API keys and must not try.
- `.github/workflows/ci.yml` and `cron-watchdog.yml`. Read them as precedent;
  do not edit them.

## Git workflow

- Branch: `advisor/010-fix-and-surface-the-evals-workflow`
- Conventional commits, imperative subject, body explaining the mechanism.
  Recent examples from `git log`: `fix(funnel): the universe never reached the
  deployed bundle`, `fix(watchdog): check the last CLOSED window, not "today"`.
  Suggested split: one commit for the fake broker
  (`test(evals):` / `feat(evals): run CI evals against a fake broker wire`),
  one for the workflow (`fix(ci): the evals workflow has failed 12 nights
  running, silently`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the outage is still real

Do not fix a workflow that somebody already fixed.

```
gh run list --workflow=evals.yml --limit 12
```

**Verify**: every row reads `completed  failure`. Then:

```
gh run view --workflow=evals.yml --log-failed 2>/dev/null | grep -c "Trading 212 API error 401"
```
on the newest failing run id from the list above (`gh run view <id> --log-failed | grep -c ...`)
→ a count greater than zero.

If the most recent run PASSED, STOP and report: the premise has changed.

### Step 2: Write the fake broker wire, test-first

Create `agent/lib/t212-fake.test.ts` BEFORE the implementation. It must cover:

1. A `GET` to a URL ending `/equity/account/cash` resolves with status 200 and
   a body that parses into a `CashBalance` with every field a finite number and
   `free > 0`.
2. A `GET` to a URL ending `/equity/portfolio` resolves 200 with an array of
   `T212Position`, each `ticker` matching `/^[A-Z]+_US_EQ$/` and each numeric
   field finite.
3. An unrecognised path (say `/equity/metadata/instruments`) does NOT silently
   return `{}`. It must reject, or resolve with a non-ok status, so that a
   future tool reaching a new endpoint fails loudly in CI instead of quietly
   receiving nonsense. Assert whichever you implement.
4. The fake never calls the global `fetch`. Assert this by constructing a
   `T212Client` with the fake and checking the returned values, rather than by
   network mocking: if the fake tried the network, the test would be slow or
   throw.

Then create `agent/lib/t212-fake.ts`:

```ts
/** Fixed cash so an eval's arithmetic is reproducible run to run. */
export const FAKE_CASH: CashBalance = { /* fill in; free must comfortably
  cover one small BUY so buy-path-guards can reach submit_orders */ };

export const FAKE_POSITIONS: T212Position[] = [ /* two or three, mixed winner
  and loser, so manage_positions and review_performance have something real to
  say */ ];

/**
 * A canned Trading 212 wire, for CI only.
 *
 * WHY A FAKE FETCH RATHER THAN A FAKE CLIENT. T212Client owns the response
 * parsing, the snapshot cache and the 429 backoff, and those are exactly the
 * parts a behavioural eval should still exercise. Faking the wire keeps all of
 * it in the loop and fakes only the network.
 */
export function fakeT212Fetch(): typeof fetch { /* ... */ }
```

Build responses with `new Response(JSON.stringify(body), { status: 200 })`,
matching the `fakeFetch` helper at `agent/lib/data.test.ts:5-21`.

Pick position tickers that are in `agent/data/universe.ts` so the rest of the
cycle can price them through Finnhub.

**Verify**: `node --test --experimental-strip-types agent/lib/t212-fake.test.ts`
→ all pass.

### Step 3: Select the fake from `t212FromEnv`, behind a hard interlock

This is the one change that touches the money path, so the interlock matters
more than the feature.

In `agent/lib/t212.ts`, modify ONLY `t212FromEnv`. Target shape:

```ts
export function t212FromEnv(fetchImpl?: typeof fetch): T212Client {
  if (!fetchImpl && singleton) return singleton;
  const useFake = !fetchImpl && process.env.BROKER_FAKE === "true";
  // THE INTERLOCK. A fake broker reports a balance that does not exist. If it
  // were ever reachable with real order placement armed, the risk gate and the
  // position sizer would size a REAL order off fantasy cash. So the fake is
  // refused outright unless the kill switch is on, rather than being quietly
  // ignored: a silent downgrade to the real broker in CI would reintroduce the
  // exact failure this exists to remove.
  if (useFake && !isDryRun()) {
    throw new Error(
      "BROKER_FAKE=true requires DRY_RUN=true. Refusing to serve a fake broker " +
        "balance while real order placement is armed.",
    );
  }
  // ... existing credential read, but SKIP the throw when useFake ...
}
```

Requirements, all of which the tests in step 4 must pin:

- Import `isDryRun` from `./state.ts`.
- When `useFake` is true, the missing-credential throw must NOT fire. The whole
  point is that CI carries no broker credential at all.
- When `useFake` is true, force `env` to `"demo"` regardless of `TRADING212_ENV`,
  so `HOSTS[env]` can never be the live host even in a URL the fake ignores.
- The singleton memoisation must still apply on the fake path (one client, one
  snapshot cache, per process), exactly as on the real path.
- `BROKER_FAKE` anything other than the exact string `"true"` means off.

Add a doc comment above `t212FromEnv` explaining why the flag exists: the CI
eval suite ran for twelve nights against a live credential that could not
authenticate, and a public repo should not be handed a live brokerage key for a
job that only needs two canned GETs.

**Verify**: `pnpm typecheck` → exit 0.

### Step 4: Pin the interlock with tests

Add to `agent/lib/t212.test.ts`. Use the env save/restore idiom already in this
repo at `agent/lib/risk-runtime.test.ts:20-29` (read it; it saves the previous
value and restores it in a `finally`, including the `delete` case). The
singleton in `t212.ts` is module-level, so these tests must not leak a memoized
fake into later tests: assert on fresh behaviour and note the ordering in a
comment, or export a reset hook the way `agent/lib/fx.ts:151-153` exports
`resetFxCache()`. Prefer the reset hook; it is the existing convention.

Tests to write:

1. `BROKER_FAKE=true`, `DRY_RUN=true`, no `TRADING212_API_KEY` set →
   `t212FromEnv()` returns a client, and `await client.getCash()` resolves to
   `FAKE_CASH`.
2. `BROKER_FAKE=true`, `DRY_RUN=false` → `t212FromEnv()` THROWS, and the message
   mentions `DRY_RUN`. **This is the test that matters most.**
3. `BROKER_FAKE=true`, `TRADING212_ENV=live`, `DRY_RUN=true` → still the fake,
   and no live host is contacted. (Assert on the returned cash, which only the
   fake can produce.)
4. `BROKER_FAKE` unset with credentials present → unchanged behaviour, the real
   client, and `getCash` goes through the injected `fetchImpl` as before.
5. `BROKER_FAKE` unset and credentials absent → still throws the original
   `TRADING212_API_KEY and TRADING212_API_SECRET ...` error.

**Verify**: `node --test --experimental-strip-types agent/lib/t212.test.ts`
→ all pass, and `pnpm test` → exit 0, `ℹ fail 0`.

### Step 5: Rewrite the workflow's env block and fix the artifact upload

In `.github/workflows/evals.yml`:

1. **Delete** the `TRADING212_API_KEY` and `TRADING212_SECRET_KEY` lines from
   the `env:` block. A public repo's nightly job should not hold a live
   brokerage credential.
2. **Add** `BROKER_FAKE: "true"` beside the existing `DRY_RUN: "true"` and
   `TRADING212_ENV: "demo"`.
3. **Update the file header comment.** It currently lists
   `TRADING212_API_KEY, TRADING212_SECRET_KEY (demo keys)` as required secrets.
   That claim is what hid this bug: someone wrote "(demo keys)" and it was never
   true. Replace it with a sentence saying the evals run against a canned broker
   wire (`agent/lib/t212-fake.ts`) and deliberately hold no broker credential,
   and why.
4. On the `Upload eval artifacts` step, add `include-hidden-files: true`. Keep
   `if: always()` and `if-no-files-found: ignore`. Change `path: .eve/` to
   `path: .eve/evals/` so the upload is the eval artifacts specifically rather
   than whatever else eve caches under `.eve/`.

**Verify (YAML parses)**:
```
node --input-type=module -e "
import {readFileSync} from 'node:fs';
const s = readFileSync('.github/workflows/evals.yml','utf8');
if (/TRADING212_API_KEY|TRADING212_SECRET_KEY|TRADING212_API_SECRET/.test(s)) throw new Error('broker credential still referenced');
if (!/BROKER_FAKE: \"true\"/.test(s)) throw new Error('BROKER_FAKE not set');
if (!/include-hidden-files: true/.test(s)) throw new Error('artifact fix missing');
console.log('ok');
"
```
→ prints `ok`.

**Verify (Actions accepts it)**: `gh workflow view evals.yml` → prints the
workflow without a parse error.

### Step 6: Make the failure page somebody

A red tick is not an alarm. Add a job to `.github/workflows/evals.yml` that
runs after the eval job and posts to Slack when it did not succeed.

Target shape, following `cron-watchdog.yml`'s use of `SLACK_ALERT_WEBHOOK_URL`:

```yaml
  alert:
    needs: eval
    if: failure() && github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - name: Post to Slack
        env:
          SLACK_ALERT_WEBHOOK_URL: ${{ secrets.SLACK_ALERT_WEBHOOK_URL }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          # ... post a JSON body with a rotating-light emoji, the words
          # "the nightly evals FAILED", and $RUN_URL ...
```

Rules for this step, all load-bearing:

- **`if: failure() && github.event_name == 'schedule'`.** Only the scheduled run
  alerts. A human who typed `gh workflow run` is already watching, and an alert
  channel that cries on manual runs gets muted, which is how you end up back
  here.
- **Skip cleanly when the secret is absent.** If `SLACK_ALERT_WEBHOOK_URL` is
  empty, log one line and exit 0. A missing webhook must not turn into a second
  mystery failure.
- **Never echo the webhook URL.** It is a secret and this repo is public. Pass
  it via `env:` and reference `"$SLACK_ALERT_WEBHOOK_URL"` quoted; do not
  interpolate `${{ secrets.* }}` directly into a `run:` line, which bakes the
  value into the shell command. Use `curl --silent --show-error` and do not
  print the response body.
- **Never include an error object.** The message carries the run URL and
  nothing from the eval output. Whoever clicks the link can read the log.

**Verify (the guard rails hold)**:
```
node --input-type=module -e "
import {readFileSync} from 'node:fs';
const s = readFileSync('.github/workflows/evals.yml','utf8');
if (!/if: failure\(\) && github.event_name == 'schedule'/.test(s)) throw new Error('alert not gated to scheduled failures');
if (/\\\$\{\{ secrets.SLACK_ALERT_WEBHOOK_URL \}\}/.test(s.split('run: |')[1] ?? '')) throw new Error('secret interpolated into a run block');
console.log('ok');
"
```
→ prints `ok`.

### Step 7: Prove it locally before spending a CI run

```
BROKER_FAKE=true DRY_RUN=true TRADING212_ENV=demo \
  node --experimental-strip-types -e "
import('./agent/lib/t212.ts').then(async (m) => {
  const c = m.t212FromEnv();
  const cash = await c.getCash();
  const pos = await c.getPortfolio();
  console.log(JSON.stringify({ free: cash.free, positions: pos.length }));
});
"
```

**Verify**: prints the fake's free cash and position count, with no network
access and no credential set. Then:

```
BROKER_FAKE=true DRY_RUN=false node --experimental-strip-types -e "
import('./agent/lib/t212.ts').then((m) => { m.t212FromEnv(); })
  .then(() => { console.log('NO THROW'); process.exit(1); })
  .catch((e) => { console.log('threw:', e.message); });
"
```

**Verify**: prints `threw:` followed by a message mentioning `DRY_RUN`. If it
prints `NO THROW`, the interlock is not wired. STOP.

### Step 8: Run the real workflow

Commit and push the branch, then:

```
gh workflow run evals.yml --ref advisor/010-fix-and-surface-the-evals-workflow
gh run watch $(gh run list --workflow=evals.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

**Verify**, in order:

1. `gh run view <id> --log | grep -c "Trading 212 API error 401"` → **0**.
2. `gh run view <id> --log | grep "Results:"` → `Results: 7 passed, 0 failed (7 total)`.
3. `gh run view <id> --log | grep -c "PASSED VACUOUSLY"` → this is the number
   that tells you the fake actually helped. Record it and compare against the
   old run's count. Record both numbers in the commit body.
4. `gh run view <id>` → `eval` succeeded; the `alert` job is skipped (this is a
   `workflow_dispatch`, so `github.event_name == 'schedule'` is false).
5. `gh run download <id> --name eval-artifacts --dir /tmp/eval-art && ls /tmp/eval-art`
   → non-empty. The artifact upload is fixed.

If `buy-path-guards` still fails because the agent chose not to buy even with
cash available, that is a genuinely different problem from the 401 and is NOT
this plan. Record what you observed, note that the 401 is gone and the artifact
uploads, and STOP so a human can decide.

### Step 9: Prove the alert path fires

You must not ship an alarm you have never heard ring.

Temporarily, on your branch only, change the alert job's condition to
`if: failure()` (dropping the schedule clause) and add a step to the `eval` job
that exits 1 immediately after `pnpm install`, for example
`- run: exit 1  # TEMPORARY`. Push, run the workflow, and:

**Verify**:
- The `alert` job RAN (`gh run view <id>` shows it, not skipped).
- Its log does NOT contain the webhook URL, any `hooks.slack.com` host, or any
  masked-looking `***` beyond what GitHub adds for the secret itself. Check
  with `gh run view <id> --log | grep -i "hooks.slack\|webhook" ` → returns
  nothing but the step name.
- A message arrived in Slack. If you cannot see Slack, say so explicitly in
  your report rather than assuming.

Then REVERT both temporary edits and confirm:
```
git diff --stat
node --input-type=module -e "
import {readFileSync} from 'node:fs';
const s = readFileSync('.github/workflows/evals.yml','utf8');
if (/TEMPORARY/.test(s)) throw new Error('temporary edit still present');
if (!/github.event_name == 'schedule'/.test(s)) throw new Error('schedule gate not restored');
console.log('ok');
"
```
→ prints `ok`.

### Step 10: Mutation-check your own tests

This repo has shipped VACUOUS TESTS four times, and this plan is specifically
about an instrument that reported healthy while dead. Prove your tests bite.

For the interlock test (step 4, test 2), which is the one guarding real money:

1. Back up: `/bin/cp -f agent/lib/t212.ts /tmp/t212.bak`
2. Mutate: delete the `if (useFake && !isDryRun()) throw ...` block.
3. **Confirm the mutation actually landed**:
   `grep -n "isDryRun" agent/lib/t212.ts` and READ the output. It must no
   longer show the guard. `cp` is aliased to `cp -i` in this environment and
   has silently refused to overwrite before, producing a false green. Do not
   trust an unread `cp`. If the grep still shows the guard, the edit did not
   apply; fix that before continuing.
4. Run: `node --test --experimental-strip-types agent/lib/t212.test.ts`
   → the interlock test must go **RED**.
5. Restore: `/bin/cp -f /tmp/t212.bak agent/lib/t212.ts`
6. **Verify the restore landed**: `grep -n "isDryRun" agent/lib/t212.ts` shows
   the guard again, AND `git diff agent/lib/t212.ts` shows only your intended
   change, AND `pnpm test` passes. A silent no-op restore would turn an
   unrelated later failure into false proof that the test works.

Repeat the same three-part cycle (mutate, CONFIRM the mutation landed by
reading a grep, run) for one fake-broker test: change `FAKE_CASH.free` to `0`
in `agent/lib/t212-fake.ts` and confirm the `free > 0` assertion goes red, then
restore and re-verify.

**Verify**: you observed each test go red under its mutation and green after a
restore you confirmed by grep.

### Step 11: Document the flag

Add to `.env.example`, near the existing `DRY_RUN` line (`.env.example:9`),
matching that file's comment style:

```
# BROKER_FAKE=true      # CI ONLY. Serve canned Trading 212 responses from agent/lib/t212-fake.ts
                        # instead of calling the broker. REFUSED unless DRY_RUN=true. Never set
                        # this in production: it reports a balance that does not exist.
```

**Verify**: `grep -n "BROKER_FAKE" .env.example` → one match.
And `grep -rn "BROKER_FAKE" .vercel 2>/dev/null; vercel env ls 2>/dev/null | grep BROKER_FAKE`
→ no match in any production environment. If `BROKER_FAKE` is set anywhere on
Vercel, STOP and report immediately.

## Test plan

New tests, `node:test` + `node:assert/strict`, modelled on
`agent/lib/t212.test.ts` and its `fakeFetch` helper:

**`agent/lib/t212-fake.test.ts`** (new file):
1. `/equity/account/cash` returns a 200 whose body parses into a `CashBalance`
   with all finite fields and `free > 0`.
2. `/equity/portfolio` returns a 200 array of `T212Position`, tickers matching
   `/^[A-Z]+_US_EQ$/`.
3. An unrecognised path fails loudly (reject or non-ok status), so a tool that
   starts calling a new endpoint cannot silently receive `{}`.
4. Driven through a real `T212Client`, `getCash()` and `getPortfolio()` return
   the canned values, proving the fake speaks the client's wire format and not
   just a shape the test made up.

**`agent/lib/t212.test.ts`** (additions), env save/restore per
`agent/lib/risk-runtime.test.ts:20-29`:
5. Fake selected when `BROKER_FAKE=true` and `DRY_RUN=true`, with no credential set.
6. **Throws when `BROKER_FAKE=true` and `DRY_RUN=false`.** The interlock.
7. `TRADING212_ENV=live` cannot escape the fake.
8. `BROKER_FAKE` unset → unchanged real-client behaviour.
9. `BROKER_FAKE` unset and no credentials → the original error, unchanged.

Verification: `pnpm test` → exit 0, `ℹ fail 0`, nine more tests than the
plan-001 baseline.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0`, nine more tests than the plan-001 baseline
- [ ] `pnpm build` exits 0
- [ ] `grep -cE "TRADING212_API_KEY|TRADING212_SECRET_KEY|TRADING212_API_SECRET" .github/workflows/evals.yml` → `0`
- [ ] `grep -n "include-hidden-files: true" .github/workflows/evals.yml` → one match
- [ ] `grep -n "github.event_name == 'schedule'" .github/workflows/evals.yml` → one match
- [ ] `grep -n "BROKER_FAKE" .env.example` → one match
- [ ] A `gh workflow run evals.yml` on this branch ends `success`, with
      `Results: 7 passed, 0 failed (7 total)` and zero `Trading 212 API error 401`
- [ ] `gh run download <id> --name eval-artifacts` produces a non-empty directory
- [ ] You watched the alert job run and post (step 9), then reverted the temporary edits
- [ ] You observed the interlock test go RED under a mutation you confirmed by grep, and green after a restore you confirmed by grep
- [ ] `git status` shows only the in-scope files modified, and nothing under `evals/`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `node --version` is not 24.x, or `pnpm eval` prints `eve requires Node.js >=24`.
  Plan 001 is your dependency and it has not landed.
- The most recent `evals.yml` run already PASSED. The premise has changed.
- Making a step pass appears to require editing anything under `evals/`. Weakening
  an eval to make CI green is the exact failure mode this plan exists to end.
  The one legitimate exception: the harness rejects a fake-broker response shape.
  Fix `agent/lib/t212-fake.ts`, not the eval.
- You conclude the fake broker needs to serve an endpoint beyond
  `/equity/account/cash` and `/equity/portfolio`. Something calls the broker
  that this plan did not find, and that is worth a human look before you widen
  the fake.
- The interlock in step 7 does not throw with `DRY_RUN=false`.
- A mutation in step 10 does not turn its test red.
- You find `BROKER_FAKE` set in any Vercel environment.
- Anything would require you to create, read, rotate or print a credential
  value. You cannot provision Trading 212 demo keys; say so and stop.
- `buy-path-guards` still fails after the 401 is gone. That is a real finding
  about the agent's behaviour, not a CI bug, and it needs a human decision.

## Maintenance notes

- **The fake is now a load-bearing part of what CI proves.** If a tool starts
  calling a Trading 212 endpoint the fake does not serve, the evals will fail
  loudly rather than silently, which is deliberate. When that happens, the fix
  is a new canned response in `agent/lib/t212-fake.ts`, not a new secret.
- **A reviewer should scrutinise exactly one thing above all others**: that
  `BROKER_FAKE` cannot be reached with `DRY_RUN=false`. Everything else here is
  CI plumbing; that line is the only one that could touch real money.
- Six of the seven evals were green against a completely dead broker. Once the
  fake is in, watch the `PASSED VACUOUSLY` count in the nightly log. If it
  stays high, the conditional evals are still proving less than they appear to,
  and that is worth its own plan. Record the before and after counts (step 8.3)
  so the next person has a baseline.
- Deliberately deferred: provisioning real Trading 212 demo credentials. They
  would buy a more faithful integration test, at the cost of a live-adjacent
  credential in a public repo's nightly job and a suite whose timing is governed
  by a 1 req/5s broker rate limit. If someone wants that later, it is additive:
  a second workflow, gated on `workflow_dispatch`, not a change to this one.
- `.github/workflows/cron-watchdog.yml` and this workflow now both alert to
  `SLACK_ALERT_WEBHOOK_URL`. If a third arrives, factor the posting step into a
  composite action rather than copying the shell a third time.
