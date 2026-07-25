import { test } from "node:test";
import assert from "node:assert/strict";
import { isRedFlag } from "../lib/red-flags.mjs";

test("isRedFlag: death kind is always a red flag", () => {
  assert.equal(isRedFlag({ kind: "death" }), true);
});

test("isRedFlag: error kind is always a red flag", () => {
  assert.equal(isRedFlag({ kind: "error" }), true);
});

test("isRedFlag: command_destructive kind is always a red flag", () => {
  assert.equal(isRedFlag({ kind: "command_destructive" }), true);
});

test("isRedFlag: test_result WITH failures is a red flag", () => {
  assert.equal(isRedFlag({ kind: "test_result", failed: 3, passed: 10 }), true);
});

test("isRedFlag: test_result with ZERO failures is NOT a red flag", () => {
  assert.equal(isRedFlag({ kind: "test_result", failed: 0, passed: 88 }), false);
});

test("isRedFlag: ordinary kinds (tool_use, commit, ack) are not red flags", () => {
  assert.equal(isRedFlag({ kind: "tool_use" }), false);
  assert.equal(isRedFlag({ kind: "commit" }), false);
  assert.equal(isRedFlag({ kind: "ack" }), false);
});

test("isRedFlag: malformed/missing input never throws, defaults to false", () => {
  assert.doesNotThrow(() => {
    assert.equal(isRedFlag(null), false);
    assert.equal(isRedFlag(undefined), false);
    assert.equal(isRedFlag({}), false);
    assert.equal(isRedFlag({ kind: "not_a_real_kind" }), false);
  });
});
