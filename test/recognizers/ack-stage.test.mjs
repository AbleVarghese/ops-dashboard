// v3.1 Stage 4 tests — ACK/stage-ping semantics. Every ACK/STAGE fixture below is a REAL,
// verbatim-captured SendMessage tool_use input from this dashboard's own build campaign
// (~/.claude/projects/-Users-Able-keralora/302b18c1.../subagents/*.jsonl, this machine) — not
// reconstructed from memory, per the established Stage 4a real-fixture norm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeAckStage } from "../../lib/recognizers/ack-stage.mjs";

test("recognizeAckStage: ACK — REAL captured SendMessage input (agent-abuild-phase9c)", () => {
  const real = { to: "main", summary: "ACK: P9c feature block", message: "ACK: P9c feature block. Starting exploration of docs/05 P9 AC, existing admin dashboard, settings service, DataTable, cmdk palette, and the DAL/service layer for KPI aggregates." };
  const r = recognizeAckStage(real);
  assert.ok(r, "should recognize the ACK");
  assert.equal(r.type, "ack");
  assert.equal(r.to, "main");
  assert.match(r.summary, /ACK: P9c feature block/);
});

test("recognizeAckStage: ACK with em-dash punctuation — REAL captured SendMessage input (agent-abuild-rbac)", () => {
  const real = { to: "team-lead", summary: "ACK: starting RBAC build (Sonnet)", message: "ACK — starting the Employee RBAC track (ADR-A5 + A1b) on /Users/Able/keralora. I'm running as Sonnet 5 (claude-sonnet-5)" };
  const r = recognizeAckStage(real);
  assert.equal(r.type, "ack");
  assert.equal(r.to, "team-lead");
});

test("recognizeAckStage: STAGE ping — REAL captured SendMessage input (agent-abuild-phase9c)", () => {
  const real = { to: "team-lead", summary: "STAGE: alive, adding named-test-type coverage now", message: "STAGE: alive, not stuck — my prior \"done\" message already covered most of this (typecheck/lint/build, anonymity 31/31, reconciliation 8/8, scoped e2e 10/10 with 72 surface×viewport checks + axe-core 0" };
  const r = recognizeAckStage(real);
  assert.ok(r, "should recognize the stage ping");
  assert.equal(r.type, "stage_ping");
  assert.equal(r.to, "team-lead");
  assert.match(r.summary, /STAGE: alive/);
});

test("recognizeAckStage: 'Acknowledged' opening variant", () => {
  const r = recognizeAckStage({ to: "team-lead", summary: null, message: "Acknowledged. Debt-closure was already finished and reported before this message arrived." });
  assert.equal(r.type, "ack");
});

test("recognizeAckStage: plain string input (not an object)", () => {
  const r = recognizeAckStage("ACK: starting signals (A2/A3/A4 anonymous market transparency).");
  assert.equal(r.type, "ack");
});

test("recognizeAckStage: falls back to message text when summary is absent", () => {
  const r = recognizeAckStage({ to: "main", message: "STAGE: still working, no blockers." });
  assert.equal(r.type, "stage_ping");
  assert.match(r.summary, /STAGE: still working/);
});

test("recognizeAckStage: a completion/stand-down report is NOT classified here (that's agent-status-v31's DONE_RE job)", () => {
  const real = { to: "main", summary: "Debt-closure done, standing down", message: "Acknowledged. Debt-closure was already finished..." };
  // Deliberately starts with "Acknowledged" too (a real observed overlap) — still correctly an ACK
  // by THIS recognizer's narrow job (protocol-message shape), even though the taxonomy classifier
  // separately reads the same text for DONE semantics. The two recognizers answer different
  // questions from the same text and are not required to agree.
  const r = recognizeAckStage(real);
  assert.equal(r.type, "ack");
});

test("recognizeAckStage: ordinary progress text is not misclassified as ACK/STAGE", () => {
  assert.equal(recognizeAckStage({ to: "main", summary: "Fixed 3 real bugs found along the way", message: "Found and fixed 3 real bugs during the build." }), null);
});

test("recognizeAckStage: 'staging' in prose does not false-positive as a STAGE ping (word-boundary anchored at message start)", () => {
  assert.equal(recognizeAckStage("Deployed to the staging environment for review."), null);
});

test("recognizeAckStage: 'acknowledgement' mid-sentence does not false-positive (must be at the start)", () => {
  assert.equal(recognizeAckStage("For acknowledgement of receipt, see the audit log."), null);
});

test("recognizeAckStage: null/undefined/empty input returns null, never throws", () => {
  assert.doesNotThrow(() => {
    assert.equal(recognizeAckStage(null), null);
    assert.equal(recognizeAckStage(undefined), null);
    assert.equal(recognizeAckStage(""), null);
    assert.equal(recognizeAckStage({}), null);
    assert.equal(recognizeAckStage({ to: "main" }), null);
  });
});
