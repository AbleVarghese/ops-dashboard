// v3.1 Stage 4 tests — live feed enrichment: assistantLineToEvents/userLineToEvents wire the
// Stage 4 recognizers into the feed pipeline (command classification, file-edit kind, ack/stage,
// test-result + error/death parsing from tool_result text, and tool_use<->tool_result correlation
// via `causedBy`). The SendMessage ACK fixture is REAL, verbatim from this campaign's own
// transcripts (see recognizers/ack-stage.test.mjs for the same provenance).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantLineToEvents, userLineToEvents } from "../lib/feed-transcripts.mjs";

function assistantLine(content, overrides = {}) {
  return { type: "assistant", timestamp: "2026-07-24T10:00:00.000Z", message: { model: "claude-sonnet-5", content }, ...overrides };
}

test("assistantLineToEvents: Bash test command gets kind command_test (not generic tool_use)", () => {
  const line = assistantLine([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pnpm test 2>&1 | tail -60" } }]);
  const events = assistantLineToEvents(line, "abuild-x", new Map());
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "command_test");
  assert.equal(events[0].tool, "Bash");
});

test("assistantLineToEvents: Bash read-only command (ls) stays generic tool_use", () => {
  const line = assistantLine([{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls -la" } }]);
  const events = assistantLineToEvents(line, "abuild-x", new Map());
  assert.equal(events[0].kind, "tool_use");
});

test("assistantLineToEvents: Edit gets kind file_edit", () => {
  const line = assistantLine([{ type: "tool_use", id: "toolu_3", name: "Edit", input: { file_path: "/tmp/a.ts", old_string: "x", new_string: "y" } }]);
  const events = assistantLineToEvents(line, "abuild-x", new Map());
  assert.equal(events[0].kind, "file_edit");
});

test("assistantLineToEvents: Write gets kind file_edit", () => {
  const line = assistantLine([{ type: "tool_use", id: "toolu_4", name: "Write", input: { file_path: "/tmp/new.md", content: "hi" } }]);
  const events = assistantLineToEvents(line, "abuild-x", new Map());
  assert.equal(events[0].kind, "file_edit");
});

test("assistantLineToEvents: Read stays generic tool_use (deliberately not its own kind — see event-kinds.mjs)", () => {
  const line = assistantLine([{ type: "tool_use", id: "toolu_5", name: "Read", input: { file_path: "/tmp/a.ts" } }]);
  const events = assistantLineToEvents(line, "abuild-x", new Map());
  assert.equal(events[0].kind, "tool_use");
});

test("assistantLineToEvents: SendMessage ACK — REAL captured input, gets kind ack", () => {
  const real = { to: "main", summary: "ACK: P9c feature block", message: "ACK: P9c feature block. Starting exploration..." };
  const line = assistantLine([{ type: "tool_use", id: "toolu_6", name: "SendMessage", input: real }]);
  const events = assistantLineToEvents(line, "abuild-phase9c", new Map());
  assert.equal(events[0].kind, "ack");
});

test("assistantLineToEvents: SendMessage STAGE ping gets kind stage", () => {
  const line = assistantLine([{ type: "tool_use", id: "toolu_7", name: "SendMessage", input: { to: "team-lead", summary: "STAGE: alive, still working" } }]);
  const events = assistantLineToEvents(line, "abuild-x", new Map());
  assert.equal(events[0].kind, "stage");
});

test("assistantLineToEvents: SendMessage without ACK/STAGE shape stays generic tool_use", () => {
  const line = assistantLine([{ type: "tool_use", id: "toolu_8", name: "SendMessage", input: { to: "main", summary: "Fixed 3 real bugs along the way" } }]);
  const events = assistantLineToEvents(line, "abuild-x", new Map());
  assert.equal(events[0].kind, "tool_use");
});

test("assistantLineToEvents: text block still produces a text-kind event", () => {
  const line = assistantLine([{ type: "text", text: "Reading the config now." }]);
  const events = assistantLineToEvents(line, "abuild-x", new Map());
  assert.equal(events[0].kind, "text");
});

test("assistantLineToEvents: tool_use id is remembered in pendingMap for later correlation", () => {
  const pending = new Map();
  const line = assistantLine([{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "pnpm test" } }]);
  assistantLineToEvents(line, "abuild-x", pending);
  assert.ok(pending.has("toolu_9"));
  assert.equal(pending.get("toolu_9").tool, "Bash");
});

test("assistantLineToEvents: structured api-error line (REAL shape) -> kind death", () => {
  const line = {
    type: "assistant",
    timestamp: "2026-07-24T04:07:03.186Z",
    message: { content: [{ type: "text", text: "You've hit your session limit · resets 1:20am (America/Toronto)" }] },
    error: "rate_limit",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
  };
  const events = assistantLineToEvents(line, "abuild-rbac", new Map());
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "death");
  assert.equal(events[0].category, "session_limit");
});

test("assistantLineToEvents: non-assistant / malformed lines return [], never throw", () => {
  assert.doesNotThrow(() => {
    assert.deepEqual(assistantLineToEvents(null, "x", new Map()), []);
    assert.deepEqual(assistantLineToEvents({ type: "user" }, "x", new Map()), []);
    assert.deepEqual(assistantLineToEvents({ type: "assistant" }, "x", new Map()), []);
  });
});

// ---------- tool_result correlation (cross-source linking) ----------

function userResultLine(toolUseId, content) {
  return { type: "user", timestamp: "2026-07-24T10:00:05.000Z", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content }] } };
}

test("userLineToEvents: a test-result tool_result linked back to its command via causedBy", () => {
  const pending = new Map([["toolu_1", { tool: "Bash", ts: "2026-07-24T10:00:00.000Z" }]]);
  const real = "1..88\n# tests 88\n# suites 0\n# pass 88\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 9383.9";
  const events = userLineToEvents(userResultLine("toolu_1", real), "abuild-x", pending);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "test_result");
  assert.equal(events[0].passed, 88);
  assert.equal(events[0].failed, 0);
  assert.ok(events[0].causedBy, "should carry a causedBy link");
  assert.equal(events[0].causedBy.tool, "Bash");
  // the correlated id is consumed (removed) so it can't be matched twice
  assert.equal(pending.has("toolu_1"), false);
});

test("userLineToEvents: a failing test-result", () => {
  const events = userLineToEvents(userResultLine("toolu_x", "1..40\n# tests 40\n# pass 37\n# fail 3\n# skipped 0"), "abuild-x", new Map());
  assert.equal(events[0].kind, "test_result");
  assert.equal(events[0].failed, 3);
});

test("userLineToEvents: an error-shaped tool_result (REAL captured permission denial)", () => {
  const real = "Permission to use Bash with command cd /Users/Able/keralora/apps/web && cat .env.local has been denied.";
  const events = userLineToEvents(userResultLine("toolu_y", real), "abuild-x", new Map());
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "error");
  assert.equal(events[0].category, "permission_denied");
});

test("userLineToEvents: a genuine process-death tool_result (REAL captured Node crash) -> kind death", () => {
  const real = "node:internal/modules/cjs/loader:1404\n  throw err;\n  ^\n\nError: Cannot find module 'dotenv'";
  const events = userLineToEvents(userResultLine("toolu_z", real), "abuild-x", new Map());
  assert.equal(events[0].kind, "death");
});

test("userLineToEvents: ordinary tool_result (neither test nor error) produces no event", () => {
  const events = userLineToEvents(userResultLine("toolu_ord", "total 244\ndrwxr-xr-x 21 Able staff"), "abuild-x", new Map());
  assert.deepEqual(events, []);
});

test("userLineToEvents: tool_result content as an array of {type:'text'} blocks (real Anthropic shape) is joined and parsed", () => {
  const events = userLineToEvents(userResultLine("toolu_arr", [{ type: "text", text: "1..5\n# tests 5\n# pass 5\n# fail 0" }]), "abuild-x", new Map());
  assert.equal(events[0].kind, "test_result");
  assert.equal(events[0].passed, 5);
});

test("userLineToEvents: no matching pending entry -> causedBy is null, event still emitted", () => {
  const events = userLineToEvents(userResultLine("toolu_unknown", "===== 3 failed, 5 passed in 1.2s ====="), "abuild-x", new Map());
  assert.equal(events[0].causedBy, null);
});

test("userLineToEvents: non-user / malformed lines return [], never throw", () => {
  assert.doesNotThrow(() => {
    assert.deepEqual(userLineToEvents(null, "x", new Map()), []);
    assert.deepEqual(userLineToEvents({ type: "assistant" }, "x", new Map()), []);
    assert.deepEqual(userLineToEvents({ type: "user", message: { content: [{ type: "text" }] } }, "x", new Map()), []);
  });
});
