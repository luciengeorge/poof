import assert from "node:assert/strict";
import test from "node:test";

import { HttpJevClient, JEV_ENDPOINT, JEV_MODEL, JevError, jevFromEnv } from "./jev.ts";

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

test("jevFromEnv is null without a key, so every caller degrades to no annotation", () => {
  assert.equal(jevFromEnv({}), null);
  assert.equal(jevFromEnv({ TYPESAFE_API_KEY: "   " }), null);
  assert.ok(jevFromEnv({ TYPESAFE_API_KEY: "k" }));
});

test("ask posts the documented request shape with the pinned model", async () => {
  const { impl, calls } = fakeFetch({
    model: JEV_MODEL,
    answers: { q: { type: "noul", noul: 0.7 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  const client = new HttpJevClient("key", impl);
  const res = await client.ask({ a: 1 }, { q: { type: "noul", instructions: "yes?" } });
  assert.equal(calls[0]?.url, JEV_ENDPOINT);
  const sent = JSON.parse(String(calls[0]?.init.body));
  // Pinned on purpose: calibration measured against an alias that moves is not a measurement.
  // The LITERAL version, not the constant, so swapping the pin for "jev-latest" fails here.
  assert.equal(sent.model, "jev-1.13.0");
  assert.match(JEV_MODEL, /^jev-\d+\.\d+\.\d+$/, "JEV_MODEL must be a versioned id, never an alias");
  assert.deepEqual(sent.state, { a: 1 });
  assert.equal(sent.questions.q.type, "noul");
  assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer key");
  assert.equal(res.answers.q.noul, 0.7);
  assert.equal(res.model, JEV_MODEL);
});

test("a malformed noul is an error, never a default that would be scored as a forecast", async () => {
  const { impl } = fakeFetch({ model: "m", answers: { q: { type: "noul", noul: "0.7" } } });
  await assert.rejects(
    new HttpJevClient("k", impl).ask("s", { q: { type: "noul", instructions: "?" } }),
    JevError,
  );
});

test("a choice answer must cover every option and pick one of them", async () => {
  const good = fakeFetch({
    model: "m",
    answers: {
      tag: { type: "choice", choice: "b", probabilities: { a: 0.3, b: 0.7 }, confidence: 0.6 },
    },
  });
  const res = await new HttpJevClient("k", good.impl).ask("s", {
    tag: { type: "choice", instructions: "?", criteria: { a: null, b: null } },
  });
  assert.equal(res.answers.tag.choice, "b");
  assert.deepEqual(res.answers.tag.probabilities, { a: 0.3, b: 0.7 });

  const missing = fakeFetch({
    model: "m",
    answers: { tag: { type: "choice", choice: "b", probabilities: { b: 1 }, confidence: 0.9 } },
  });
  await assert.rejects(
    new HttpJevClient("k", missing.impl).ask("s", {
      tag: { type: "choice", instructions: "?", criteria: { a: null, b: null } },
    }),
    /probability missing for a/,
  );

  const outside = fakeFetch({
    model: "m",
    answers: { tag: { type: "choice", choice: "z", probabilities: { a: 0.5, b: 0.5 }, confidence: 0.1 } },
  });
  await assert.rejects(
    new HttpJevClient("k", outside.impl).ask("s", {
      tag: { type: "choice", instructions: "?", criteria: { a: null, b: null } },
    }),
    /outside criteria/,
  );
});

test("a non-2xx response is a JevError carrying the status", async () => {
  const { impl } = fakeFetch({ error: "rate limited" }, 429);
  await assert.rejects(
    new HttpJevClient("k", impl).ask("s", { q: { type: "noul", instructions: "?" } }),
    (err: unknown) => err instanceof JevError && err.status === 429,
  );
});
