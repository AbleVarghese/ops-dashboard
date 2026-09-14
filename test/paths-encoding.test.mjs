// Regression tests for the Claude Code project-directory encoding (fixed 2026-09-09).
//
// The bug these lock down: claudeProjectDirName replaced only "/" with "-", so any repo whose
// path contained a dot or a space derived a directory that does not exist. Nothing errored —
// the dashboard reported zero agents. On this machine that silently blinded it to 16 of the 26
// project directories with recoverable evidence, INCLUDING ~/.claude itself.
//
// Both halves are tested on purpose. Getting the string right without making the miss loud would
// leave the real defect alive: the next encoding change would be just as silent as this one was.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeProjectDirName, resolveProject } from "../lib/paths.mjs";
import { buildBoardState } from "../lib/board-state.mjs";

// Real directory names observed under ~/.claude/projects, paired with the cwd their own
// transcripts recorded. These are OBSERVATIONS, not constructions — that is what makes them
// evidence rather than a restatement of the implementation.
const OBSERVED = [
  ["/Users/Able/.claude", "-Users-Able--claude"],
  ["/Users/Able/.claude/.claude/worktrees/model-routing-100x", "-Users-Able--claude--claude-worktrees-model-routing-100x"],
  ["/Users/Able/.claude/docs/research", "-Users-Able--claude-docs-research"],
  ["/Users/Able/.pi/worktrees/LawyerServed/issue-346-env-output-schema", "-Users-Able--pi-worktrees-LawyerServed-issue-346-env-output-schema"],
  ["/Users/Able/WhatsApp Chat with PRAVEEN Sir Pharmacy Manager", "-Users-Able-WhatsApp-Chat-with-PRAVEEN-Sir-Pharmacy-Manager"],
  ["/Users/Able/LawyerServed", "-Users-Able-LawyerServed"],
  ["/Users/Able/keralora", "-Users-Able-keralora"],
];

test("claudeProjectDirName reproduces every observed Claude Code project directory", () => {
  for (const [repoPath, expected] of OBSERVED) {
    assert.equal(claudeProjectDirName(repoPath), expected, `encoding ${repoPath}`);
  }
});

test("a dot in the path encodes to a dash — the 2026-09-09 regression", () => {
  // The old rule returned "-Users-Able-.claude", a directory that has never existed.
  assert.equal(claudeProjectDirName("/Users/Able/.claude"), "-Users-Able--claude");
  assert.ok(!claudeProjectDirName("/Users/Able/.claude").includes("."), "no literal dot may survive");
});

test("a space in the path encodes to a dash", () => {
  assert.equal(claudeProjectDirName("/Users/Able/two words"), "-Users-Able-two-words");
});

test("paths without dots or spaces are unchanged — the fix is not a rewrite", () => {
  // Every project that worked before the fix must still work after it. A correction that breaks
  // the previously-correct cases is not a correction.
  assert.equal(claudeProjectDirName("/Users/Able/keralora"), "-Users-Able-keralora");
  assert.equal(claudeProjectDirName("/Users/Able/LawyerServed"), "-Users-Able-LawyerServed");
});

test("a missing transcript directory reports UNKNOWN loudly, never a silent empty agent list", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-dash-paths-"));
  try {
    const project = resolveProject(path.join(tmp, "a-repo-claude-code-never-ran-in"));
    assert.equal(project.claudeProjectDirExists, false, "precondition: the dir really is absent");

    const state = await buildBoardState(project, {
      feed: {},
      kanban: { columns: [] },
      controlContractEnabled: false,
    });

    assert.equal(state.agents.length, 0, "no agents can be found, which is correct");
    assert.equal(state.transcriptSource.ok, false, "but the board must say WHY the list is empty");
    assert.match(state.transcriptSource.detail, /UNKNOWN, not empty/);
    assert.match(state.transcriptSource.detail, /No transcript directory/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a present transcript directory reports ok with no alarm text", async () => {
  // The other side of the control: a guard that always fires is as useless as one that never does.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ops-dash-paths-ok-"));
  try {
    const repoPath = path.join(tmp, "real-repo");
    fs.mkdirSync(repoPath, { recursive: true });
    const project = resolveProject(repoPath);
    fs.mkdirSync(project.claudeProjectDir, { recursive: true });

    const fresh = resolveProject(repoPath);
    assert.equal(fresh.claudeProjectDirExists, true);

    const state = await buildBoardState(fresh, {
      feed: {},
      kanban: { columns: [] },
      controlContractEnabled: false,
    });
    assert.equal(state.transcriptSource.ok, true);
    assert.equal(state.transcriptSource.detail, null, "no alarm when there is nothing to alarm about");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
