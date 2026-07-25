// v3.1 Stage 4 tests — Bash command classification. Every fixture is a REAL Bash tool_use command
// captured from this project's own build campaign's subagent transcripts on this machine
// (~/.claude/projects/-Users-Able-keralora/302b18c1.../subagents/*.jsonl) — not reconstructed from
// memory, per the established Stage 4a real-fixture norm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../../lib/recognizers/command-classifier.mjs";

test("classifyCommand: test — REAL captured command", () => {
  assert.equal(classifyCommand("pnpm test 2>&1 | tail -60"), "test");
});

test("classifyCommand: test — REAL captured command (this dashboard's own npm test)", () => {
  assert.equal(classifyCommand("cd ~/.claude/lib/ops-dashboard && node --check lib/agent-status-v31.mjs && npm test 2>&1 | tail -8"), "test");
});

test("classifyCommand: build — REAL captured command", () => {
  assert.equal(classifyCommand("cd /Users/Able/keralora/apps/web && timeout 280 pnpm build 2>&1 | tail -15"), "build");
});

test("classifyCommand: build — REAL captured command (tsc --noEmit)", () => {
  assert.equal(classifyCommand("cd /Users/Able/keralora/apps/web && node_modules/.bin/tsc --noEmit 2>&1 | tail -60"), "build");
});

test("classifyCommand: lint — REAL captured command", () => {
  assert.equal(classifyCommand("cd /Users/Able/keralora/apps/web && pnpm lint 2>&1 | tail -10"), "lint");
});

test("classifyCommand: lint — REAL captured command (biome check --write)", () => {
  assert.equal(classifyCommand("cd apps/web && npx biome check --write src/app/globals.css"), "lint");
});

test("classifyCommand: git — REAL captured command", () => {
  assert.equal(classifyCommand("git log --oneline -5"), "git");
});

test("classifyCommand: git — REAL captured command (status)", () => {
  assert.equal(classifyCommand("cd /Users/Able/keralora/apps/web && git status --short | head -20 && echo done"), "git");
});

test("classifyCommand: db — REAL captured command (drizzle migrate)", () => {
  assert.equal(classifyCommand("cd /Users/Able/keralora/apps/web && pnpm db:migrate > /tmp/migrate_out6.log 2>&1; echo EXIT: $?"), "db");
});

test("classifyCommand: install — REAL captured command", () => {
  assert.equal(classifyCommand("pnpm add stripe@22.3.2 --filter @keralora/web 2>&1 | tail -30"), "install");
});

test("classifyCommand: install — REAL captured command (bare install)", () => {
  assert.equal(classifyCommand("pnpm install 2>&1 | tail -20"), "install");
});

test("classifyCommand: destructive — REAL captured command (rm -rf)", () => {
  assert.equal(classifyCommand("rm -rf /tmp/opsdash-corrupt-config-test"), "destructive");
});

test("classifyCommand: destructive outranks git when a command is both (git reset --hard)", () => {
  assert.equal(classifyCommand("git reset --hard origin/main"), "destructive");
});

test("classifyCommand: destructive outranks git (git clean -fd)", () => {
  assert.equal(classifyCommand("git clean -fd"), "destructive");
});

test("classifyCommand: destructive (git push --force, but --force-with-lease is safer and NOT flagged)", () => {
  assert.equal(classifyCommand("git push --force origin main"), "destructive");
  assert.equal(classifyCommand("git push --force-with-lease origin main"), "git");
});

test("classifyCommand: deploy", () => {
  assert.equal(classifyCommand("vercel deploy --prod"), "deploy");
});

test("classifyCommand: other — a plain read-only command with no recognized family", () => {
  assert.equal(classifyCommand("ls -la"), "other");
});

test("classifyCommand: other — cat", () => {
  assert.equal(classifyCommand("cat package.json"), "other");
});

test("classifyCommand: empty/null/undefined input returns 'other', never throws", () => {
  assert.doesNotThrow(() => {
    assert.equal(classifyCommand(""), "other");
    assert.equal(classifyCommand(null), "other");
    assert.equal(classifyCommand(undefined), "other");
  });
});
