import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionResultCallId,
  actionResultName,
  exitsFrom,
  externalGbpValuesFrom,
  externalHoldingsFrom,
  isCycleTurnMessage,
  looksLikeReport,
  MAX_TRACE_EXITS,
  MAX_TRACE_HOLDINGS,
  MAX_TRACE_ORDERS,
  MAX_TRACE_POSITIONS,
  ordersFrom,
  positionsFrom,
  postTradeTruthFrom,
  quotesFrom,
  requestedActionNames,
  resultOrders,
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

// --- the POST-TRADE snapshot from record_cycle ---
//
// record_cycle runs LAST and does its own fresh broker fetch, so it is the only figure that
// describes the account after the day's orders. review_performance runs EARLY, which is why its
// cash figure made a correct report look like a misstatement.

test("reads the post-trade equity and cash record_cycle actually recorded", () => {
  assert.deepEqual(
    postTradeTruthFrom({
      recorded: true,
      fx: { rate: 1.34, source: "live", fallbackUsed: false },
      accountValueGbp: 148.05,
      cashGbp: 114.99,
    }),
    { accountValueGbp: 148.05, cashGbp: 114.99 },
  );
});

test("a record_cycle that failed carries no snapshot, and must not invent one", () => {
  // The tool swallows broker/memory failures and returns {recorded:false}: there is no fresh
  // snapshot in that case, so the pre-trade figures stay the best available truth.
  assert.equal(postTradeTruthFrom({ recorded: false, note: "memory or broker unavailable" }), null);
  assert.equal(postTradeTruthFrom({ recorded: true, fx: { rate: 1.34 } }), null);
  assert.equal(postTradeTruthFrom({ accountValueGbp: Number.NaN, cashGbp: "114.99" }), null);
  assert.equal(postTradeTruthFrom(null), null);
});

test("a partial snapshot keeps the half it has", () => {
  assert.deepEqual(postTradeTruthFrom({ recorded: true, cashGbp: 114.99 }), {
    cashGbp: 114.99,
  });
});

// --- orders, from the submit_orders result ---

const SUBMIT_RESULT = {
  placed: [
    {
      proposal: {
        ticker: "AMZN_US_EQ",
        side: "BUY",
        notional: 15,
        price: 231.4,
        thesis: "cloud demand",
        strategyTag: "momentum",
      },
      quantity: 0.048,
      dryRun: false,
    },
    {
      proposal: { ticker: "SHOP_US_EQ", side: "BUY", notional: 20, price: 118, thesis: "advice" },
      quantity: 0,
      dryRun: false,
      skipped: "held in the external advisory account",
    },
    {
      proposal: { ticker: "KO_US_EQ", side: "BUY", notional: 15, price: 71.2, thesis: "defensive" },
      quantity: 0.21,
      dryRun: true,
    },
  ],
  rejected: [
    {
      proposal: { ticker: "XOM_US_EQ", side: "BUY", notional: 5000, price: 173, thesis: "big" },
      reason: "exceeds max position size",
    },
  ],
};

test("records every order the cycle placed, simulated, skipped and had rejected", () => {
  const captured = ordersFrom(SUBMIT_RESULT);
  assert.equal(captured?.truncated, false);
  assert.deepEqual(captured?.orders, [
    {
      ticker: "AMZN_US_EQ",
      side: "BUY",
      notionalGbp: 15,
      status: "placed",
      strategyTag: "momentum",
    },
    {
      ticker: "SHOP_US_EQ",
      side: "BUY",
      notionalGbp: 20,
      status: "skipped",
      detail: "held in the external advisory account",
    },
    { ticker: "KO_US_EQ", side: "BUY", notionalGbp: 15, status: "simulated" },
    {
      ticker: "XOM_US_EQ",
      side: "BUY",
      notionalGbp: 5000,
      status: "rejected",
      detail: "exceeds max position size",
    },
  ]);
});

test("a cycle that submitted nothing records an EMPTY order list, not an absent one", () => {
  // Captured-and-empty means "no orders happened", which the judge can adjudicate. Absent means
  // "nothing was recorded", which it cannot. Collapsing the two would make a report claiming an
  // order look either always fine or always invented.
  assert.deepEqual(ordersFrom({ placed: [], rejected: [] }), { orders: [], truncated: false });
  assert.equal(ordersFrom({}), null);
  assert.equal(ordersFrom(null), null);
  assert.equal(ordersFrom({ placed: "nope", rejected: 7 }), null);
});

test("orders are bounded, and truncation is marked rather than silently dropping them", () => {
  const many = {
    placed: Array.from({ length: MAX_TRACE_ORDERS + 5 }, (_v, i) => ({
      proposal: { ticker: `T${i}_US_EQ`, side: "BUY", notional: 1, price: 1, thesis: "x" },
      quantity: 1,
      dryRun: false,
    })),
    rejected: [],
  };
  const captured = ordersFrom(many);
  assert.equal(captured?.orders.length, MAX_TRACE_ORDERS);
  assert.equal(captured?.truncated, true);
});

// --- exits, from the manage_positions result ---

test("records the exits the exit engine triggered, with the reason", () => {
  const captured = exitsFrom({
    exitsTriggered: [
      {
        ticker: "CVS_US_EQ",
        reason: "trailing-stop",
        pnlPct: -0.081,
        marketValue: 14.2,
        detail: "trailing stop: 8.1% below peak $79.10",
      },
    ],
    placed: [],
    rejected: [],
    dryRun: false,
    note: "1 exit(s)",
  });
  assert.equal(captured?.truncated, false);
  assert.deepEqual(captured?.exits, [
    {
      ticker: "CVS_US_EQ",
      reason: "trailing-stop",
      detail: "trailing stop: 8.1% below peak $79.10",
    },
  ]);
});

test("a cycle with no exit conditions met records an EMPTY exit list", () => {
  assert.deepEqual(exitsFrom({ exitsTriggered: [], placed: [], rejected: [] }), {
    exits: [],
    truncated: false,
  });
  assert.equal(exitsFrom({}), null);
  assert.equal(exitsFrom(null), null);
});

test("exits are bounded, and truncation is marked", () => {
  const captured = exitsFrom({
    exitsTriggered: Array.from({ length: MAX_TRACE_EXITS + 3 }, (_v, i) => ({
      ticker: `T${i}_US_EQ`,
      reason: "max-hold",
    })),
  });
  assert.equal(captured?.exits.length, MAX_TRACE_EXITS);
  assert.equal(captured?.truncated, true);
});

// --- the held position list, from the review_performance result ---

test("records the held tickers and the full position count", () => {
  assert.deepEqual(
    positionsFrom({
      accountValueGbp: 148.2,
      openPositions: [{ ticker: "AMZN_US_EQ" }, { ticker: "KO_US_EQ" }],
    }),
    { tickers: ["AMZN_US_EQ", "KO_US_EQ"], count: 2, truncated: false },
  );
  assert.deepEqual(positionsFrom({ openPositions: [] }), {
    tickers: [],
    count: 0,
    truncated: false,
  });
  assert.equal(positionsFrom({}), null);
  assert.equal(positionsFrom(null), null);
});

test("a malformed position row does not inflate the count", () => {
  // An inflated count could convict a report that correctly said "10 stocks", which is the exact
  // opposite of what this capture is for. Only readable rows are counted.
  assert.deepEqual(
    positionsFrom({
      openPositions: [{ ticker: "AMZN_US_EQ" }, null, { ticker: "" }, 42, { marketValue: 12 }],
    }),
    { tickers: ["AMZN_US_EQ"], count: 1, truncated: false },
  );
});

test("the position list is bounded but the COUNT stays exact, so a stated count is checkable", () => {
  const captured = positionsFrom({
    openPositions: Array.from({ length: MAX_TRACE_POSITIONS + 7 }, (_v, i) => ({
      ticker: `T${i}_US_EQ`,
    })),
  });
  assert.equal(captured?.tickers.length, MAX_TRACE_POSITIONS);
  assert.equal(captured?.count, MAX_TRACE_POSITIONS + 7);
  assert.equal(captured?.truncated, true);
});

// --- quoted prices, from the get_prices results ---

test("records a compact ticker-to-price map from a get_prices result", () => {
  assert.deepEqual(
    quotesFrom({
      quotes: [
        { symbol: "AMZN", price: 231.4, prevClose: 229, changePct: 1.05 },
        { symbol: "KO", price: 71.2, prevClose: 69.5, changePct: 2.45 },
      ],
      failures: [{ symbol: "NKE", error: "rate limited" }],
    }),
    { AMZN: 231.4, KO: 71.2 },
  );
});

test("quotesFrom skips unusable rows and tolerates junk", () => {
  assert.deepEqual(
    quotesFrom({
      quotes: [
        { symbol: "AMZN", price: Number.NaN },
        { symbol: "", price: 10 },
        { symbol: "KO", price: "71.2" },
        { symbol: "SBUX", price: 96.4 },
      ],
    }),
    { SBUX: 96.4 },
  );
  assert.deepEqual(quotesFrom({}), {});
  assert.deepEqual(quotesFrom(null), {});
});

// --- external holdings, LABELLED for the judge ---

test("records each external holding's value, cost and P&L under NAMED fields", () => {
  // Defect (C): the judge was given the bare magnitude allow-list and read it as a checklist of
  // figures the report owed the reader. Labels make it reference context instead.
  const output = {
    tradable: false,
    holdings: [
      {
        ticker: "SHOP",
        valueGbp: 7629.26,
        costBasisGbp: 9982.65,
        unrealisedPnlGbp: -2353.39,
        priceInstrumentCcy: 118.4,
      },
    ],
  };
  assert.deepEqual(externalHoldingsFrom(output), {
    holdings: [
      {
        ticker: "SHOP",
        currentValueGbp: 7629.26,
        costBasisGbp: 9982.65,
        unrealisedPnlGbp: -2353.39,
      },
    ],
    truncated: false,
  });
  // The BARE array the deterministic magnitude rule consumes is unchanged: both come off the
  // same tool result, and neither replaces the other.
  assert.deepEqual(externalGbpValuesFrom(output), [7629.26, 9982.65, -2353.39]);
});

test("a holding whose quote failed keeps its ticker and cost, without inventing a value", () => {
  assert.deepEqual(
    externalHoldingsFrom({
      holdings: [{ ticker: "SHOP", valueGbp: null, costBasisGbp: 9982.65, unrealisedPnlGbp: null }],
    }),
    { holdings: [{ ticker: "SHOP", costBasisGbp: 9982.65 }], truncated: false },
  );
});

test("external holdings are bounded, and truncation is marked", () => {
  const captured = externalHoldingsFrom({
    holdings: Array.from({ length: MAX_TRACE_HOLDINGS + 2 }, (_v, i) => ({
      ticker: `T${i}`,
      valueGbp: 1,
    })),
  });
  assert.equal(captured.holdings.length, MAX_TRACE_HOLDINGS);
  assert.equal(captured.truncated, true);
});

test("externalHoldingsFrom tolerates junk and an empty account", () => {
  assert.deepEqual(externalHoldingsFrom({ holdings: [] }), { holdings: [], truncated: false });
  assert.deepEqual(externalHoldingsFrom(null), { holdings: [], truncated: false });
  assert.deepEqual(externalHoldingsFrom({ holdings: "nope" }), {
    holdings: [],
    truncated: false,
  });
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

// --- resultOrders: the OFFLINE mirror of the accumulated orders ---
//
// This is what lets `no-duplicate-orders` be graded in CI as well as in production. The event
// shape asserted here is the one the production hook already relies on (`action.result` carrying
// `{toolName, output}`), so both surfaces read the same thing.

/** One `action.result` event for a submit_orders call, in eve's shape. */
const submitResult = (placed: unknown[], rejected: unknown[] = []) => ({
  type: "action.result",
  data: {
    result: {
      kind: "tool-result",
      toolName: "submit_orders",
      callId: "c1",
      output: { placed, rejected },
    },
  },
});

test("resultOrders accumulates orders across SEVERAL submit_orders results", () => {
  // The live shape that exposed the overwrite bug: one submit, then a second 33 seconds later.
  const events = [
    submitResult([{ proposal: { ticker: "OXY_US_EQ", side: "SELL", notional: 8 } }]),
    submitResult([
      { proposal: { ticker: "COP_US_EQ", side: "SELL", notional: 8 } },
      { proposal: { ticker: "LNG_US_EQ", side: "SELL", notional: 7 } },
    ]),
  ];
  const observed = resultOrders(events);
  assert.ok(observed);
  assert.deepEqual(
    observed.orders.map((o) => o.ticker),
    ["OXY_US_EQ", "COP_US_EQ", "LNG_US_EQ"],
  );
  assert.equal(observed.truncated, false);
});

test("resultOrders returns null when no submit_orders result was observed", () => {
  // UNKNOWN, never "no orders": the invariant must report not-applicable rather than pass.
  assert.equal(resultOrders([{ type: "actions.requested", data: { actions: [] } }]), null);
});

test("resultOrders returns null when a submit result carries no readable order list", () => {
  const events = [
    {
      type: "action.result",
      data: { result: { kind: "tool-result", toolName: "submit_orders", output: {} } },
    },
  ];
  assert.equal(resultOrders(events), null);
});

test("resultOrders ignores results from other tools", () => {
  const events = [
    {
      type: "action.result",
      data: {
        result: {
          kind: "tool-result",
          toolName: "manage_positions",
          output: { placed: [{ proposal: { ticker: "KO_US_EQ", side: "SELL" } }], rejected: [] },
        },
      },
    },
  ];
  assert.equal(resultOrders(events), null);
});

test("resultOrders carries the status through, so a rejection is not read as a send", () => {
  const events = [
    submitResult(
      [{ proposal: { ticker: "OXY_US_EQ", side: "SELL", notional: 8 } }],
      [
        {
          proposal: { ticker: "OXY_US_EQ", side: "SELL", notional: 30 },
          reason: "below minimum position",
        },
      ],
    ),
  ];
  const observed = resultOrders(events);
  assert.ok(observed);
  assert.deepEqual(
    observed.orders.map((o) => o.status).sort(),
    ["placed", "rejected"],
  );
});
