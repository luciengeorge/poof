import assert from "node:assert/strict";
import test from "node:test";

import type { NewsItem } from "./data.ts";
import type { JevClient, JevQuestion, JevResponse } from "./jev.ts";
import { JEV_SCREEN_MAX_ITEMS, screenNews, shadowConfidence, shadowState } from "./jev-shadow.ts";
import type { Proposal } from "./orders.ts";

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    ticker: "NVDA_US_EQ",
    side: "BUY",
    notional: 50,
    price: 100,
    thesis: "Guidance raised.",
    strategyTag: "news-catalyst",
    confidence: 0.6,
    stopLossPct: 0.08,
    trailingStopPct: 0.08,
    ...over,
  };
}

/** A fake that answers every question with fixed values and records what it was asked. */
function fakeJev(opts: { fail?: boolean; noul?: number; choice?: string } = {}) {
  const asked: { state: unknown; ids: string[] }[] = [];
  const client: JevClient = {
    async ask(state, questions) {
      asked.push({ state, ids: Object.keys(questions) });
      if (opts.fail) throw new Error("boom");
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries(questions as Record<string, JevQuestion>)) {
        if (q.type === "noul") answers[id] = { type: "noul", noul: opts.noul ?? 0.66 };
        else {
          const options = Object.keys(q.criteria);
          const choice = opts.choice ?? options[0];
          const probabilities: Record<string, number> = {};
          for (const o of options) probabilities[o] = o === choice ? 0.8 : 0.2 / (options.length - 1);
          answers[id] = { type: "choice", choice, probabilities, confidence: 0.75 };
        }
      }
      return { model: "jev-1.13.0", answers, usage: { input_tokens: 1, output_tokens: 1 } } as JevResponse<
        typeof questions
      >;
    },
  };
  return { client, asked };
}

const quiet = { warn: () => {} };

test("shadow state shows only what the agent knew at entry, never the account or the outcome", () => {
  const s = shadowState(proposal({ redTeamVerdict: "keep" }));
  assert.deepEqual(Object.keys(s).sort(), ["exitRules", "redTeamVerdict", "side", "strategyTag", "thesis", "ticker"]);
  assert.equal(JSON.stringify(s).includes("notional"), false);
  assert.equal(JSON.stringify(s).includes("confidence"), false);
});

test("shadow confidence records Jev's probability and the model version that gave it", async () => {
  const { client, asked } = fakeJev({ noul: 0.42 });
  const out = await shadowConfidence(client, proposal(), quiet);
  assert.deepEqual(out, { jevConfidence: 0.42, jevModel: "jev-1.13.0" });
  assert.deepEqual(asked[0]?.ids, ["profitable"]);
});

test("a Jev failure leaves the shadow absent and never throws into the order path", async () => {
  const { client } = fakeJev({ fail: true });
  assert.equal(await shadowConfidence(client, proposal(), quiet), undefined);
});

function news(i: number): NewsItem {
  return {
    headline: `Headline ${i}`,
    summary: "s",
    source: "src",
    url: `https://x/${i}`,
    datetime: 1_700_000_000 + i,
    related: "NVDA",
  };
}

test("screening annotates each item with the three questions and keeps the item intact", async () => {
  const { client, asked } = fakeJev({ noul: 0.9, choice: "news-catalyst" });
  const out = await screenNews(client, [news(1), news(2)], quiet);
  assert.equal(out.length, 2);
  assert.equal(out[0]?.headline, "Headline 1");
  assert.equal(out[0]?.jevScreen?.freshCatalyst, 0.9);
  assert.equal(out[0]?.jevScreen?.strategyTag, "news-catalyst");
  assert.deepEqual(asked[0]?.ids.sort(), ["freshCatalyst", "pricedIn", "strategyTag"]);
});

test("a failed screen returns the item unannotated rather than dropping it", async () => {
  const { client } = fakeJev({ fail: true });
  const out = await screenNews(client, [news(1)], quiet);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.jevScreen, undefined);
});

test("screening is bounded and the tail is returned unscreened, not discarded", async () => {
  const { client, asked } = fakeJev();
  const items = Array.from({ length: JEV_SCREEN_MAX_ITEMS + 5 }, (_v, i) => news(i));
  const out = await screenNews(client, items, quiet);
  assert.equal(out.length, items.length);
  assert.equal(asked.length, JEV_SCREEN_MAX_ITEMS);
  assert.equal(out[out.length - 1]?.jevScreen, undefined);
});
