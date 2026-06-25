import { test } from "node:test";
import assert from "node:assert/strict";
import { ExaProvider, ExaError } from "./exa.ts";

function fakeFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body?: unknown },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const i = init ?? {};
    calls.push({ url: String(input), init: i });
    const r = handler(String(input), i);
    const bodyText =
      r.body === undefined
        ? ""
        : typeof r.body === "string"
          ? r.body
          : JSON.stringify(r.body);
    return new Response(bodyText, { status: r.status ?? 200 });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

test("search posts to /search with x-api-key and maps results", async () => {
  const f = fakeFetch(() => ({
    body: {
      results: [
        {
          title: "Fed holds rates",
          url: "https://x/y",
          publishedDate: "2026-06-24T10:00:00Z",
          author: "Reuters",
          text: "full text",
          summary: "the gist",
        },
      ],
    },
  }));
  const exa = new ExaProvider({ apiKey: "KEY", fetchImpl: f.fn });
  const results = await exa.search("Fed decision", {
    numResults: 5,
    category: "news",
    text: { maxCharacters: 800 },
    summary: true,
  });
  assert.equal(f.calls[0].url, "https://api.exa.ai/search");
  assert.equal(f.calls[0].init.method, "POST");
  const headers = f.calls[0].init.headers as Record<string, string>;
  assert.equal(headers["x-api-key"], "KEY");
  const sent = JSON.parse(f.calls[0].init.body as string);
  assert.equal(sent.query, "Fed decision");
  assert.equal(sent.numResults, 5);
  assert.equal(sent.category, "news");
  assert.deepEqual(sent.contents, { text: { maxCharacters: 800 }, summary: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Fed holds rates");
  assert.equal(results[0].summary, "the gist");
});

test("search omits optional fields when not provided and nulls missing result fields", async () => {
  const f = fakeFetch(() => ({ body: { results: [{ title: "t", url: "u" }] } }));
  const exa = new ExaProvider({ apiKey: "KEY", fetchImpl: f.fn });
  const results = await exa.search("q");
  const sent = JSON.parse(f.calls[0].init.body as string);
  assert.deepEqual(Object.keys(sent), ["query"]); // no contents/category/etc.
  assert.equal(results[0].publishedDate, null);
  assert.equal(results[0].text, null);
});

test("throws ExaError on non-2xx, flags 429", async () => {
  const f = fakeFetch(() => ({ status: 429, body: "rate limited" }));
  const exa = new ExaProvider({ apiKey: "KEY", fetchImpl: f.fn });
  await assert.rejects(
    () => exa.search("q"),
    (err: unknown) => {
      assert.ok(err instanceof ExaError);
      assert.equal(err.status, 429);
      assert.equal(err.rateLimited, true);
      return true;
    },
  );
});
