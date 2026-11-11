import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizedReadiness } from "./activation-readiness.ts";

test("readiness probes fail closed without the deployment's shared secret", () => {
  assert.equal(authorizedReadiness(new Request("https://test/ops"), undefined), false);
  assert.equal(authorizedReadiness(new Request("https://test/ops"), "secret"), false);
  assert.equal(authorizedReadiness(new Request("https://test/ops", { headers: { authorization: "Bearer wrong" } }), "secret"), false);
  assert.equal(authorizedReadiness(new Request("https://test/ops", { headers: { authorization: "Bearer secret" } }), "secret"), true);
});
