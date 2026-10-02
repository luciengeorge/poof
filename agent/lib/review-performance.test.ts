import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toolSrc = readFileSync(new URL("../tools/review_performance.ts", import.meta.url), "utf8");
const convexSrc = readFileSync(new URL("../../convex/memory.ts", import.meta.url), "utf8");
const facadeSrc = readFileSync(new URL("./memory.ts", import.meta.url), "utf8");

function closedBuyStatuses(): string[] {
  const decl = convexSrc.match(/const CLOSED_BUY_STATUSES = \[([^\]]*)\]/);
  assert.ok(decl, "convex/memory.ts must declare CLOSED_BUY_STATUSES");
  return [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function closedBuysHandler(): string {
  const start = convexSrc.indexOf("export const closedBuys = query(");
  assert.ok(start > 0, "convex/memory.ts must export the closedBuys query");
  // Comments stripped: the handler's own comment explains why it avoids .collect().
  return convexSrc.slice(start, convexSrc.indexOf("\n});", start)).replace(/\/\/.*$/gm, "");
}

test("review_performance measures the whole closed record (structural)", () => {
  // The pure modules downstream (realizedStats, attributeFailures, calibrationFrom) are all
  // tested on fixtures they are handed, so every one of them stays green while the tool feeds
  // them a 50-row window of mixed BUYs, SELLs, skips and dry-runs. The sample is only visible
  // here, in the tool's source, so it is asserted here.
  assert.ok(toolSrc.includes("memory.closedBuys("), "the tool must read the closed record");
  // The bug was a recency window standing in for a record; these two tokens are its fingerprint.
  assert.doesNotMatch(toolSrc, /recallRecent/);
  assert.doesNotMatch(toolSrc, /tradeLimit/);
  assert.doesNotMatch(toolSrc, /\.trades/, "closedTrades must not come from a mixed `.trades` field");

  // closedTrades must be the closedBuys result, not merely sit in a file that also calls it. The
  // fetch is one positional Promise.all, so match each bound name to the call in its slot.
  const fetch = [...toolSrc.matchAll(/const \[([^\]]+)\] = await Promise\.all\(\[([\s\S]*?)\]\);/g)].find(
    (m) => m[2].includes("memory.closedBuys("),
  );
  assert.ok(fetch, "closedBuys must be read in a destructured Promise.all");
  const names = fetch[1].split(",").map((s) => s.trim());
  const calls = [...fetch[2].matchAll(/memory\.(\w+)\(/g)].map((m) => m[1]);
  assert.equal(names.length, calls.length);
  const bound = names[calls.indexOf("closedBuys")];
  assert.ok(bound, "closedBuys must be one of the fetched reads");
  assert.match(toolSrc, new RegExp(`const closedTrades = \\(${bound} \\?\\? \\[\\]\\)`));
});

test("closedBuys reads every closed status from the index, bounded (structural)", () => {
  // Returning only "closed" would silently zero realizedStats' closedEstimated and closedUnknown
  // counts, the exact class of bug outcomeKind (agent/lib/positions.ts) was written to end.
  const statuses = closedBuyStatuses();
  for (const s of ["closed", "closed-estimated", "closed-unknown"]) {
    assert.ok(statuses.includes(s), `CLOSED_BUY_STATUSES must include "${s}"`);
  }
  const handler = closedBuysHandler();
  assert.match(handler, /for \(const status of CLOSED_BUY_STATUSES\)/);
  assert.match(handler, /withIndex\("by_env_side_status"/);
  assert.match(handler, /\.eq\("env", args\.env\)\.eq\("side", "BUY"\)\.eq\("status", status\)/);
  assert.match(handler, /\.take\(/, "a growing table must be read with a bound");
  assert.doesNotMatch(handler, /\.collect\(\)/);
});

test("closedBuys returns every status closeTrade can write (structural)", () => {
  // trades.status is a bare string, so nothing ties the statuses the writer books to the ones
  // this reader asks the index for. A fourth closed status added to closeTrade alone would vanish
  // from every figure review_performance reports, and nothing would say so.
  const sig = facadeSrc.match(/closeTrade\(args: \{[\s\S]*?status\?: ([^;]+);/);
  assert.ok(sig, "the facade's closeTrade must type its status");
  const written = [...sig[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(written.length > 0);
  assert.deepEqual([...closedBuyStatuses()].sort(), [...written].sort());
});
