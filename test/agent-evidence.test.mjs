// v3.1 Stage 1 tests — the evidence-gathering layer, tested independently from classification
// (Stage 2), per the correctness law: conflating "did I read the right data" with "did I classify
// it correctly" risks compound bugs (see verify/V3.1-PLAN.md's sequencing rationale).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lastTranscriptActions, readSpawnMeta, controlEvidence, gatherAgentEvidence } from "../lib/agent-evidence.mjs";
import { appendControlRequest } from "../lib/control.mjs";
import { dataDirFor } from "../lib/paths.mjs";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function jsonlLine(obj) {
  return JSON.stringify(obj) + "\n";
}
function assistantTextLine(text, ts) {
  return jsonlLine({ type: "assistant", timestamp: ts, message: { model: "claude-test", content: [{ type: "text", text }] } });
}
function assistantToolLine(tool, ts) {
  return jsonlLine({ type: "assistant", timestamp: ts, message: { model: "claude-test", content: [{ type: "tool_use", name: tool, input: {} }] } });
}

// ---------- lastTranscriptActions ----------

test("lastTranscriptActions: returns the last 2 actions, oldest-first, from a multi-entry transcript", () => {
  const dir = tmpDir("ops-dash-evidence-");
  const file = path.join(dir, "agent.jsonl");
  fs.writeFileSync(
    file,
    assistantTextLine("first message", "2026-01-01T00:00:00Z") +
      assistantToolLine("Bash", "2026-01-01T00:01:00Z") +
      assistantTextLine("final sign-off", "2026-01-01T00:02:00Z")
  );
  const actions = lastTranscriptActions(file, 2);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].kind, "tool_use");
  assert.equal(actions[0].tool, "Bash");
  assert.equal(actions[1].kind, "text");
  assert.equal(actions[1].text, "final sign-off");
});

test("lastTranscriptActions: multiple content items in ONE message are read in order", () => {
  const dir = tmpDir("ops-dash-evidence-");
  const file = path.join(dir, "agent.jsonl");
  fs.writeFileSync(
    file,
    jsonlLine({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      message: { content: [{ type: "tool_use", name: "Read", input: {} }, { type: "text", text: "done reading" }] },
    })
  );
  const actions = lastTranscriptActions(file, 2);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].tool, "Read");
  assert.equal(actions[1].text, "done reading");
});

test("lastTranscriptActions: missing file returns [], never throws", () => {
  assert.doesNotThrow(() => {
    const actions = lastTranscriptActions("/tmp/does-not-exist-ops-dash.jsonl", 2);
    assert.deepEqual(actions, []);
  });
});

test("lastTranscriptActions: corrupt/non-JSON lines are skipped, not fatal", () => {
  const dir = tmpDir("ops-dash-evidence-");
  const file = path.join(dir, "agent.jsonl");
  fs.writeFileSync(file, "not json at all\n" + assistantTextLine("real message", "2026-01-01T00:00:00Z"));
  const actions = lastTranscriptActions(file, 2);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].text, "real message");
});

test("lastTranscriptActions: non-assistant lines (user/system) are ignored", () => {
  const dir = tmpDir("ops-dash-evidence-");
  const file = path.join(dir, "agent.jsonl");
  fs.writeFileSync(
    file,
    jsonlLine({ type: "user", message: { content: "irrelevant" } }) + assistantTextLine("the real one", "2026-01-01T00:00:00Z")
  );
  const actions = lastTranscriptActions(file, 2);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].text, "the real one");
});

// ---------- readSpawnMeta ----------

test("readSpawnMeta: reads a real-shaped meta.json (the audited 8,208-file union shape)", () => {
  const dir = tmpDir("ops-dash-evidence-");
  const file = path.join(dir, "agent.meta.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      agentType: "build-example",
      description: "Example task",
      name: "build-example",
      spawnDepth: 0,
      model: "sonnet",
      taskKind: "in_process_teammate",
      teamName: "session-test",
      color: "orange",
      planModeRequired: false,
      permissionMode: "auto",
    })
  );
  const meta = readSpawnMeta(file);
  assert.equal(meta.agentType, "build-example");
  assert.equal(meta.description, "Example task");
  assert.equal(meta.model, "sonnet");
  assert.equal(meta.teamName, "session-test");
});

test("readSpawnMeta: missing file returns null, never throws", () => {
  assert.doesNotThrow(() => assert.equal(readSpawnMeta("/tmp/does-not-exist-ops-dash.meta.json"), null));
});

// ---------- controlEvidence ----------

test("controlEvidence: finds a pending request naming this agent, ignores requests naming a different agent", async () => {
  const projectKey = `-verify-evidence-test-${Date.now()}`;
  try {
    appendControlRequest(projectKey, { action: "ping", agent: "target-agent", note: "test" });
    appendControlRequest(projectKey, { action: "ping", agent: "other-agent", note: "should be ignored" });
    const ev = controlEvidence(projectKey, "target-agent");
    assert.equal(ev.hasPendingRequest, true);
    assert.equal(ev.hasHonoredRequest, false);
    assert.equal(ev.requests.length, 1);
  } finally {
    fs.rmSync(dataDirFor(projectKey), { recursive: true, force: true });
  }
});

test("controlEvidence: no projectKey or agentName -> the empty/false shape, never throws", () => {
  assert.doesNotThrow(() => {
    const ev = controlEvidence(null, null);
    assert.deepEqual(ev, { hasPendingRequest: false, hasHonoredRequest: false, requests: [] });
  });
});

// ---------- gatherAgentEvidence (integration) ----------

test("gatherAgentEvidence: integrates all sources into one evidence object", async () => {
  const dir = tmpDir("ops-dash-evidence-");
  const transcriptFile = path.join(dir, "agent-atest.jsonl");
  const metaFile = path.join(dir, "agent-atest.meta.json");
  fs.writeFileSync(transcriptFile, assistantTextLine("Standing down. Nothing further.", "2026-01-01T00:00:00Z"));
  fs.writeFileSync(metaFile, JSON.stringify({ agentType: "build-test", description: "test task" }));
  const projectKey = `-verify-evidence-integration-${Date.now()}`;
  try {
    const now = Date.now();
    const ev = gatherAgentEvidence({
      filePath: transcriptFile,
      metaFilePath: metaFile,
      mtimeMs: now - 60000,
      projectKey,
      agentName: "test-agent",
    });
    assert.equal(ev.quietMs >= 59000 && ev.quietMs <= 61000, true, "quietMs should be ~60000ms");
    assert.equal(ev.lastAction.kind, "text");
    assert.match(ev.lastAction.text, /Standing down/);
    assert.equal(ev.secondLastAction, null); // only one action exists
    assert.equal(ev.spawnMeta.agentType, "build-test");
    assert.equal(ev.control.hasPendingRequest, false);
    assert.equal(ev.processMatch.scope, "session-level-only");
  } finally {
    fs.rmSync(dataDirFor(projectKey), { recursive: true, force: true });
  }
});

test("gatherAgentEvidence: missing metaFilePath -> spawnMeta is null, everything else still works", () => {
  const dir = tmpDir("ops-dash-evidence-");
  const transcriptFile = path.join(dir, "agent-atest.jsonl");
  fs.writeFileSync(transcriptFile, assistantTextLine("working on it", "2026-01-01T00:00:00Z"));
  const ev = gatherAgentEvidence({ filePath: transcriptFile, metaFilePath: null, mtimeMs: Date.now(), projectKey: null, agentName: null });
  assert.equal(ev.spawnMeta, null);
  assert.equal(ev.lastAction.text, "working on it");
});
