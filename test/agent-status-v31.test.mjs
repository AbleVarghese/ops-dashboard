// v3.1 Stage 2 tests — the 8-state classifier, per the correctness law's required test matrix:
// one fixture per state (8) + negative cases + a determinism property test + boundary/hysteresis
// tests + a source-conflict test. classifyAgentV31 is a pure function; every fixture below
// constructs the evidence object directly rather than going through lib/agent-evidence.mjs (that
// module's own 11 tests already cover evidence-GATHERING; these tests cover classification only —
// per verify/V3.1-PLAN.md's stated reason for keeping the two layers' tests independent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAgentV31, STATE_LABEL_V31, STATE_COLOR_V31 } from "../lib/agent-status-v31.mjs";

const THRESHOLDS = { liveWindowMs: 5000, stallThresholdMs: 300000, orphanThresholdMs: 3600000 }; // 1h orphan for fast tests

function evidence(overrides = {}) {
  return {
    quietMs: 0,
    lastAction: null,
    control: { hasPendingRequest: false, hasHonoredRequest: false, requests: [] },
    ...overrides,
  };
}

// ---------- 8 state fixtures ----------

test("STATE 1/8 — WORKING: quiet < liveWindowMs, last action is a tool_use", () => {
  const r = classifyAgentV31(evidence({ quietMs: 1000, lastAction: { kind: "tool_use", tool: "Bash" } }), THRESHOLDS);
  assert.equal(r.state, "working");
  assert.equal(r.confidence, "fact");
  assert.match(r.evidence, /Bash/);
});

test("STATE 2/8 — COMPOSING: quiet < liveWindowMs, last action is text (no tool call)", () => {
  const r = classifyAgentV31(evidence({ quietMs: 1000, lastAction: { kind: "text", text: "Let me look into this further." } }), THRESHOLDS);
  assert.equal(r.state, "composing");
  assert.equal(r.confidence, "fact");
});

test("STATE 3/8 — WAITING: deliberate wait language, within the pre-stall window", () => {
  const r = classifyAgentV31(evidence({ quietMs: 60000, lastAction: { kind: "text", text: "Waiting on the build to finish before continuing." } }), THRESHOLDS);
  assert.equal(r.state, "waiting");
  assert.equal(r.confidence, "fact");
  assert.match(r.evidence, /Waiting on the build/);
});

test("STATE 4/8 — DONE: a genuine sign-off in the agent's own words", () => {
  const r = classifyAgentV31(evidence({ quietMs: 400000, lastAction: { kind: "text", text: "Standing down. Nothing further for me to do here." } }), THRESHOLDS);
  assert.equal(r.state, "done");
  assert.equal(r.confidence, "fact");
});

test("STATE 5/8 — STOPPED: terminal-failure language in the agent's own tail", () => {
  const r = classifyAgentV31(evidence({ quietMs: 400000, lastAction: { kind: "text", text: "I hit the session limit and cannot continue." } }), THRESHOLDS);
  assert.equal(r.state, "stopped");
  assert.equal(r.confidence, "fact");
});

test("STATE 6/8 — PAUSED: an honored control request, highest priority over everything else", () => {
  const r = classifyAgentV31(
    evidence({
      quietMs: 1000, // would otherwise be WORKING
      lastAction: { kind: "tool_use", tool: "Bash" },
      control: { hasHonoredRequest: true, hasPendingRequest: false, requests: [{ action: "pause_campaign", honored: true, ts: "2026-01-01T00:00:00Z" }] },
    }),
    THRESHOLDS
  );
  assert.equal(r.state, "paused");
  assert.equal(r.confidence, "fact");
});

test("STATE 7/8 — POSSIBLY STUCK: quiet past stallThreshold, mid-task, no completion signal", () => {
  const r = classifyAgentV31(evidence({ quietMs: 400000, lastAction: { kind: "tool_use", tool: "Edit" } }), THRESHOLDS);
  assert.equal(r.state, "possibly_stuck");
  assert.equal(r.confidence, "inference"); // MUST be labeled inference, never asserted as fact
});

test("STATE 8/8 — ORPHANED: quiet past orphanThreshold, no completion signal", () => {
  const r = classifyAgentV31(evidence({ quietMs: 4000000, lastAction: { kind: "tool_use", tool: "Edit" } }), THRESHOLDS);
  assert.equal(r.state, "orphaned");
  assert.equal(r.confidence, "inference"); // MUST be labeled inference, never "presumed dead" as fact
});

test("STATE_LABEL_V31 and STATE_COLOR_V31 cover all 8 states classifyAgentV31 can return", () => {
  for (const s of ["working", "composing", "waiting", "done", "stopped", "paused", "possibly_stuck", "orphaned"]) {
    assert.ok(STATE_LABEL_V31[s], `missing STATE_LABEL_V31 for "${s}"`);
    assert.ok(STATE_COLOR_V31[s], `missing STATE_COLOR_V31 for "${s}"`);
  }
});

// ---------- Negative cases ----------

test("NEGATIVE: a tool_use whose summary happens to contain 'complete' does NOT trigger DONE (only kind:text counts)", () => {
  const r = classifyAgentV31(evidence({ quietMs: 400000, lastAction: { kind: "tool_use", tool: "Bash" } }), THRESHOLDS);
  // No `text` field on a tool_use action — DONE_RE is never even tested against it (see the
  // classifier's `text` derivation: only kind==="text" produces a non-null `text`).
  assert.notEqual(r.state, "done");
  assert.equal(r.state, "possibly_stuck");
});

test("NEGATIVE: WAIT language OUTSIDE the pre-stall window falls through to POSSIBLY_STUCK, not WAITING", () => {
  // "Waiting on X" said a long time ago with no update since is itself a stall signal, not an
  // ongoing legitimate wait — WAITING only applies while genuinely still within a reasonable window.
  const r = classifyAgentV31(evidence({ quietMs: 400000, lastAction: { kind: "text", text: "Waiting on the build to finish." } }), THRESHOLDS);
  assert.equal(r.state, "possibly_stuck");
});

test("NEGATIVE: a PENDING (not honored) control request does NOT trigger PAUSED", () => {
  const r = classifyAgentV31(
    evidence({
      quietMs: 1000,
      lastAction: { kind: "tool_use", tool: "Bash" },
      control: { hasHonoredRequest: false, hasPendingRequest: true, requests: [{ action: "pause_campaign", honored: false, ts: "2026-01-01T00:00:00Z" }] },
    }),
    THRESHOLDS
  );
  assert.equal(r.state, "working");
});

test("NEGATIVE: STOPPED language does not fire on a non-matching mid-task update", () => {
  const r = classifyAgentV31(evidence({ quietMs: 400000, lastAction: { kind: "text", text: "Still investigating the root cause of the flaky test." } }), THRESHOLDS);
  assert.notEqual(r.state, "stopped");
  assert.equal(r.state, "possibly_stuck");
});

// ---------- Source-conflict test (correctness law: show conflicts, don't arbitrate silently) ----------

test("SOURCE CONFLICT: control says paused/honored, but the transcript shows FRESH activity — state resolves to paused (higher-authority source) but the evidence string surfaces the disagreement", () => {
  const r = classifyAgentV31(
    evidence({
      quietMs: 500, // fresh — well within liveWindowMs
      lastAction: { kind: "tool_use", tool: "Bash" },
      control: { hasHonoredRequest: true, hasPendingRequest: false, requests: [{ action: "pause_campaign", honored: true, ts: "2026-01-01T00:00:00Z" }] },
    }),
    THRESHOLDS
  );
  assert.equal(r.state, "paused");
  assert.equal(r.sourceConflict, true);
  assert.match(r.evidence, /CONFLICTING SIGNALS/);
});

test("no conflict when control says paused/honored and the transcript is ALSO quiet (sources agree)", () => {
  const r = classifyAgentV31(
    evidence({
      quietMs: 400000,
      lastAction: { kind: "tool_use", tool: "Bash" },
      control: { hasHonoredRequest: true, hasPendingRequest: false, requests: [{ action: "pause_campaign", honored: true, ts: "2026-01-01T00:00:00Z" }] },
    }),
    THRESHOLDS
  );
  assert.equal(r.state, "paused");
  assert.notEqual(r.sourceConflict, true);
});

// ---------- Determinism property test ----------

test("DETERMINISM: the same evidence + thresholds + previousState always produces the same result, across many calls", () => {
  const ev = evidence({ quietMs: 400000, lastAction: { kind: "tool_use", tool: "Edit" } });
  const results = Array.from({ length: 50 }, () => classifyAgentV31(ev, THRESHOLDS, null));
  const first = JSON.stringify(results[0]);
  for (const r of results) assert.equal(JSON.stringify(r), first, "classifyAgentV31 must be a pure function — identical inputs must always produce identical output");
});

// ---------- Boundary / hysteresis tests ----------

test("BOUNDARY: exactly at stallThresholdMs (>=, not >) classifies possibly_stuck with no previous state", () => {
  const r = classifyAgentV31(evidence({ quietMs: THRESHOLDS.stallThresholdMs, lastAction: { kind: "tool_use", tool: "Bash" } }), THRESHOLDS, null);
  assert.equal(r.state, "possibly_stuck");
});

test("BOUNDARY: exactly at orphanThresholdMs (>=, not >) classifies orphaned", () => {
  const r = classifyAgentV31(evidence({ quietMs: THRESHOLDS.orphanThresholdMs, lastAction: { kind: "tool_use", tool: "Bash" } }), THRESHOLDS, null);
  assert.equal(r.state, "orphaned");
});

test("HYSTERESIS: with NO previous flagged state, quietMs just below stallThresholdMs classifies as an active state (no grace applied)", () => {
  const belowThreshold = THRESHOLDS.stallThresholdMs - 5000; // below raw threshold, no previous state
  const r = classifyAgentV31(evidence({ quietMs: belowThreshold, lastAction: { kind: "tool_use", tool: "Bash" } }), THRESHOLDS, null);
  assert.equal(r.state, "working");
});

test("HYSTERESIS: WITH previousState=possibly_stuck, quietMs within the grace margin below stallThresholdMs STAYS possibly_stuck (does not flap back to working)", () => {
  const withinGraceMargin = THRESHOLDS.stallThresholdMs - 5000; // below raw threshold, but within the 15s default grace
  const r = classifyAgentV31(evidence({ quietMs: withinGraceMargin, lastAction: { kind: "tool_use", tool: "Bash" } }), THRESHOLDS, "possibly_stuck");
  assert.equal(r.state, "possibly_stuck", "a previously-flagged agent should not flap back to an active state on a marginal quietMs dip within the grace margin");
});

test("HYSTERESIS: WITH previousState=possibly_stuck, quietMs BEYOND the grace margin DOES revert to an active state", () => {
  const beyondGraceMargin = THRESHOLDS.stallThresholdMs - 20000; // below raw threshold AND below the 15s grace zone
  const r = classifyAgentV31(evidence({ quietMs: beyondGraceMargin, lastAction: { kind: "tool_use", tool: "Bash" } }), THRESHOLDS, "possibly_stuck");
  assert.equal(r.state, "working", "far enough below the threshold, even a previously-flagged agent should correctly revert");
});

test("HYSTERESIS: a custom hysteresisGraceMs is honored", () => {
  const customThresholds = { ...THRESHOLDS, hysteresisGraceMs: 60000 };
  const withinCustomGrace = THRESHOLDS.stallThresholdMs - 45000; // would revert under the 15s default, but within a 60s custom grace
  const r = classifyAgentV31(evidence({ quietMs: withinCustomGrace, lastAction: { kind: "tool_use", tool: "Bash" } }), customThresholds, "possibly_stuck");
  assert.equal(r.state, "possibly_stuck");
});
