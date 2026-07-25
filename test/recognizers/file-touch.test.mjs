// v3.1 Stage 4 tests — file-touch recognition. The Read/Edit fixtures below are REAL captured
// tool_use inputs from this campaign's own subagent transcripts on this machine (agent-abuild-
// phase9c, ~/.claude/projects/-Users-Able-keralora/302b18c1.../subagents/) — not reconstructed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeFileTouch } from "../../lib/recognizers/file-touch.mjs";

test("recognizeFileTouch: Read — REAL captured tool_use input from this project's own build", () => {
  const r = recognizeFileTouch({ name: "Read", input: { file_path: "/Users/Able/keralora/docs/05-IMPLEMENTATION-PLAN.md", offset: "1", limit: "100" } });
  assert.deepEqual(r, { op: "read", path: "/Users/Able/keralora/docs/05-IMPLEMENTATION-PLAN.md" });
});

test("recognizeFileTouch: Edit — REAL captured tool_use input", () => {
  const r = recognizeFileTouch({ name: "Edit", input: { file_path: "/Users/Able/keralora/apps/web/next.config.ts", old_string: "x", new_string: "y" } });
  assert.deepEqual(r, { op: "edit", path: "/Users/Able/keralora/apps/web/next.config.ts" });
});

test("recognizeFileTouch: Write", () => {
  const r = recognizeFileTouch({ name: "Write", input: { file_path: "/tmp/new-file.md", content: "hello" } });
  assert.deepEqual(r, { op: "write", path: "/tmp/new-file.md" });
});

test("recognizeFileTouch: NotebookEdit uses notebook_path", () => {
  const r = recognizeFileTouch({ name: "NotebookEdit", input: { notebook_path: "/tmp/nb.ipynb", new_source: "x" } });
  assert.deepEqual(r, { op: "edit", path: "/tmp/nb.ipynb" });
});

test("recognizeFileTouch: Bash rm — REAL captured command from this project's own verify run", () => {
  const r = recognizeFileTouch({ name: "Bash", input: { command: "rm -rf /tmp/opsdash-v3-test/screens" } });
  assert.deepEqual(r, { op: "delete", path: "/tmp/opsdash-v3-test/screens" });
});

test("recognizeFileTouch: Bash mv", () => {
  const r = recognizeFileTouch({ name: "Bash", input: { command: "mv old-name.txt new-name.txt" } });
  assert.deepEqual(r, { op: "move", path: "new-name.txt" });
});

test("recognizeFileTouch: Bash cp", () => {
  const r = recognizeFileTouch({ name: "Bash", input: { command: "cp -r src/ dest/" } });
  assert.deepEqual(r, { op: "copy", path: "dest/" });
});

test("recognizeFileTouch: Bash touch", () => {
  const r = recognizeFileTouch({ name: "Bash", input: { command: "touch /tmp/marker.flag" } });
  assert.deepEqual(r, { op: "create", path: "/tmp/marker.flag" });
});

test("recognizeFileTouch: Bash mkdir -p", () => {
  const r = recognizeFileTouch({ name: "Bash", input: { command: "mkdir -p /tmp/opsdash-corrupt-config-test" } });
  assert.deepEqual(r, { op: "create", path: "/tmp/opsdash-corrupt-config-test" });
});

test("recognizeFileTouch: Bash redirection", () => {
  const r = recognizeFileTouch({ name: "Bash", input: { command: "echo hello > /tmp/out.log" } });
  assert.deepEqual(r, { op: "write", path: "/tmp/out.log" });
});

test("recognizeFileTouch: Bash tee", () => {
  const r = recognizeFileTouch({ name: "Bash", input: { command: "echo hi | tee /tmp/log.txt" } });
  assert.deepEqual(r, { op: "write", path: "/tmp/log.txt" });
});

test("recognizeFileTouch: Bash sed -i", () => {
  const r = recognizeFileTouch({ name: "Bash", input: { command: "sed -i '' 's/foo/bar/' /tmp/config.json" } });
  assert.deepEqual(r, { op: "edit", path: "/tmp/config.json" });
});

test("recognizeFileTouch: Bash non-file command (git status) returns null, never a guess", () => {
  assert.equal(recognizeFileTouch({ name: "Bash", input: { command: "git status --short" } }), null);
});

test("recognizeFileTouch: Bash non-file command (ls) returns null", () => {
  assert.equal(recognizeFileTouch({ name: "Bash", input: { command: "ls -la" } }), null);
});

test("recognizeFileTouch: unrelated tool (Grep) returns null", () => {
  assert.equal(recognizeFileTouch({ name: "Grep", input: { pattern: "foo" } }), null);
});

test("recognizeFileTouch: unrelated tool (TaskUpdate) returns null", () => {
  assert.equal(recognizeFileTouch({ name: "TaskUpdate", input: { id: "1" } }), null);
});

test("recognizeFileTouch: null/undefined/malformed input never throws", () => {
  assert.doesNotThrow(() => {
    assert.equal(recognizeFileTouch(null), null);
    assert.equal(recognizeFileTouch(undefined), null);
    assert.equal(recognizeFileTouch({}), null);
    assert.equal(recognizeFileTouch({ name: "Edit", input: null }), null);
    assert.equal(recognizeFileTouch({ name: "Edit", input: {} }), null);
    assert.equal(recognizeFileTouch({ name: "Bash", input: {} }), null);
  });
});
