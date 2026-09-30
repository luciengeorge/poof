# Plan 014: Collapse the duplicated Jev news screener into one definition

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report, do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 0859c96..HEAD -- agent/lib/funnel.ts agent/lib/jev-shadow.ts agent/lib/funnel.test.ts agent/lib/jev-shadow.test.ts agent/lib/funnel-score.ts`
> If any of these changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch, treat
> it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-reinstall-dependency-tree.md (so the test run is evidence)
- **Category**: tech-debt
- **Planned at**: commit `0859c96`, 2026-09-30

## Why this matters

poof is an autonomous agent trading a real Trading 212 account. Two separate
code paths ask an external forecasting model (Jev) the same three questions
about a news headline, and both write the answers into a field called
`freshCatalyst`. The question text is currently character-for-character
identical in both, so today the two numbers really are comparable.

Nothing enforces that. No test asserts the prompt strings. The two copies sit
in different files, 700 lines apart, and neither carries a comment saying the
other exists. Reword one question and the two paths start grading on different
scales while still sharing a field name, a consumer, and a database column.

The consumers do treat them as one thing. `agent/lib/funnel-score.ts:63` ranks
the day's shortlist on `clamp(s.freshCatalyst) * (1 - clamp(s.pricedIn)) * ...`,
`agent/tools/get_funnel.ts:48` surfaces it, and `agent/tools/get_news.ts`
annotates headlines with the other path's version of the same number. The
agent's own instructions (`agent/instructions.md:18`) tell it to use
`freshCatalyst` to decide what to read first. And `convex/schema.ts:383` stores
it: `freshCatalyst: v.number()`. A silent reword would not just change today's
ranking, it would permanently mix two scales in one persisted column with
nothing in the data to tell them apart.

This is a small, boring change. It is worth doing because the failure mode is
silent, the blast radius is what the agent reads first, and the fix is an
afternoon.

## Current state

**All of the following was diffed on disk at `0859c96`, not assumed.**

### `strategyCriteria()` is byte-for-byte identical in two files

`agent/lib/funnel.ts:66-78` and `agent/lib/jev-shadow.ts:86-98`. Extracting
both with `awk '/^function strategyCriteria/,/^}/'` and running `diff` produces
no output. Here is the text, once:

```ts
function strategyCriteria(): Record<string, string> {
  const described: Record<string, string> = {
    "news-catalyst": "A specific, fresh, company-level event: contract, approval, guidance, product, legal outcome.",
    "earnings-play": "Positioning around a scheduled earnings report.",
    momentum: "A trend or breakout continuing, without a new discrete event.",
    "mean-reversion": "An overdone move expected to snap back.",
    "index-event": "Index inclusion, rebalancing, or a passive-flow event.",
    other: "None of the above, or not actionable.",
  };
  const criteria: Record<string, string> = {};
  for (const tag of STRATEGY_TAGS) criteria[tag] = described[tag] ?? tag;
  return criteria;
}
```

The copy in `jev-shadow.ts` carries a doc comment the funnel copy does not
(`agent/lib/jev-shadow.ts:85`):
```ts
/** The fixed taxonomy from positions.ts, so Jev's bucket and the agent's tag are the same words. */
```
Keep that comment on the extracted version.

Both files import `STRATEGY_TAGS` from `./positions.ts` (`funnel.ts:6`,
`jev-shadow.ts:4`) and **use it nowhere else**. After extraction both imports
are orphaned and must be deleted.

### The three question specs are character-identical

`agent/lib/funnel.ts:91-105` and `agent/lib/jev-shadow.ts:110-124`. `diff` on
those two 15-line ranges produces no output. The shared text:

```ts
      freshCatalyst: {
        type: "noul",
        instructions:
          "Is this a fresh, specific, company-level catalyst that could move the named stock, rather than general commentary, a recap, or macro news?",
      },
      pricedIn: {
        type: "noul",
        instructions:
          "Has the market most likely already repriced for this information (widely reported, hours old, or a reaction already described)?",
      },
      strategyTag: {
        type: "choice",
        instructions: "Which trading strategy bucket does this news best fit?",
        criteria: strategyCriteria(),
      },
```

### Where the two screeners differ

Exactly two places.

**1. The state object.** `diff` of `funnel.ts:84-90` against
`jev-shadow.ts:103-109` yields precisely:

```
1d0
<       ticker,
5a5
>       tickers: item.related,
```

Funnel (`agent/lib/funnel.ts:83-90`):
```ts
    {
      ticker,
      headline: item.headline,
      summary: item.summary,
      source: item.source,
      publishedAt: new Date(item.datetime * 1000).toISOString(),
    },
```

Shadow (`agent/lib/jev-shadow.ts:102-109`):
```ts
    {
      headline: item.headline,
      summary: item.summary,
      source: item.source,
      publishedAt: new Date(item.datetime * 1000).toISOString(),
      tickers: item.related,
    },
```

The funnel knows which ticker it is asking about (it iterates the universe);
the shadow screens a news item that may name several, so it passes
`item.related`. This difference is real and must be preserved.

**2. The funnel asks a fourth question.** `agent/lib/funnel.ts:106-109`:

```ts
      higherIn10d: {
        type: "noul",
        instructions: `Will ${ticker} close higher in ${FUNNEL_OUTCOME_TRADING_DAYS} trading days than it closes today?`,
      },
```

This one interpolates `ticker` and `FUNNEL_OUTCOME_TRADING_DAYS`
(`agent/lib/funnel.ts:38`, value `10`), so it is funnel-only by construction.
The funnel header comment (`agent/lib/funnel.ts:24-29`) explains it: it is a
directional shadow forecast, scored ten trading days later against the real
price, and it influences nothing.

### The two result types

`agent/lib/funnel.ts:55-62`:
```ts
export interface FunnelScreen {
  freshCatalyst: number;
  pricedIn: number;
  strategyTag: string;
  strategyTagConfidence: number;
  higherIn10d: number;
  model: string;
}
```

`agent/lib/jev-shadow.ts:73-81`:
```ts
export interface JevScreen {
  /** Probability this is a fresh, stock-specific catalyst rather than commentary or old news. */
  freshCatalyst: number;
  /** Probability the market has already repriced for it. */
  pricedIn: number;
  strategyTag: string;
  strategyTagConfidence: number;
  model: string;
}
```

Five shared fields, plus `higherIn10d` on the funnel. The two doc comments live
only on `JevScreen`; keep them on the shared type.

The mapping from the Jev response is also duplicated. `funnel.ts:112-119` and
`jev-shadow.ts:127-134` both do:
```ts
    freshCatalyst: res.answers.freshCatalyst.noul,
    pricedIn: res.answers.pricedIn.noul,
    strategyTag: res.answers.strategyTag.choice,
    strategyTagConfidence: res.answers.strategyTag.confidence,
    model: res.model,
```
with the funnel adding `higherIn10d: res.answers.higherIn10d.noul,`.

### The two entry points

Funnel (`agent/lib/funnel.ts:80-120`):
```ts
/** One Jev call per item: the three screening questions plus the directional shadow. */
export async function screenFunnelItem(jev: JevClient, ticker: string, item: NewsItem): Promise<FunnelScreen> {
```
Exported. Called from `runFunnelChunk` at `agent/lib/funnel.ts:198`.

Shadow (`agent/lib/jev-shadow.ts:100-135`):
```ts
async function screenOne(jev: JevClient, item: NewsItem): Promise<JevScreen | undefined> {
```
NOT exported. Called only from `screenNews` (`agent/lib/jev-shadow.ts:139-158`),
which is exported and used by `agent/tools/get_news.ts`. Note the declared
return type includes `| undefined`, but the function body has no path that
returns `undefined`; `screenNews` handles the failure case with its own
`try/catch`. Leave that signature alone unless step 3 forces a change, and say
so if it does.

### Conventions

- Pure, unit-tested functions; IO at the edges. Comments explain WHY, at
  length, and are not written on every line.
- No em-dashes.
- **NEVER use TypeScript parameter properties** (`constructor(private readonly x)`).
  `--experimental-strip-types` cannot erase them and the test file dies with a
  bare "test failed".
- Tests: `node:test` + `node:assert/strict`, plain object fixtures, no mocking
  framework. Both `agent/lib/funnel.test.ts` (its `fakeJev` at line 37) and
  `agent/lib/jev-shadow.test.ts` (its `fakeJev` at line 25) record the
  `questions` argument the client was called with. Read both before writing
  anything: recording the questions is exactly the hook the drift test needs.
- This repo already has a precedent for a test that reads source text to assert
  a STRUCTURAL property that unit tests cannot see. `agent/lib/funnel.test.ts:295-309`:
  ```ts
  test("nothing between claiming a chunk and the try that can mark it failed (structural)", () => {
    // A throw after the claim but outside the try leaves the chunk at `started` for ever, so the
    // ordering here is the whole point: unit tests cannot see it.
    const src = readFileSync(new URL("./funnel-schedule.ts", import.meta.url), "utf8");
  ```
  Step 4 uses the same technique.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck (app) | `pnpm typecheck` | exit 0 |
| Typecheck (convex) | `npx tsc -p convex/tsconfig.json` | exit 0 |
| Funnel tests | `node --test --experimental-strip-types agent/lib/funnel.test.ts` | all pass |
| Shadow tests | `node --test --experimental-strip-types agent/lib/jev-shadow.test.ts` | all pass |
| Full suite | `pnpm test` | exit 0, `ℹ fail 0` |
| Build | `pnpm build` | exit 0 |

Node must be 24.x. `pnpm test` prints `ℹ pass N` / `ℹ fail N` on Node 24; Node
22 prints `# pass N`. If you see the `#` form you are on the wrong Node and
plan 001 has not landed. STOP.

## Scope

**In scope:**
- `agent/lib/jev-screen.ts` (create), the one definition
- `agent/lib/jev-screen.test.ts` (create), the drift tests
- `agent/lib/funnel.ts`, remove the duplicate, import the shared spec
- `agent/lib/jev-shadow.ts`, remove the duplicate, import the shared spec
- `agent/lib/funnel.test.ts`, only if an existing test breaks
- `agent/lib/jev-shadow.test.ts`, only if an existing test breaks
- `plans/README.md`, status row

**Out of scope** (do NOT touch, even though they look related):
- **Any question's wording.** This is a pure extraction. If a single character
  of any `instructions` string changes, the two paths' historical
  `freshCatalyst` values stop being comparable with the new ones, and
  `convex/schema.ts:383` already holds months of the old scale. Reword nothing.
- **The `strategyCriteria` descriptions**, for the same reason: they are part
  of the prompt.
- `FUNNEL_OUTCOME_TRADING_DAYS`, `FUNNEL_TAG_WEIGHT`,
  `FUNNEL_RECENCY_HALF_LIFE_HOURS`, or any scoring constant in
  `agent/lib/funnel-score.ts`. Ranking behaviour must be unchanged.
- **The state-object difference.** Funnel passes `ticker`, shadow passes
  `tickers: item.related`. Do NOT unify them. They are asking about different
  things and the shadow genuinely does not know a single ticker.
- `convex/schema.ts`, `convex/memory.ts`, `agent/lib/memory.ts`. No stored
  shape changes.
- `agent/tools/get_news.ts`, `agent/tools/get_funnel.ts`, `agent/instructions.md`.
  No caller changes: `screenFunnelItem` and `screenNews` keep their exact
  signatures.
- The `JevScreen | undefined` return type on `screenOne`. Odd, but not this
  plan's business.
- The shadow-confidence path (`shadowState`, `SHADOW_INSTRUCTIONS`,
  `agent/lib/jev-shadow.ts:25-71`). It is a different question and is not
  duplicated.

## Git workflow

- Branch: `advisor/014-collapse-duplicate-jev-screener`
- One commit. Conventional commits, imperative subject, body explaining the
  mechanism. Recent examples from `git log`: `feat(jev): shadow confidence and
  news screening, measured before trusted`, `fix(funnel): the universe never
  reached the deployed bundle`. Suggested subject:
  `refactor(jev): one definition of the news screening questions`
  with a body saying that two byte-identical copies could have diverged
  silently while sharing a field name, a ranking consumer and a database
  column, and that the new test fails if they ever do.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Prove the duplication before you remove it

Record the evidence, so the commit body is a fact rather than a claim.

```
cd "$(git rev-parse --show-toplevel)"
awk '/^function strategyCriteria/,/^}/' agent/lib/funnel.ts > /tmp/sc-funnel.txt
awk '/^function strategyCriteria/,/^}/' agent/lib/jev-shadow.ts > /tmp/sc-shadow.txt
diff /tmp/sc-funnel.txt /tmp/sc-shadow.txt && echo "strategyCriteria IDENTICAL"
diff <(sed -n '91,105p' agent/lib/funnel.ts) <(sed -n '110,124p' agent/lib/jev-shadow.ts) && echo "QUESTIONS IDENTICAL"
```

**Verify**: both `diff`s print nothing and both `echo`s fire. If either `diff`
prints a hunk, the files have drifted since this plan was written. STOP and
report the hunk: the drift itself is now the finding, and this plan's design
needs a human decision before you collapse anything.

### Step 2: Create the single definition

Create `agent/lib/jev-screen.ts`. It owns: the shared result type, the three
question specs, `strategyCriteria`, and the shared part of the response
mapping. Target shape:

```ts
import type { JevQuestion, JevResponse } from "./jev.ts";
import { STRATEGY_TAGS } from "./positions.ts";

/**
 * ONE definition of the three news-screening questions, and the shape of their
 * answers.
 *
 * WHY THIS MODULE EXISTS. Two paths screen news with Jev: the wide funnel
 * (agent/lib/funnel.ts), which reads the whole universe before the cycle, and
 * the get_news annotation (agent/lib/jev-shadow.ts), which annotates whatever
 * the agent looks up. They were byte-identical copies in two files 700 lines
 * apart, and both write a field called `freshCatalyst`. That field is ranked on
 * by agent/lib/funnel-score.ts, surfaced by get_funnel and get_news, read by
 * the agent's own instructions to decide what to read FIRST, and persisted as
 * `freshCatalyst: v.number()` in convex/schema.ts. Rewording one copy would
 * have left the two grading on different scales under one name, in one column,
 * with nothing in the data to tell them apart, and no test would have noticed.
 *
 * The question text is a MEASUREMENT INSTRUMENT. Changing a word here changes
 * every number downstream and makes new rows incomparable with the stored
 * history. Change it deliberately, not in passing.
 */

/** The fixed taxonomy from positions.ts, so Jev's bucket and the agent's tag are the same words. */
export function strategyCriteria(): Record<string, string> {
  /* moved verbatim from funnel.ts:66-78 */
}

/**
 * The three shared questions. A caller that needs more spreads this and adds
 * its own, so the shared three can never drift between callers.
 */
export const NEWS_SCREEN_QUESTIONS = {
  freshCatalyst: { /* verbatim */ },
  pricedIn: { /* verbatim */ },
  strategyTag: { /* verbatim */ },
} as const satisfies Record<string, JevQuestion>;

export interface JevScreen {
  /** Probability this is a fresh, stock-specific catalyst rather than commentary or old news. */
  freshCatalyst: number;
  /** Probability the market has already repriced for it. */
  pricedIn: number;
  strategyTag: string;
  strategyTagConfidence: number;
  model: string;
}

/** Read the three shared answers out of a Jev response. */
export function readNewsScreen(res: /* the JevResponse shape */): JevScreen {
  /* moved verbatim from jev-shadow.ts:127-134 */
}
```

Two implementation notes:

- `strategyCriteria()` is called once per question-spec construction today. If
  you make `NEWS_SCREEN_QUESTIONS` a module-level `const`, `strategyCriteria()`
  runs once at import instead of once per item. That is fine and slightly
  cheaper: `STRATEGY_TAGS` is a frozen literal array
  (`agent/lib/positions.ts:15-24`) and the result is never mutated. If you
  prefer to keep it a function call per item, a `newsScreenQuestions()` builder
  is equally acceptable; pick one and be consistent.
- Getting `readNewsScreen`'s parameter type right against `JevResponse<Q>`'s
  generics may be fiddly. If it turns into a fight with the type system, it is
  acceptable to keep the five-line mapping inline in both callers and share
  only the type, the criteria and the questions. Say so in your report if you
  take that route; the questions are the part that matters.

Do NOT copy anything by retyping. Move the text so it is impossible to
introduce a character change.

**Verify**: `pnpm typecheck` → exit 0.
Then prove the move was literal:
```
diff <(sed -n '91,105p' agent/lib/funnel.ts) <(git show 0859c96:agent/lib/funnel.ts | sed -n '91,105p') && echo "funnel questions untouched so far"
grep -c "Is this a fresh, specific, company-level catalyst" agent/lib/jev-screen.ts
```
→ the `grep -c` prints `1`.

### Step 3: Point both callers at it

**`agent/lib/jev-shadow.ts`**:
- Delete `strategyCriteria` (lines 85-98) and its doc comment.
- Delete the `JevScreen` interface (lines 73-81).
- Re-export the type so `ScreenedNewsItem` and any importer keep working:
  `export type { JevScreen } from "./jev-screen.ts";` (check whether anything
  outside this file imports `JevScreen`: `grep -rn "JevScreen" agent/ convex/`).
- In `screenOne`, replace the inline questions object with
  `NEWS_SCREEN_QUESTIONS` and the inline return mapping with
  `readNewsScreen(res)`. The state object keeps `tickers: item.related`.
- **Remove the now-orphaned `import { STRATEGY_TAGS } from "./positions.ts";`**
  at line 4. It is used nowhere else in that file.

**`agent/lib/funnel.ts`**:
- Delete `strategyCriteria` (lines 66-78).
- Replace `FunnelScreen` with the intersection:
  ```ts
  /** The shared three, plus the funnel's own directional shadow. */
  export type FunnelScreen = JevScreen & { higherIn10d: number };
  ```
- In `screenFunnelItem`, spread the shared questions and add the fourth:
  ```ts
      {
        ...NEWS_SCREEN_QUESTIONS,
        higherIn10d: {
          type: "noul",
          instructions: `Will ${ticker} close higher in ${FUNNEL_OUTCOME_TRADING_DAYS} trading days than it closes today?`,
        },
      },
  ```
  The state object keeps `ticker,`.
- Replace the return mapping with
  `{ ...readNewsScreen(res), higherIn10d: res.answers.higherIn10d.noul }`.
- **Remove the now-orphaned `import { STRATEGY_TAGS } from "./positions.ts";`**
  at line 6. It is used nowhere else in that file. (`agent/lib/funnel-score.ts`
  imports it separately at its own line 1; leave that alone.)

**Verify**:
```
pnpm typecheck
grep -c "function strategyCriteria" agent/lib/funnel.ts agent/lib/jev-shadow.ts
grep -n "STRATEGY_TAGS" agent/lib/funnel.ts agent/lib/jev-shadow.ts
node --test --experimental-strip-types agent/lib/funnel.test.ts
node --test --experimental-strip-types agent/lib/jev-shadow.test.ts
```
→ typecheck exit 0; both `grep -c` print `0`; the `STRATEGY_TAGS` grep returns
NOTHING (both orphaned imports gone); both test files pass with no edits. If an
existing test fails, read it before touching it: a test asserting the old
question text is asserting the right thing and your extraction changed a
character. Fix the extraction, not the test.

### Step 4: Write the test that catches the next divergence

This is the valuable part of the plan. Silent divergence is the actual hazard,
so the test must fail if it ever happens again. Create
`agent/lib/jev-screen.test.ts` with two layers, because either alone is
defeatable.

**Layer 1, behavioural.** Both screeners must send the same three question
objects. Use a `fakeJev` that records the `questions` argument, modelled on
`agent/lib/funnel.test.ts:37-50` and `agent/lib/jev-shadow.test.ts:25-40`.
`screenOne` is not exported, so drive it through the exported `screenNews`.

```ts
test("the funnel and the get_news annotation ask Jev the SAME three questions", async () => {
  // The hazard this pins: both paths write a field called `freshCatalyst`, ranked on by
  // funnel-score.ts and persisted in convex/schema.ts. If one path's prompt is reworded the two
  // silently grade on different scales under one name, and nothing in the data says so.
  const a = fakeJev();
  await screenFunnelItem(a.client, "AAPL", item);
  const b = fakeJev();
  await screenNews(b.client, [item]);

  const shared = ["freshCatalyst", "pricedIn", "strategyTag"] as const;
  for (const key of shared) {
    assert.deepEqual(a.asked[key], b.asked[key], `question "${key}" differs between the two screeners`);
  }
  // And the funnel's ONLY extra question is its directional shadow.
  assert.deepEqual(
    Object.keys(a.asked).filter((k) => !(shared as readonly string[]).includes(k)),
    ["higherIn10d"],
  );
  assert.deepEqual(Object.keys(b.asked).sort(), [...shared].sort());
});
```

Also assert that the two STATE objects still differ in the documented way, so a
future "tidy-up" cannot quietly unify them:

```ts
test("the funnel asks about one ticker; the annotation asks about the item's related tickers", async () => {
  // ... assert a.state.ticker === "AAPL" and a.state.tickers === undefined
  // ... assert b.state.tickers === item.related and b.state.ticker === undefined
});
```

**Layer 2, structural.** Layer 1 passes trivially while both read the same
constant. It does NOT catch someone re-inlining a copy in one file, which is
exactly how this arose. Follow the precedent at
`agent/lib/funnel.test.ts:295-309`:

```ts
test("neither screener carries its own copy of the shared question text (structural)", () => {
  // Unit tests cannot see a re-inlined duplicate: a second copy of the prompt would pass every
  // behavioural assertion on the day it was written and drift later. So assert on the source.
  const fingerprints = [
    "Is this a fresh, specific, company-level catalyst",
    "Has the market most likely already repriced",
    "Which trading strategy bucket does this news best fit",
    "A specific, fresh, company-level event: contract",
  ];
  for (const file of ["./funnel.ts", "./jev-shadow.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const f of fingerprints) {
      assert.ok(!src.includes(f), `${file} re-inlines shared prompt text: "${f}"`);
    }
  }
  const shared = readFileSync(new URL("./jev-screen.ts", import.meta.url), "utf8");
  for (const f of fingerprints) {
    assert.ok(shared.includes(f), `jev-screen.ts is missing "${f}"`);
  }
});
```

Import `readFileSync` from `node:fs`, as `agent/lib/funnel.test.ts` does.

**Verify**: `node --test --experimental-strip-types agent/lib/jev-screen.test.ts`
→ all pass.

### Step 5: Confirm nothing else moved

**Verify**:
```
pnpm test
pnpm typecheck
npx tsc -p convex/tsconfig.json
pnpm build
```
→ `pnpm test` exits 0 with `ℹ fail 0`; the other three exit 0.

Then prove the prompt text is byte-identical to what shipped, which is the
whole safety property of this refactor:

```
for s in \
  "Is this a fresh, specific, company-level catalyst that could move the named stock, rather than general commentary, a recap, or macro news?" \
  "Has the market most likely already repriced for this information (widely reported, hours old, or a reaction already described)?" \
  "Which trading strategy bucket does this news best fit?" \
  "A specific, fresh, company-level event: contract, approval, guidance, product, legal outcome." \
  "Positioning around a scheduled earnings report." \
  "A trend or breakout continuing, without a new discrete event." \
  "An overdone move expected to snap back." \
  "Index inclusion, rebalancing, or a passive-flow event." \
  "None of the above, or not actionable."
do
  grep -qF -- "$s" agent/lib/jev-screen.ts || echo "MISSING: $s"
done
echo "prompt check done"
```
→ prints only `prompt check done`. Any `MISSING:` line means a character
changed during the move. Fix it before going further; a reworded prompt is the
one outcome this plan must not produce.

### Step 6: Mutation-check your own tests

This repo has shipped VACUOUS TESTS four times. The step-4 tests are the entire
point of this plan, so prove they bite. Three mutations, and for each one
CONFIRM the mutation landed before trusting the red.

**Mutation A, divergence (the hazard the plan exists for):**

1. Back up: `/bin/cp -f agent/lib/funnel.ts /tmp/funnel.bak`
2. Mutate: in `screenFunnelItem`, stop spreading `NEWS_SCREEN_QUESTIONS` for
   one question. Inline a reworded `freshCatalyst` spec after the spread, for
   example `instructions: "Is this fresh news?"`, so the spread's version is
   overridden.
3. **Confirm the mutation actually landed**: run
   `grep -n "Is this fresh news" agent/lib/funnel.ts` and READ the output. It
   must show your line. `cp` is aliased to `cp -i` in this environment and has
   silently refused to overwrite before, producing a false green. Never trust
   an unread copy or an unread edit.
4. Run `node --test --experimental-strip-types agent/lib/jev-screen.test.ts`
   → layer 1's "SAME three questions" test AND layer 2's structural test must
   BOTH go **RED**. If only one does, say which in your report.
5. Restore: `/bin/cp -f /tmp/funnel.bak agent/lib/funnel.ts`
6. **Verify the restore landed**: `grep -c "Is this fresh news" agent/lib/funnel.ts`
   → `0`, AND `git diff agent/lib/funnel.ts` shows only your intended change,
   AND `pnpm test` passes. A silent no-op restore turns an unrelated later
   failure into false proof that the test works.

**Mutation B, the funnel's fourth question:**

Same six-part cycle on `agent/lib/funnel.ts`: delete the `higherIn10d` question
from `screenFunnelItem`. Confirm with `grep -c "higherIn10d" agent/lib/funnel.ts`
before running. The "only extra question is higherIn10d" assertion must go red.

**Mutation C, the state objects:**

Same cycle: change the funnel's state object to pass `tickers: item.related`
instead of `ticker`. Confirm with `grep -n "item.related" agent/lib/funnel.ts`
before running. The state-object test must go red.

**Verify**: you observed each test go red under its mutation, having read a
grep confirming the mutation landed, and green after each restore.

## Test plan

New file `agent/lib/jev-screen.test.ts`, modelled on the `fakeJev` helpers at
`agent/lib/funnel.test.ts:37` and `agent/lib/jev-shadow.test.ts:25`, and on the
structural test at `agent/lib/funnel.test.ts:295`:

1. **The drift test** (behavioural): the three shared question objects sent by
   `screenFunnelItem` and by `screenNews` are `deepEqual`.
2. **The funnel's extra question is exactly one, named `higherIn10d`**, and the
   annotation path sends only the three.
3. **The state objects keep their documented difference**: funnel sends
   `ticker`, annotation sends `tickers`, neither sends both.
4. **No re-inlined copy** (structural): neither `funnel.ts` nor `jev-shadow.ts`
   contains any of four prompt fingerprints, and `jev-screen.ts` contains all
   four.
5. **`strategyCriteria()` covers the whole taxonomy**: every member of
   `STRATEGY_TAGS` is a key, and no key falls back to the bare tag name (the
   `?? tag` branch in the implementation would silently produce a useless
   criterion if someone added a tag to `positions.ts` without a description
   here). This one is new coverage the duplicated version never had.
6. **`FunnelScreen` is assignable to `JevScreen`**: a compile-time assertion
   such as `const _check: JevScreen = {} as FunnelScreen;` in the test file,
   which fails `pnpm typecheck` if the intersection is ever broken. That is the
   type-level half of "these two numbers are comparable".

Existing tests in `agent/lib/funnel.test.ts` and `agent/lib/jev-shadow.test.ts`
should pass **unchanged**. If one does not, the extraction was not literal.

Verification: `pnpm test` → exit 0, `ℹ fail 0`, six more tests than the
plan-001 baseline.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `npx tsc -p convex/tsconfig.json` exits 0
- [ ] `pnpm test` exits 0 with `ℹ fail 0`, six more tests than the plan-001 baseline
- [ ] `pnpm build` exits 0
- [ ] `grep -c "function strategyCriteria" agent/lib/funnel.ts agent/lib/jev-shadow.ts` → `0` for both
- [ ] `grep -n "STRATEGY_TAGS" agent/lib/funnel.ts agent/lib/jev-shadow.ts` → no matches (both orphaned imports removed)
- [ ] `grep -c "Is this a fresh, specific, company-level catalyst" agent/lib/funnel.ts agent/lib/jev-shadow.ts` → `0` for both, and `1` for `agent/lib/jev-screen.ts`
- [ ] The step-5 prompt-fingerprint loop prints only `prompt check done`
- [ ] `grep -n "higherIn10d" agent/lib/funnel.ts` still shows the fourth question and its mapping
- [ ] `grep -n "tickers: item.related" agent/lib/jev-shadow.ts` still matches, and `grep -n "^      ticker,$" agent/lib/funnel.ts` still matches
- [ ] `git diff 0859c96..HEAD -- agent/lib/funnel-score.ts convex/schema.ts agent/tools/` is empty
- [ ] Existing tests in `funnel.test.ts` and `jev-shadow.test.ts` are unmodified (`git diff --stat` shows them untouched), or you explained in the commit body exactly why one had to change
- [ ] You observed all three mutations (A, B, C) turn their test red, each confirmed by a grep you read, and green after restore
- [ ] `git status` shows only the in-scope files
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's `diff` shows the two copies are ALREADY different. The premise of
  this plan is that they are identical today. If they have drifted, the right
  move is a human deciding which wording is correct, not you picking one.
- `pnpm test` prints `# pass N` rather than `ℹ pass N`. You are on Node 22 and
  plan 001 has not landed.
- Any excerpt in "Current state" does not match the live file.
- An existing test in `funnel.test.ts` or `jev-shadow.test.ts` fails and it is
  not obviously a consequence of a character you changed by accident.
- You find you need to change a question's wording to make anything compile or
  pass. You do not, and doing so would make every new `freshCatalyst` value
  incomparable with the ones already in `convex` under the same column name.
- A mutation in step 6 does not turn its test red.
- `grep -rn "JevScreen\|FunnelScreen" agent/ convex/` turns up an importer
  outside `funnel.ts`, `jev-shadow.ts`, their tests, and `agent/lib/memory.ts`.
  A consumer this plan did not account for deserves a look before you change
  the type.
- The `readNewsScreen` generics fight back hard enough that you are tempted to
  reach for `any` or a cast. Fall back to sharing only the type, the criteria
  and the questions (step 2 permits this), and say so.

## Maintenance notes

- **`agent/lib/jev-screen.ts` is now a measurement instrument, not just code.**
  Every word in `NEWS_SCREEN_QUESTIONS` and `strategyCriteria` feeds a number
  that is ranked on, shown to the agent, and stored in Convex. Changing a word
  is a data-schema change in everything but name: rows before and after are not
  comparable and nothing in the table distinguishes them. If a reword is ever
  actually wanted, it needs a version marker stored beside the score, which is
  its own plan.
- A reviewer should check exactly two things: that the diff moved text rather
  than retyping it (the step-5 fingerprint loop is the evidence), and that both
  orphaned `STRATEGY_TAGS` imports are gone rather than left dangling.
- The structural test in step 4 layer 2 is deliberately brittle: it will fail if
  someone legitimately rewords a prompt. That is the intent. The failure message
  names the file and the string, so the fix is obvious, and the failure forces
  the reword to be a decision instead of an accident.
- Deliberately not done here, and worth its own look later: `screenOne`'s
  declared return type is `Promise<JevScreen | undefined>` although no code path
  returns `undefined`; `screenNews` handles failure with its own `try/catch`
  instead. Tidying that is a one-line change with no behavioural effect, but it
  is a different concern and bundling it would muddy this diff.
- If a third Jev screening path ever appears, it should import
  `NEWS_SCREEN_QUESTIONS` and add its own extra questions by spreading, exactly
  as the funnel now does. The structural test will catch it if it does not.
