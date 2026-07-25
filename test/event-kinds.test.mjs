// v3.1 Stage 4 — event vocabulary SSOT tests. Structural checks (every kind has the fields the
// client needs, no drift between EVENT_KINDS and EVENT_KIND_NAMES) rather than fixture-based, since
// this module is pure configuration data, not a recognizer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_KINDS, EVENT_KIND_NAMES, eventKindsPayload } from "../lib/event-kinds.mjs";

test("EVENT_KINDS: every kind has a label and a color", () => {
  for (const [name, def] of Object.entries(EVENT_KINDS)) {
    assert.equal(typeof def.label, "string", `${name} missing a string label`);
    assert.ok(def.label.length > 0, `${name} has an empty label`);
    assert.equal(typeof def.color, "string", `${name} missing a color`);
    assert.equal(typeof def.redFlag, "boolean", `${name} missing a boolean redFlag`);
  }
});

test("EVENT_KIND_NAMES: matches Object.keys(EVENT_KINDS) exactly (no drift between the two exports)", () => {
  assert.deepEqual(EVENT_KIND_NAMES, Object.keys(EVENT_KINDS));
});

test("EVENT_KINDS: includes every pre-existing v3.0 kind (backward compatible — old events still render)", () => {
  for (const k of ["tool_use", "text", "agent_spawned", "commit", "tag", "ledger"]) {
    assert.ok(k in EVENT_KINDS, `pre-existing kind "${k}" missing`);
  }
});

test("EVENT_KINDS: includes the new Stage 4 sensing-layer kinds", () => {
  for (const k of ["file_edit", "command_test", "command_build", "command_lint", "command_git", "command_db", "command_install", "command_deploy", "command_destructive", "test_result", "error", "death", "ack", "stage", "control"]) {
    assert.ok(k in EVENT_KINDS, `new kind "${k}" missing`);
  }
});

test("EVENT_KINDS: red-flag kinds are exactly the ones that should auto-elevate (death, error, destructive commands)", () => {
  const flagged = Object.entries(EVENT_KINDS).filter(([, d]) => d.redFlag).map(([k]) => k).sort();
  assert.deepEqual(flagged, ["command_destructive", "death", "error"]);
});

test("eventKindsPayload: returns JSON-serializable plain data equal to EVENT_KINDS", () => {
  const payload = eventKindsPayload();
  assert.doesNotThrow(() => JSON.stringify(payload));
  assert.deepEqual(payload, EVENT_KINDS);
});
