// v3.1 Stage 3 test — the MAX_AGENT_FILES scale fix. Real bug found live this session: a project
// with thousands of historical transcript files (LawyerServed on this machine: 3,543 files,
// 1.8GB) made every poll cycle take 10+ seconds, breaking M1's realtime promise. Fixed in
// lib/transcripts.mjs's findAgentFiles(): capped to the MAX_AGENT_FILES most-recently-modified
// files. This test proves the cap actually keeps the RIGHT (newest) files, not an arbitrary subset.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgents } from "../lib/transcripts.mjs";
import { resolveProject, CLAUDE_PROJECTS_ROOT } from "../lib/paths.mjs";

function makeAgentFile(subagentsDir, id, mtimeOffsetMs, textSuffix) {
  const filePath = path.join(subagentsDir, `agent-a${id}.jsonl`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      agentId: id,
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { model: "claude-test", content: [{ type: "text", text: `agent ${textSuffix}` }] },
    }) + "\n"
  );
  const mtime = new Date(Date.now() - mtimeOffsetMs);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

test("getAgents: a project with more than MAX_AGENT_FILES transcripts is capped, keeping the MOST RECENT ones (not an arbitrary subset)", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-dash-scale-test-"));
  const projectKey = `-${repoDir.split("/").filter(Boolean).join("-")}`;
  const claudeProjectDir = path.join(CLAUDE_PROJECTS_ROOT, projectKey);
  const subagentsDir = path.join(claudeProjectDir, "session-scale-test", "subagents");
  fs.mkdirSync(subagentsDir, { recursive: true });

  try {
    const COUNT = 320; // deliberately > the 300 cap
    // Spread mtimes so agent 0 is OLDEST (offset largest) and agent (COUNT-1) is NEWEST (offset ~0).
    for (let i = 0; i < COUNT; i++) {
      makeAgentFile(subagentsDir, i.toString().padStart(4, "0"), (COUNT - i) * 1000, i.toString());
    }

    const project = resolveProject(repoDir);
    const agents = getAgents(project, { liveWindowMs: 60000, stallThresholdMs: 300000, orphanThresholdMs: 86400000, hysteresisGraceMs: 15000 });

    assert.ok(agents.length <= 300, `expected at most 300 agents, got ${agents.length}`);
    // The newest-created agents (highest index, smallest mtime offset) must be the ones KEPT.
    // agent "0000" (oldest) must NOT be present; agent "0319" (newest) MUST be present.
    const names = agents.map((a) => a.agentId);
    assert.ok(!names.includes("0000"), "the OLDEST agent file should have been dropped by the cap");
    assert.ok(names.includes("0319"), "the NEWEST agent file should have survived the cap");
  } finally {
    fs.rmSync(claudeProjectDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("getAgents: a project with FEWER than MAX_AGENT_FILES transcripts is unaffected by the cap (all present)", () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-dash-scale-test2-"));
  const projectKey = `-${repoDir.split("/").filter(Boolean).join("-")}`;
  const claudeProjectDir = path.join(CLAUDE_PROJECTS_ROOT, projectKey);
  const subagentsDir = path.join(claudeProjectDir, "session-small", "subagents");
  fs.mkdirSync(subagentsDir, { recursive: true });

  try {
    for (let i = 0; i < 5; i++) makeAgentFile(subagentsDir, `small${i}`, i * 1000, i.toString());
    const project = resolveProject(repoDir);
    const agents = getAgents(project, { liveWindowMs: 60000, stallThresholdMs: 300000, orphanThresholdMs: 86400000, hysteresisGraceMs: 15000 });
    assert.equal(agents.length, 5);
  } finally {
    fs.rmSync(claudeProjectDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
