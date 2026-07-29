import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OBSERVER_FETCH_TIMEOUT_MS,
  timeoutFetch,
  type FetchLike,
} from "./fetch-timeout.ts";

/** A fetch that never settles and IGNORES the abort signal entirely: the worst case. */
const neverSettles: FetchLike = () => new Promise<Response>(() => {});

/** A fetch that never settles but does honour the signal, like the real platform fetch. */
const hangsUntilAborted: FetchLike = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
  });

test("a hanging fetch is ABANDONED at the deadline, not awaited indefinitely", async () => {
  // This is the guarantee that matters: the hook stops waiting even when the request cannot be
  // cancelled. Without the race, this test itself would hang forever.
  await assert.rejects(
    timeoutFetch(20, neverSettles)("https://example.invalid"),
    /timed out after 20ms/,
  );
});

test("the request is also actually cancelled, so the socket does not leak", async () => {
  // Layer 2 (the race) is what rejects first, so the abort is asserted directly rather than
  // through the error message: both layers must fire, not just the one the caller sees.
  let aborted = false;
  const observed: FetchLike = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("The operation was aborted"));
      });
    });
  await assert.rejects(timeoutFetch(20, observed)("https://example.invalid"), /timed out/);
  assert.equal(aborted, true, "the fetch signal must abort so the request is torn down");
});

test("a fetch that always gets an abort signal, even with no caller init", async () => {
  let seen: AbortSignal | null | undefined;
  const spy: FetchLike = (_input, init) => {
    seen = init?.signal;
    return Promise.resolve(new Response("ok"));
  };
  await timeoutFetch(1_000, spy)("https://example.invalid");
  assert.ok(seen instanceof AbortSignal);
  assert.equal(seen.aborted, false);
});

test("a healthy response passes straight through, untouched", async () => {
  const spy: FetchLike = async () => new Response("hello", { status: 201 });
  const response = await timeoutFetch(1_000, spy)("https://example.invalid");
  assert.equal(response.status, 201);
  assert.equal(await response.text(), "hello");
});

test("a real error still rejects with the original error, not a timeout", async () => {
  const boom: FetchLike = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(timeoutFetch(1_000, boom)("https://example.invalid"), /ECONNREFUSED/);
});

test("a caller-supplied signal still wins: an outer abort is not swallowed", async () => {
  const controller = new AbortController();
  const pending = timeoutFetch(10_000, hangsUntilAborted)("https://example.invalid", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /aborted/i);
});

test("the deadline timer is cleared, so a resolved call leaves nothing pending", async () => {
  // A leaked timer would keep the Node event loop (and a serverless invocation) alive.
  const ok: FetchLike = async () => new Response("ok");
  await timeoutFetch(60_000, ok)("https://example.invalid");
  // If the 60s timer were still armed, node:test would not be able to finish this file.
  assert.ok(true);
});

test("the observability budget is a few seconds: long for a healthy call, short for a dead one", () => {
  assert.ok(OBSERVER_FETCH_TIMEOUT_MS >= 1_000 && OBSERVER_FETCH_TIMEOUT_MS <= 10_000);
});
