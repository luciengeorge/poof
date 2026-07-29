import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionResultCallId,
  actionResultName,
  externalGbpValuesFrom,
  isCycleTurnMessage,
  looksLikeReport,
  requestedActionNames,
  truthFrom,
} from "./cycle-trace.ts";

// --- naming an action result ---

test("names an authored tool result", () => {
  assert.equal(
    actionResultName({ kind: "tool-result", toolName: "submit_orders", callId: "c1", output: {} }),
    "submit_orders",
  );
});

test("names a subagent result by its subagent name, so red_team lands in the sequence", () => {
  assert.equal(
    actionResultName({ kind: "subagent-result", subagentName: "red_team", callId: "c1", output: {} }),
    "red_team",
  );
});

test("ignores a load-skill result, which is not part of the cycle discipline", () => {
  assert.equal(actionResultName({ kind: "load-skill-result", callId: "c1", output: {} }), null);
});

test("returns null for junk rather than throwing", () => {
  for (const junk of [null, undefined, 42, "submit_orders", {}, { toolName: 7 }]) {
    assert.equal(actionResultName(junk), null);
  }
});

// --- the idempotency key ---

test("reads the callId from a tool result and from a subagent result", () => {
  assert.equal(
    actionResultCallId({ kind: "tool-result", toolName: "submit_orders", callId: "call_7" }),
    "call_7",
  );
  assert.equal(
    actionResultCallId({ kind: "subagent-result", subagentName: "red_team", callId: "call_8" }),
    "call_8",
  );
});

test("a missing or non-string callId degrades to empty, never to a wrong key", () => {
  // Empty means "cannot deduplicate": the caller appends anyway rather than dropping a real
  // tool call, which would be a false invariant violation of a different kind.
  for (const junk of [null, undefined, 42, {}, { callId: 7 }, { callId: null }]) {
    assert.equal(actionResultCallId(junk), "");
  }
});

// --- the offline mirror: names from requested actions ---

test("collects tool and subagent requests in order, across steps", () => {
  const events = [
    { type: "turn.started", data: {} },
    {
      type: "actions.requested",
      data: {
        actions: [
          { kind: "tool-call", toolName: "get_earnings_calendar", input: {} },
          { kind: "subagent-call", subagentName: "red_team", input: {} },
        ],
      },
    },
    { type: "message.completed", data: { message: "thinking" } },
    {
      type: "actions.requested",
      data: { actions: [{ kind: "tool-call", toolName: "submit_orders", input: {} }] },
    },
  ];
  assert.deepEqual(requestedActionNames(events), [
    "get_earnings_calendar",
    "red_team",
    "submit_orders",
  ]);
});

test("ignores load-skill requests and malformed action lists", () => {
  const events = [
    { type: "actions.requested", data: { actions: [{ kind: "load-skill", input: {} }] } },
    { type: "actions.requested", data: { actions: "nope" } },
    { type: "actions.requested", data: {} },
    { type: "actions.requested" },
    { type: "session.completed" },
  ];
  assert.deepEqual(requestedActionNames(events), []);
});

test("the offline and online paths agree on the same cycle", () => {
  // Pins that both adapters feed checkInvariants the identical sequence, which is what makes
  // one invariant definition meaningful across CI and production.
  const names = ["manage_positions", "get_earnings_calendar", "red_team", "submit_orders"];
  const fromRequests = requestedActionNames([
    {
      type: "actions.requested",
      data: {
        actions: names.map((name) =>
          name === "red_team"
            ? { kind: "subagent-call", subagentName: name }
            : { kind: "tool-call", toolName: name },
        ),
      },
    },
  ]);
  const fromResults = names
    .map((name) =>
      actionResultName(
        name === "red_team"
          ? { kind: "subagent-result", subagentName: name }
          : { kind: "tool-result", toolName: name },
      ),
    )
    .filter((name): name is string => name !== null);
  assert.deepEqual(fromRequests, fromResults);
});

// --- ground truth from review_performance ---

test("reads the authoritative GBP figures from a review_performance result", () => {
  assert.deepEqual(
    truthFrom({ accountValueGbp: 248.16, cashGbp: 12.4, deployedGbp: 235.76, openPositions: [] }),
    { accountValueGbp: 248.16, cashGbp: 12.4, deployedGbp: 235.76 },
  );
});

test("returns null when the account value is missing or not a finite number", () => {
  assert.equal(truthFrom({ cashGbp: 1, deployedGbp: 2 }), null);
  assert.equal(truthFrom({ accountValueGbp: Number.NaN, cashGbp: 1, deployedGbp: 2 }), null);
  assert.equal(truthFrom({ accountValueGbp: "248.16" }), null);
  assert.equal(truthFrom(null), null);
});

test("a missing cash or deployed figure degrades to zero rather than losing the account value", () => {
  assert.deepEqual(truthFrom({ accountValueGbp: 248.16 }), {
    accountValueGbp: 248.16,
    cashGbp: 0,
    deployedGbp: 0,
  });
});

// --- allowed magnitudes from review_external_holdings ---

test("collects value, cost and P&L of each external holding as allowed magnitudes", () => {
  const output = {
    tradable: false,
    holdings: [
      { ticker: "SHOP", valueGbp: 7912.44, costBasisGbp: 9982.65, unrealisedPnlGbp: -2070.21 },
    ],
  };
  assert.deepEqual(externalGbpValuesFrom(output), [7912.44, 9982.65, -2070.21]);
});

test("skips holdings whose live quote was unavailable, and non-finite figures", () => {
  const output = {
    holdings: [
      { ticker: "SHOP", valueGbp: null, costBasisGbp: 9982.65, unrealisedPnlGbp: null },
      { ticker: "ABC", valueGbp: Number.NaN, costBasisGbp: 10 },
    ],
  };
  assert.deepEqual(externalGbpValuesFrom(output), [9982.65, 10]);
});

test("returns an empty list when there are no external holdings, or on junk", () => {
  assert.deepEqual(externalGbpValuesFrom({ holdings: [] }), []);
  assert.deepEqual(externalGbpValuesFrom({}), []);
  assert.deepEqual(externalGbpValuesFrom(null), []);
  assert.deepEqual(externalGbpValuesFrom({ holdings: "nope" }), []);
});

// --- which turns are cycles ---

test("recognises the scheduled cycle dispatch and the eval prompt", () => {
  assert.equal(
    isCycleTurnMessage(
      "Run one trading cycle now, following your instructions, and post the summary here.",
    ),
    true,
  );
  assert.equal(
    isCycleTurnMessage(
      "Run one trading cycle now, following your instructions, and post the summary.",
    ),
    true,
  );
});

test("recognises a human asking for a cycle in their own words", () => {
  assert.equal(isCycleTurnMessage("please run a trading cycle when you get a chance"), true);
  assert.equal(isCycleTurnMessage("RUN THE TRADING CYCLE"), true);
});

test("an ad-hoc question is NOT a cycle, so its trace is never asserted", () => {
  // This is what keeps cycle-recorded from firing a false alert on every Slack question.
  assert.equal(
    isCycleTurnMessage("Quick read only, what's your view on AAPL here? Do NOT place any trade."),
    false,
  );
  assert.equal(isCycleTurnMessage("hey"), false);
  assert.equal(isCycleTurnMessage(""), false);
});

test("isCycleTurnMessage tolerates a non-string message", () => {
  assert.equal(isCycleTurnMessage(undefined), false);
  assert.equal(isCycleTurnMessage(null), false);
});

// --- which assistant messages are the report ---

test("a message carrying a GBP figure is a report candidate", () => {
  assert.equal(looksLikeReport("Bottom line: your account is worth **£248.16** today."), true);
});

test("interim narration with no money in it is not a report candidate", () => {
  assert.equal(looksLikeReport("Let me check the news first."), false);
  assert.equal(looksLikeReport("Bought 0.4 shares of Exxon at $173.79."), false);
  assert.equal(looksLikeReport(null), false);
});
