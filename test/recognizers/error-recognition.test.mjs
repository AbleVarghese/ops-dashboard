// v3.1 Stage 4 tests — error/death recognition. The structured api-error fixture and the process-
// death fixture below are REAL, verbatim (trimmed) captures from this campaign's own subagent
// transcripts on this machine — see the module header for exact provenance. Not reconstructed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeError } from "../../lib/recognizers/error-recognition.mjs";

test("recognizeError: structured API error line — REAL captured transcript line (session-limit death, HTTP 429, this campaign)", () => {
  // Verbatim (trimmed) from agent-abuild-rbac-1a1ab39aa78d775c.jsonl, this session's own project
  // dir: a real isApiErrorMessage line the harness itself wrote when this exact campaign's build
  // agent hit its session limit.
  const real = {
    type: "assistant",
    message: { content: [{ type: "text", text: "You've hit your session limit · resets 1:20am (America/Toronto)" }] },
    error: "rate_limit",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
  };
  const r = recognizeError(real);
  assert.ok(r, "should recognize the structured api-error shape");
  assert.equal(r.category, "session_limit");
  assert.equal(r.fatal, true);
  assert.match(r.detail, /session limit/);
});

test("recognizeError: structured API error line, non-session-limit code, still fatal", () => {
  const obj = { isApiErrorMessage: true, error: "overloaded_error", apiErrorStatus: 529, message: { content: [] } };
  const r = recognizeError(obj);
  assert.equal(r.category, "api_error");
  assert.equal(r.fatal, true);
  assert.match(r.detail, /overloaded_error/);
  assert.match(r.detail, /529/);
});

test("recognizeError: process death — REAL captured Node.js crash signature (Cannot find module 'dotenv', this campaign)", () => {
  // Verbatim from agent-abuild-signals-8dfaddbc9ae78b8f.jsonl's Bash tool_result stdout.
  const real = "node:internal/modules/cjs/loader:1404\n  throw err;\n  ^\n\nError: Cannot find module 'dotenv'\nRequire stack:\n- /Users/Able/keralora/apps/web/[eval]";
  const r = recognizeError(real);
  assert.ok(r, "should recognize the process-death signature");
  assert.equal(r.category, "process_death");
  assert.equal(r.fatal, true);
});

test("recognizeError: permission denied — REAL captured tool_result (this campaign)", () => {
  const real = "Permission to use Bash with command cd /Users/Able/keralora/apps/web && cat .env.local has been denied.";
  const r = recognizeError(real);
  assert.ok(r, "should recognize permission denial");
  assert.equal(r.category, "permission_denied");
  assert.equal(r.fatal, false);
});

test("recognizeError: tool error — REAL captured tool_result (this campaign)", () => {
  const real = "File does not exist. Note: your current working directory is /Users/Able/keralora.";
  const r = recognizeError(real);
  assert.ok(r, "should recognize a tool error");
  assert.equal(r.category, "tool_error");
  assert.equal(r.fatal, false);
});

test("recognizeError: session-limit language in plain prose (fallback path, no structured field)", () => {
  const r = recognizeError("I hit the session limit and cannot continue.");
  assert.equal(r.category, "session_limit");
  assert.equal(r.fatal, true);
});

test("recognizeError: EACCES / ENOENT shapes", () => {
  assert.equal(recognizeError("mkdir: /root/protected: Permission denied (EACCES)").category, "permission_denied");
  assert.equal(recognizeError("bash: foo: command not found").category, "tool_error");
  assert.equal(recognizeError("open /tmp/x: no such file or directory (ENOENT)").category, "tool_error");
});

test("recognizeError: ordinary text (not an error) returns null, never throws", () => {
  assert.doesNotThrow(() => {
    assert.equal(recognizeError("All 101 tests passed. Committing now."), null);
    assert.equal(recognizeError("Reading the config file to check current settings."), null);
  });
});

test("recognizeError: ordinary Bash success output containing the word 'error' as prose, not a real error, is not misfired on lightly", () => {
  // "error handling" mentioned in normal text must not false-positive as a tool/process error —
  // none of the recognizer's patterns match generic prose use of the word "error".
  assert.equal(recognizeError("Added error handling to the webhook route per the error-resilience rule."), null);
});

test("recognizeError: null/undefined/empty input returns null, never throws", () => {
  assert.doesNotThrow(() => {
    assert.equal(recognizeError(null), null);
    assert.equal(recognizeError(undefined), null);
    assert.equal(recognizeError(""), null);
    assert.equal(recognizeError({}), null);
  });
});
