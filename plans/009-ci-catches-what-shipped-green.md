# Plan 009: Make CI catch the two outages that shipped green

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- .github/workflows/ci.yml package.json tsconfig.json convex/tsconfig.json`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live files before proceeding; on a mismatch, treat it
> as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (a new CI gate that is wrong blocks all work; a new gate that is weak is theatre)
- **Depends on**: plans/001-reinstall-dependency-tree.md
- **Category**: dx
- **Planned at**: commit `0859c96`, 2026-09-30

## Why this matters

Two production outages in one fortnight, both invisible to a fully green CI run:

**The funnel threw `ENOENT` on every production fire for 13 days.**
`agent/lib/universe.ts` read a JSON data file with
`readFileSync(new URL("../data/universe.json", import.meta.url))`. The deploy
bundler collapses the app into `/var/task/index.mjs`, so that resolved to
`/var/data/universe.json`, which was never traced into the bundle. `pnpm test`
and `pnpm build` both passed the whole time, because the file exists locally and
nothing asserted it survives bundling.

**A non-optional field was added to a populated Convex table and failed the
production deploy outright.** `pnpm typecheck` passed, because `tsc` is a
type-level check with no knowledge of stored rows. The comment recording that
incident is still in `convex/schema.ts` around line 22.

CI today runs install, typecheck, test, build. None of those four can catch
either failure. This plan adds the cheapest gates that would have.

There is a third, related gap worth knowing while you work: `convex/` is not in
the root `tsconfig.json` include, so `npx tsc -p convex/tsconfig.json` (the
stricter config production actually deploys with) never runs in CI at all.

## Current state

`.github/workflows/ci.yml`, the whole check job as of `0859c96`:

```yaml
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24 # eve requires Node >=24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Typecheck
        run: pnpm run typecheck
      - name: Test
        run: pnpm test
      - name: Build
        run: pnpm run build
```

`vercel.json` shows how production deploys Convex:

```json
"buildCommand": "if [ \"$VERCEL_ENV\" = \"production\" ]; then npx convex deploy --cmd 'pnpm build'; else pnpm build; fi"
```

The universe is now a TypeScript module (`agent/data/universe.ts`) imported by
`agent/lib/universe.ts`, so the specific ENOENT is designed out. Nothing stops
its reintroduction, and nothing checks the bundle generally.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `pnpm typecheck` | exit 0 |
| Convex typecheck | `npx tsc -p convex/tsconfig.json` | exit 0 |
| Convex schema vs stored rows | `npx convex deploy --dry-run` | exit 0; needs a deploy key |
| Build | `pnpm build` | exit 0, output in `.output/` |
| Tests | `pnpm test` | exit 0, `ℹ fail 0` |

## Scope

**In scope:**
- `.github/workflows/ci.yml`, new steps
- `package.json`, new scripts if a step is worth naming
- A post-build smoke script (suggested: `scripts/smoke-build.mjs`)

**Out of scope** (do NOT touch, even though they look related):
- `.github/workflows/evals.yml`. It is failing 10/10 and that is plan 010.
- `.github/workflows/cron-watchdog.yml` and `pullfrog.yml`.
- `vercel.json`. The deploy command is correct; CI is what is missing.
- Adding a linter or formatter. Recorded in `plans/README.md` as considered
  and rejected: no rule set would have caught any bug in this audit.
- Any source file under `agent/` or `convex/`.

## Git workflow

- Branch: `advisor/009-ci-catches-what-shipped-green`
- Commit per gate added, so a gate that turns out to be noisy can be reverted
  alone. Conventional commits.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Typecheck Convex with the config production uses

Add a CI step running `npx tsc -p convex/tsconfig.json`.

Run it locally first. If it currently fails, **STOP and report**, that means
production is deploying code that does not typecheck under its own config, and
fixing that is a separate piece of work, not something to bundle into a CI
change.

**Verify**: `npx tsc -p convex/tsconfig.json` → exit 0 locally, and the new
step present in `ci.yml`.

### Step 2: Post-build smoke test on the real bundle

Write a script that runs **after** `pnpm build` and asserts the built output
actually contains what production needs. At minimum it must fail if the
universe data is missing from the bundle, because that is the exact outage.

Two workable shapes, pick one and say why in a comment:

- **Grep the output**: assert `.output/` contains a known ticker string and
  contains no reference to a runtime data-file read. Cheap, crude, effective.
  The verified command that distinguishes fixed from broken is
  `grep -rl '"NVDA"' .output/server/` finding a match.
- **Import the built artifact** and call into it. Stronger, but the bundle is
  a Nitro server build and may not import cleanly in isolation. Try it; if it
  does not work within a reasonable attempt, fall back to the grep and say so.

Whichever you choose, the script must **fail loudly with a useful message**,
not just exit non-zero.

**Verify**: run it against the current build → passes. Then temporarily break
it (rename the export it checks for, or point it at a string that is not
there), rebuild, and confirm it FAILS. A smoke test you have not seen fail is
not a smoke test.

### Step 3: Validate the Convex schema against stored rows

Add a CI step running `npx convex deploy --dry-run -y`. This is the only check
that validates the schema against **existing data**, which is what `tsc` cannot
do and what broke a production deploy before.

**The `-y` matters.** Without it the command prompts for target confirmation
and aborts in a non-interactive terminal, which looks like the check not
working. Verified on 2026-09-30, the full run prints:

```
Pushing code to your Convex deployment...
Schema validation complete.
✔ Would have deployed Convex functions to https://...
```

It contacts production and validates against real documents, then stops before
writing. "Would have deployed" is the confirmation that nothing was written.

This needs a deploy key with at least preview access, exposed as a repository
secret. **Do not** put any secret value in the workflow file or in this plan;
reference the secret by name only, following how `cron-watchdog.yml` already
does it.

If no suitable deploy key exists, **STOP and report** rather than committing a
step that will fail for everyone. Note in your report that this is the single
highest-value gate of the three, so it is worth the operator provisioning a key.

**Verify**: the step is present and, if a key is available, passes on a branch.

### Step 4: Keep CI honest about its own runtime

Confirm `ci.yml` still pins `node-version: 24`, matching `engines.node` and
`.nvmrc`. If plan 001 added an engine-strict setting, make sure CI is
consistent with it.

**Verify**: `grep -n "node-version" .github/workflows/ci.yml` → 24.

## Test plan

CI changes are verified by running them, not by unit tests. The one piece of
real code here is the smoke script from step 2, and its test is step 2's
own requirement: you must observe it fail against a deliberately broken build
before you trust it.

If the smoke script grows past trivial, give it a unit test alongside the
others in `agent/lib/`. If it stays a twenty-line grep, do not.

## Done criteria

ALL must hold:

- [ ] `.github/workflows/ci.yml` runs the convex tsconfig typecheck
- [ ] `.github/workflows/ci.yml` runs a post-build smoke step
- [ ] `.github/workflows/ci.yml` runs `npx convex deploy --dry-run`, OR the
      report explains precisely why it cannot yet and what is needed
- [ ] You observed the smoke script FAIL against a deliberately broken build
- [ ] `npx tsc -p convex/tsconfig.json` exits 0 locally
- [ ] `pnpm test` still exits 0 with `ℹ fail 0`
- [ ] No secret value appears in any workflow file or in this plan's changes
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `npx tsc -p convex/tsconfig.json` fails on the current tree (step 1).
- No Convex deploy key is available for CI (step 3). Report what is needed.
- The smoke script cannot be made to fail against a broken build. A gate you
  cannot see fail is worse than no gate, because it manufactures confidence.
- Adding a step makes CI materially slower (say, more than doubling it).
  Report the timing rather than silently accepting it.
- You find yourself wanting to add a linter. That was considered and rejected;
  see `plans/README.md`.

## Maintenance notes

- The point of this plan is not three specific commands. It is that **every
  incident in this codebase's recent history was invisible to a green CI run**,
  and four separate measurement systems were broken simultaneously while all
  reporting healthy. When adding any future check, the question to ask is "what
  would this have caught?" and if the answer is "nothing that has ever
  happened", it is probably not worth the run time.
- The `convex deploy --dry-run` gate is the most valuable and the most likely to
  be skipped for want of a key. Push for it.
- A reviewer should confirm the smoke test actually asserts something about the
  **built output**, not about the source tree. It is easy to write one that
  passes by reading files the bundler never touched, which would recreate the
  original bug in test form.
