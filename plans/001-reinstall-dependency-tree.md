# Plan 001: Make a green local test run mean something again

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- package.json pnpm-lock.yaml .nvmrc`
> If any of those changed since this plan was written, compare the "Current
> state" figures against the live files before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED (mechanically trivial; the risk is that it surfaces real failures that were hidden)
- **Depends on**: none, **this plan blocks every other plan**
- **Category**: dx
- **Planned at**: commit `0859c96`, 2026-09-30

## Why this matters

The `node_modules` on this machine is not the tree the lockfile describes, and
not the tree CI or Vercel builds. Installed `ai` is `7.0.0-beta.178` while the
lockfile and `package.json` both say `7.0.28`. The installed version does not
even satisfy the declared `^7.0.28` range. Installed `typescript` is `7.0.1-rc`
against a declared `^7.0.2`. Local Node was `v22.22.0` against
`engines.node: 24.x`, `.nvmrc: 24`, and CI's `node-version: 24`.

So `pnpm test` passing locally is currently a statement about a beta AI SDK, a
release-candidate compiler, and the wrong Node major. It is not evidence about
what ships. Every other plan in this directory ends with "run the tests", so
this one has to land first or all of those gates are measuring the wrong thing.

This repo has been burned by this class of false evidence before: a documented
incident where `node --test` prints `# tests N` on Node 22 and `ℹ tests N` on
Node 24, so a pinned grep silently matched nothing and a broken run looked clean.

## Current state

Verified on 2026-09-30:

```
$ node -p "require('./node_modules/ai/package.json').version"
7.0.0-beta.178
$ grep -A2 "^  ai@" pnpm-lock.yaml   # lockfile resolution
version: 7.0.28(zod@4.4.3)
$ node -p "require('./node_modules/typescript/package.json').version"
7.0.1-rc
$ node -v
v22.22.0
$ cat .nvmrc
24
```

`package.json` (relevant lines):

```json
"engines": { "node": "24.x" },
"dependencies": { "ai": "^7.0.28", "convex": "^1.42.0", "eve": "^0.22.1", ... },
"devDependencies": { "typescript": "^7.0.2", "@types/node": "24.x" },
"overrides":   { "ai": "^7.0.28" },
"resolutions": { "ai": "^7.0.28" }
```

`.github/workflows/ci.yml` uses `node-version: 24` and
`pnpm install --frozen-lockfile`, so CI already runs the correct tree.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Select Node | `nvm use` (reads `.nvmrc`) | prints `Now using node v24.x.x` |
| Install | `pnpm install --frozen-lockfile` | exit 0, no `ERR_PNPM_OUTDATED_LOCKFILE` |
| Typecheck | `pnpm typecheck` | exit 0, no output |
| Convex typecheck | `npx tsc -p convex/tsconfig.json` | exit 0, no output |
| Tests | `pnpm test` | exit 0, `ℹ pass 647`, `ℹ fail 0` |
| Build | `pnpm build` | exit 0, ends `built output at .../.output` |

Note the test-count prefix is `ℹ` on Node 24 and `#` on Node 22. If you see `#`,
you are on the wrong Node and step 1 did not take effect.

## Scope

**In scope:**
- `node_modules/` (regenerated, not edited; it is gitignored)
- Only if step 3 fails: the minimum source change needed to make the real tree
  pass, in whichever file the failure points at.

**Out of scope** (do NOT touch, even though they look related):
- `package.json` version ranges. Do **not** "fix" the drift by loosening a range
  to match what happens to be installed. The lockfile is the source of truth.
- `pnpm-lock.yaml`. Do not regenerate it. `--frozen-lockfile` must succeed as-is;
  if it cannot, that is a STOP condition.
- The `eve` version. It is deliberately left at 0.22.1; see
  "Findings considered and rejected" in `plans/README.md`.
- The `overrides` / `resolutions` double-pin on `ai`. It may be redundant, but
  removing it is a separate question and not worth coupling to this.

## Git workflow

- Branch: `advisor/001-reinstall-dependency-tree`
- Only commit if step 3 required a source change. A reinstall alone touches no
  tracked file and needs no commit.
- Commit message style, matching `git log`: conventional commits with a body
  explaining *why*, e.g. `fix(deps): ...`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Switch to the Node the repo declares

```
nvm use
node -v
```

**Verify**: `node -v` prints `v24.` followed by anything. If `nvm` is not
available, install Node 24 by whatever means this machine uses, but do not
proceed on Node 22.

### Step 2: Install the tree the lockfile describes

```
pnpm install --frozen-lockfile
```

**Verify**: exit 0. Then confirm the drift is gone:

```
node -p "require('./node_modules/ai/package.json').version"          # expect 7.0.28
node -p "require('./node_modules/typescript/package.json').version"  # expect 7.0.2
```

Both must match. If `ai` still reports a `-beta.` version, the install did not
take; delete `node_modules` and retry once.

### Step 3: Re-run every gate on the real tree and record what changed

```
pnpm typecheck
npx tsc -p convex/tsconfig.json
pnpm test
pnpm build
```

**Verify**: all four exit 0, and `pnpm test` reports `ℹ pass 647` / `ℹ fail 0`.

This step is the actual point of the plan. If something now fails that passed
before, that failure is **real and already live in CI and production**. It was
merely invisible locally. Fix it if the fix is small and obviously correct
(a type that moved, a renamed export). If it is not small and obviously correct,
STOP and report with the full error; do not paper over it.

### Step 4: Record the true baseline

Append one line to the bottom of `plans/README.md` under a new
`## Verified baseline` heading, stating the date, the Node version, and the test
count observed on the correct tree. Later plans compare against this number, so
it needs to exist somewhere durable.

**Verify**: `grep -A3 "Verified baseline" plans/README.md` shows your line.

## Test plan

No new tests. This plan's entire purpose is to make the *existing* 647 tests
mean what they claim. The test plan is step 3.

## Done criteria

ALL must hold:

- [ ] `node -v` reports v24.x
- [ ] `node -p "require('./node_modules/ai/package.json').version"` prints `7.0.28`
- [ ] `node -p "require('./node_modules/typescript/package.json').version"` prints `7.0.2`
- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0`
- [ ] `pnpm build` exits 0
- [ ] `git status` shows no modified tracked files, unless step 3 required a fix
- [ ] `plans/README.md` has a `## Verified baseline` line and this plan's status row is updated

## STOP conditions

Stop and report back (do not improvise) if:

- `pnpm install --frozen-lockfile` fails with a lockfile-out-of-date error. That
  means `package.json` and `pnpm-lock.yaml` genuinely disagree, which is a
  separate problem and must not be solved by regenerating the lockfile here.
- Step 3 produces a failure that is not small and obviously correct to fix.
  Report the full error text. Do not disable a test, loosen a type, or add a
  cast to make it pass.
- The installed versions after step 2 still do not match the lockfile after one
  clean retry.
- You find yourself wanting to edit `package.json` for any reason.

## Maintenance notes

- Whoever reviews this should check that no version range in `package.json`
  moved. The whole point is to conform the tree to the manifest, not the reverse.
- If step 3 surfaced failures, those are the interesting part of the review, not
  the reinstall.
- Worth considering afterwards, deliberately left out of scope: CI does not
  currently fail if a developer's local tree drifts, because CI always installs
  clean. A `preinstall` engine check (`"engines": {"node": "24.x"}` plus
  `engine-strict=true` in `.npmrc`) would catch the Node half of this at the
  point of installing rather than months later. That is a one-line change but it
  affects everyone's workflow, so it belongs to its own decision.
