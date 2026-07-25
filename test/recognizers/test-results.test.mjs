// v3.1 Stage 4 tests — test-result recognition, per the correctness law's "prove it with real
// fixtures" discipline. The node:test fixture below is a REAL captured sample from THIS project's
// own `npm test` run this session (not reconstructed from memory) — see the comment on that test.
// The other frameworks use each tool's own documented default-reporter summary line shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recognizeTestResult } from "../../lib/recognizers/test-results.mjs";

test("recognizeTestResult: node:test — REAL captured output from this project's own `npm test`, this session", () => {
  // Captured verbatim via `npm test 2>&1 | tail -12` immediately before writing this test — not
  // reconstructed from memory, an actual real sample from this exact codebase's test runner.
  const real = `  duration_ms: 31.228433
  type: 'test'
  ...
1..88
# tests 88
# suites 0
# pass 88
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9383.947948`;
  const r = recognizeTestResult(real);
  assert.ok(r, "should recognize node:test output");
  assert.equal(r.framework, "node:test");
  assert.equal(r.total, 88);
  assert.equal(r.passed, 88);
  assert.equal(r.failed, 0);
});

test("recognizeTestResult: node:test with real failures", () => {
  const text = `1..40\n# tests 40\n# suites 0\n# pass 37\n# fail 3\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 512.3`;
  const r = recognizeTestResult(text);
  assert.equal(r.framework, "node:test");
  assert.equal(r.total, 40);
  assert.equal(r.passed, 37);
  assert.equal(r.failed, 3);
});

test("recognizeTestResult: vitest default reporter summary", () => {
  const text = ` Test Files  12 passed (12)\n      Tests  145 passed | 3 skipped (148)\n   Start at  10:23:45\n   Duration  4.32s`;
  const r = recognizeTestResult(text);
  assert.ok(r, "should recognize vitest output");
  assert.equal(r.framework, "vitest");
  assert.equal(r.passed, 145);
  assert.equal(r.skipped, 3);
  assert.equal(r.total, 148);
});

test("recognizeTestResult: vitest with failures", () => {
  // Vitest's real default-reporter order is always "N passed" first, then "N failed", then
  // "N skipped" — the regex (and this fixture) matches that real, fixed order.
  const text = `      Tests  143 passed | 2 failed | 3 skipped (148)`;
  const r = recognizeTestResult(text);
  assert.ok(r, "should recognize vitest output with failures");
  assert.equal(r.framework, "vitest");
  assert.equal(r.passed, 143);
  assert.equal(r.failed, 2);
  assert.equal(r.skipped, 3);
});

test("recognizeTestResult: jest default reporter summary", () => {
  const text = `Tests:       2 failed, 1 skipped, 145 passed, 148 total\nTest Suites: 1 failed, 11 passed, 12 total\nSnapshots:   0 total\nTime:        5.234 s`;
  const r = recognizeTestResult(text);
  assert.ok(r, "should recognize jest output");
  assert.equal(r.framework, "jest");
  assert.equal(r.passed, 145);
  assert.equal(r.failed, 2);
  assert.equal(r.skipped, 1);
  assert.equal(r.total, 148);
});

test("recognizeTestResult: jest all-passing (no failed/skipped segments)", () => {
  const text = `Tests:       88 passed, 88 total\nTime:        1.2 s`;
  const r = recognizeTestResult(text);
  assert.equal(r.framework, "jest");
  assert.equal(r.passed, 88);
  assert.equal(r.failed, 0);
  assert.equal(r.total, 88);
});

test("recognizeTestResult: playwright default summary, all passing", () => {
  const text = `Running 15 tests using 3 workers\n\n  15 passed (12.3s)`;
  const r = recognizeTestResult(text);
  assert.ok(r, "should recognize playwright output");
  assert.equal(r.framework, "playwright");
  assert.equal(r.passed, 15);
  assert.equal(r.failed, 0);
});

test("recognizeTestResult: playwright with failures", () => {
  const text = `  2 failed\n    tests/example.spec.ts:5:1 › example test\n  13 passed (18.5s)`;
  const r = recognizeTestResult(text);
  assert.ok(r, "should recognize playwright output with failures");
  assert.equal(r.framework, "playwright");
  assert.equal(r.failed, 2);
  assert.equal(r.passed, 13);
});

test("recognizeTestResult: pytest terminal summary, mixed results", () => {
  const text = `===================== 2 failed, 45 passed, 3 skipped in 12.34s ======================`;
  const r = recognizeTestResult(text);
  assert.ok(r, "should recognize pytest output");
  assert.equal(r.framework, "pytest");
  assert.equal(r.passed, 45);
  assert.equal(r.failed, 2);
  assert.equal(r.skipped, 3);
  assert.equal(r.total, 50);
});

test("recognizeTestResult: pytest all-passing", () => {
  const text = `===================== 45 passed in 8.21s ======================`;
  const r = recognizeTestResult(text);
  assert.equal(r.framework, "pytest");
  assert.equal(r.passed, 45);
  assert.equal(r.failed, 0);
  assert.equal(r.total, 45);
});

test("recognizeTestResult: ANSI color codes are stripped before matching (real terminal output has them)", () => {
  // Real node:test output order (confirmed against this project's own captured sample above):
  // "# tests" comes before "# pass" before "# fail" — the fixture below matches that real order.
  const text = `\x1b[36m# tests 88\x1b[0m\n\x1b[32m# pass 88\x1b[0m\n\x1b[31m# fail 0\x1b[0m`;
  const r = recognizeTestResult(text);
  assert.ok(r, "should recognize output even with ANSI codes present");
  assert.equal(r.framework, "node:test");
  assert.equal(r.passed, 88);
});

test("recognizeTestResult: unrecognized text (not a test-output shape) returns null, never throws", () => {
  assert.doesNotThrow(() => {
    const r = recognizeTestResult("just some random Bash output, ls -la, ten files listed");
    assert.equal(r, null);
  });
});

test("recognizeTestResult: empty/null/undefined input returns null, never throws", () => {
  assert.doesNotThrow(() => {
    assert.equal(recognizeTestResult(""), null);
    assert.equal(recognizeTestResult(null), null);
    assert.equal(recognizeTestResult(undefined), null);
  });
});
