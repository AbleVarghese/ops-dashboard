// Unit tests for the 5-state liveness classifier — the single source of truth for agent state
// used by transcripts.mjs, board-state.mjs, kanban.mjs, and narrative.mjs. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyAgentState, humanAge, STATE_LABEL } from "../lib/agent-status.mjs";

const THRESHOLDS = { liveWindowMs: 5000, stallThresholdMs: 300000, idleThresholdMs: 1800000 };

test("classifyAgentState: quiet < liveWindowMs -> live", () => {
  const now = Date.now();
  const r = classifyAgentState(now - 1000, THRESHOLDS, null);
  assert.equal(r.state, "live");
});

test("classifyAgentState: quiet >= idleThresholdMs -> idle, regardless of lastAction", () => {
  const now = Date.now();
  const r = classifyAgentState(now - 2000000, THRESHOLDS, { tool: "Bash", summary: "npm test" });
  assert.equal(r.state, "idle");
});

test("classifyAgentState: quiet >= stallThresholdMs but < idleThresholdMs -> stalled", () => {
  const now = Date.now();
  const r = classifyAgentState(now - 400000, THRESHOLDS, null);
  assert.equal(r.state, "stalled");
});

test("classifyAgentState: mid-window with a build tool + verify-looking summary -> verifying", () => {
  const now = Date.now();
  const r = classifyAgentState(now - 60000, THRESHOLDS, { tool: "Bash", summary: "pnpm test && pnpm typecheck" });
  assert.equal(r.state, "verifying");
});

test("classifyAgentState: mid-window with a build tool + non-verify summary -> building", () => {
  const now = Date.now();
  const r = classifyAgentState(now - 60000, THRESHOLDS, { tool: "Edit", summary: "Edit: src/foo.ts" });
  assert.equal(r.state, "building");
});

test("classifyAgentState: mid-window with no lastAction -> building (safe default)", () => {
  const now = Date.now();
  const r = classifyAgentState(now - 60000, THRESHOLDS, null);
  assert.equal(r.state, "building");
});

test("classifyAgentState: boundary at exactly stallThresholdMs is stalled (>=, not >)", () => {
  const now = Date.now();
  const r = classifyAgentState(now - THRESHOLDS.stallThresholdMs, THRESHOLDS, null);
  assert.equal(r.state, "stalled");
});

test("classifyAgentState: boundary at exactly idleThresholdMs is idle (>=, not >)", () => {
  const now = Date.now();
  const r = classifyAgentState(now - THRESHOLDS.idleThresholdMs, THRESHOLDS, null);
  assert.equal(r.state, "idle");
});

test("humanAge: sub-minute renders as seconds", () => {
  assert.equal(humanAge(12000), "12s");
});

test("humanAge: sub-hour renders as minutes", () => {
  assert.equal(humanAge(7 * 60000), "7m");
});

test("humanAge: sub-2-day renders as hours", () => {
  assert.equal(humanAge(5 * 3600000), "5h");
});

test("humanAge: >=48h renders as days", () => {
  assert.equal(humanAge(72 * 3600000), "3d");
});

test("humanAge: never returns a negative age for a negative input", () => {
  assert.equal(humanAge(-500), "0s");
});

test("STATE_LABEL covers every state classifyAgentState can return", () => {
  for (const s of ["live", "building", "verifying", "stalled", "idle", "done"]) {
    assert.ok(STATE_LABEL[s], `missing STATE_LABEL for "${s}"`);
  }
});

// ---------- "done" (real bug: a stood-down agent falsely read as "possibly stalled") ----------
// Real incident, this exact session: build-dashboard3 completed and deliberately stood down, but
// its quiet duration alone (past stallThresholdMs) classified it as "possibly stalled" — a false,
// alarming, red state for work that was actually finished on purpose. Fixed by reading the
// agent's own sign-off text before falling back to a pure quiet-timer read.

test('classifyAgentState: quiet past stallThresholdMs + a stand-down sign-off text -> done, not stalled', () => {
  const now = Date.now();
  const r = classifyAgentState(now - 400000, THRESHOLDS, {
    tool: null,
    kind: "text",
    summary: "Standing down. All P9c debt-closure work was already completed and reported before this session.",
  });
  assert.equal(r.state, "done");
});

test('classifyAgentState: quiet past idleThresholdMs + a completion sign-off -> done, not idle', () => {
  const now = Date.now();
  const r = classifyAgentState(now - 2000000, THRESHOLDS, {
    tool: null,
    kind: "text",
    summary: "Final report sent to team-lead. Nothing further for me to do here.",
  });
  assert.equal(r.state, "done");
});

test('classifyAgentState: "complete" appearing inside a TOOL CALL summary (not a sign-off text) does NOT trigger done', () => {
  // A Bash command that happens to print/reference "complete" mid-task is not a stand-down —
  // only a genuine final TEXT message counts. This guards against over-firing on substring matches.
  const now = Date.now();
  const r = classifyAgentState(now - 400000, THRESHOLDS, {
    tool: "Bash",
    kind: "tool_use",
    summary: "Bash: pnpm test -- --grep complete",
  });
  assert.equal(r.state, "stalled"); // still genuinely quiet mid-task -> the alarm is correct here
});

test('classifyAgentState: done semantics never override "live" (streaming this instant wins)', () => {
  const now = Date.now();
  const r = classifyAgentState(now - 1000, THRESHOLDS, { tool: null, kind: "text", summary: "Standing down now." });
  assert.equal(r.state, "live");
});

test('classifyAgentState: a sign-off TRUNCATED mid-word by the upstream 90-char summary limit still classifies done', () => {
  // Real live miss this session: transcripts.mjs truncates lastAction.summary to ~90 chars, which
  // cut "...Nothing further..." to "...Nothing furthe…" — a strict \bnothing further\b pattern
  // never matched, so build-phase9c (a genuinely finished, stood-down agent) showed as "possibly
  // stalled" right alongside the bug this classifier exists to fix.
  const now = Date.now();
  const r = classifyAgentState(now - 350000, THRESHOLDS, {
    tool: null,
    kind: "text",
    summary: "Acknowledged — Phase 9 is fully closed, verified, and committed (90f0ddd). Nothing furthe",
  });
  assert.equal(r.state, "done");
});

test('classifyAgentState: a genuinely mid-task quiet agent (non-completion text) still classifies stalled', () => {
  const now = Date.now();
  const r = classifyAgentState(now - 400000, THRESHOLDS, {
    tool: null,
    kind: "text",
    summary: "Still investigating the root cause of the flaky test.",
  });
  assert.equal(r.state, "stalled");
});
