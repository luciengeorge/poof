import { test } from "node:test";
import assert from "node:assert/strict";
import { ConvexError } from "convex/values";
import { reconciliationDiagnostic, RECONCILIATION_CONFIG_ERROR } from "./reconciliation-diagnostics.ts";

test("expected reconciliation outcomes have distinct exit semantics without exposing backend data", () => {
  const none = reconciliationDiagnostic(new ConvexError({ code: "NO_FENCED_ORDER", message: "private-token and account" }));
  assert.equal(none.status, "not-needed"); assert.equal(none.exitCode, 0);
  assert.ok(!none.message.includes("retained"));
  const manual = reconciliationDiagnostic(new ConvexError({ code: "MANUAL_AUDIT_REQUIRED", private: "private-token" }));
  assert.equal(manual.status, "manual-audit-required"); assert.equal(manual.exitCode, 2);
  const broker = reconciliationDiagnostic(new Error("Reconciliation broker read refused"));
  assert.equal(broker.status, "broker-read-failed"); assert.equal(broker.exitCode, 1);
  assert.ok(!JSON.stringify([none, manual, broker]).includes("private-token"));
});

test("unexpected errors and message lookalikes remain generic and reveal no arbitrary text", () => {
  for (const error of [new Error("private-token No fenced order to reconcile"),
    new Error("Reconciliation broker read refused private-token"),
    new ConvexError({ code: "UNKNOWN", token: "private-token" }), { message: "private-token" }, "private-token"]) {
    const diagnostic = reconciliationDiagnostic(error);
    assert.equal(diagnostic.status, "failed"); assert.equal(diagnostic.exitCode, 1);
    assert.ok(!JSON.stringify(diagnostic).includes("private-token"));
  }
  const config = reconciliationDiagnostic(new Error(RECONCILIATION_CONFIG_ERROR));
  assert.equal(config.status, "not-configured"); assert.equal(config.exitCode, 2);
  assert.match(config.message, /Keep the mode OFF/);
});
