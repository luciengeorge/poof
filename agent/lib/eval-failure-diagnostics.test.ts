import assert from "node:assert/strict";
import { test } from "node:test";
import { failureDiagnostics, diagnoseTurn } from "../../evals/lib/failure-diagnostics.ts";

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

test("forced timeout reads the live buffer even when the session snapshot is empty", async () => {
  const lines: string[] = [];
  const old = console.error;
  console.error = (...args) => { lines.push(args.join(" ")); };
  try {
    const error = new Error("secret-error-must-not-be-logged");
    const session = { events: [] };
    const live = {
      events: [{ type: "model.requested", data: { runId: "secret-run-id" } }],
      result: () => new Promise<never>((_, reject) => setTimeout(() => reject(error), 5)),
    };
    await assert.rejects(diagnoseTurn(live), e => e === error);
    assert.equal(session.events.length, 0);
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("secret"));
    assert.equal(JSON.parse(lines[0].slice(lines[0].indexOf("{"))).pendingModels, 1);
    assert.equal(await diagnoseTurn({ events: [], result: async () => "ok" }), "ok");
    assert.equal(lines.length, 1);
  } finally { console.error = old; }
});
