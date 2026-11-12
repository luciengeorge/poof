import assert from "node:assert/strict";
import { test } from "node:test";
import { failureDiagnostics, failureReporter } from "../../evals/lib/failure-diagnostics.ts";

test("failure diagnostics distinguish unfinished tools, children and model runs without payloads", () => {
  const secret = "private-payload-must-not-appear";
  const events = [
    { type: "call.requested", data: { callId: "done", capability: { kind: "tool", name: secret }, input: secret } },
    { type: "call.settled", data: { callId: "done", output: secret } },
    { type: "call.requested", data: { callId: secret, capability: { kind: "agent" } } },
    { type: "call.requested", data: { callId: "tool", capability: { kind: "tool" } } },
    { type: "call.requested", data: { callId: "other", capability: { kind: secret } } },
    { type: "child.opened", data: { sessionId: secret } },
    { type: "model.requested", data: { runId: "finished" } },
    { type: "model.started", data: { runId: "finished" } },
    { type: "model.settled", data: { runId: "finished", error: secret } },
    { type: "model.requested", data: { runId: secret } },
    { type: "model.started", data: { runId: secret } },
    { type: "model.retried", data: { runId: secret, error: secret } },
    { type: secret, data: {} },
  ];
  assert.deepEqual(failureDiagnostics(events), { callsRequested: 4, callsSettled: 1,
    modelsRequested: 2, modelsStarted: 2, modelsRetried: 1, modelsSettled: 1, childrenOpened: 1,
    pendingTools: 1, pendingAgents: 1, pendingOtherCalls: 1, pendingModels: 1 });
  assert.ok(!JSON.stringify(failureDiagnostics(events)).includes(secret));
});

test("failure reporter emits only failed-session counters, never error or transcript text", () => {
  const lines: string[] = [];
  const old = console.error;
  console.error = (...args) => { lines.push(args.join(" ")); };
  try {
    const failed = { verdict: "failed", error: "secret", result: { sessions: [{ events: [] }], reply: "secret" } };
    // Reporter fixture omits unrelated runner metadata; the public Eve type is checked at use.
    failureReporter.onEvalComplete(failed as unknown as Parameters<typeof failureReporter.onEvalComplete>[0]);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("secret"));
    failureReporter.onEvalComplete({ ...failed, verdict: "passed" } as unknown as Parameters<typeof failureReporter.onEvalComplete>[0]);
    assert.equal(lines.length, 1);
  } finally { console.error = old; }
});
