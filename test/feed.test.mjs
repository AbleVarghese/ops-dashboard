// v3.1 Stage 4 tests — lib/feed.mjs's new red-flag tagging + cross-source linking + injectEvent.
// Uses a nonexistent-path "project" (resolveProject degrades to claudeProjectDirExists:false /
// gitDirExists:false, same graceful-degradation contract every watcher here already documents) so
// start() safely arms zero real fs watchers — this test drives the pipeline directly via
// injectEvent rather than depending on real file activity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProjectFeed } from "../lib/feed.mjs";
import { resolveProject } from "../lib/paths.mjs";

const NOOP_PROJECT = resolveProject("/tmp/opsdash-feed-test-nonexistent-project");
const CONFIG = { feed: { debounceMs: 10, bufferMax: 50 }, watchedReportFiles: [] };

test("createProjectFeed: injectEvent tags redFlag:true on a death event", () => {
  const feed = createProjectFeed();
  const received = [];
  feed.start(NOOP_PROJECT, CONFIG, (e) => received.push(e));
  feed.injectEvent({ ts: new Date().toISOString(), agent: "x", kind: "death", summary: "session limit" });
  assert.equal(received.length, 1);
  assert.equal(received[0].redFlag, true);
  feed.stop();
});

test("createProjectFeed: injectEvent tags redFlag:false on an ordinary event", () => {
  const feed = createProjectFeed();
  const received = [];
  feed.start(NOOP_PROJECT, CONFIG, (e) => received.push(e));
  feed.injectEvent({ ts: new Date().toISOString(), agent: "x", kind: "tool_use", summary: "ran ls" });
  assert.equal(received[0].redFlag, false);
  feed.stop();
});

test("createProjectFeed: a commit shortly after a passing test_result gets verifiedBy attached (cross-source link)", () => {
  const feed = createProjectFeed();
  const received = [];
  feed.start(NOOP_PROJECT, CONFIG, (e) => received.push(e));
  const t0 = Date.now();
  feed.injectEvent({ ts: new Date(t0).toISOString(), agent: "x", kind: "test_result", failed: 0, passed: 88, summary: "node:test: 88 passed, 0 failed" });
  feed.injectEvent({ ts: new Date(t0 + 60000).toISOString(), agent: "git", kind: "commit", summary: "feat: wire recognizers" });
  assert.equal(received.length, 2);
  assert.ok(received[1].verifiedBy, "commit should carry a verifiedBy link");
  assert.match(received[1].verifiedBy.summary, /88 passed/);
  feed.stop();
});

test("createProjectFeed: a commit with NO recent passing test does not get verifiedBy", () => {
  const feed = createProjectFeed();
  const received = [];
  feed.start(NOOP_PROJECT, CONFIG, (e) => received.push(e));
  feed.injectEvent({ ts: new Date().toISOString(), agent: "git", kind: "commit", summary: "chore: bump version" });
  assert.equal(received[0].verifiedBy, undefined);
  feed.stop();
});

test("createProjectFeed: a commit is NOT linked to a FAILING test_result", () => {
  const feed = createProjectFeed();
  const received = [];
  feed.start(NOOP_PROJECT, CONFIG, (e) => received.push(e));
  const t0 = Date.now();
  feed.injectEvent({ ts: new Date(t0).toISOString(), agent: "x", kind: "test_result", failed: 3, passed: 5, summary: "3 failed" });
  feed.injectEvent({ ts: new Date(t0 + 1000).toISOString(), agent: "git", kind: "commit", summary: "wip" });
  assert.equal(received[1].verifiedBy, undefined);
  feed.stop();
});

test("createProjectFeed: a commit OUTSIDE the link window is not linked", () => {
  const feed = createProjectFeed();
  const received = [];
  feed.start(NOOP_PROJECT, CONFIG, (e) => received.push(e));
  const t0 = Date.now();
  feed.injectEvent({ ts: new Date(t0).toISOString(), agent: "x", kind: "test_result", failed: 0, passed: 10, summary: "10 passed" });
  feed.injectEvent({ ts: new Date(t0 + 20 * 60 * 1000).toISOString(), agent: "git", kind: "commit", summary: "unrelated, 20min later" }); // beyond the 15min window
  assert.equal(received[1].verifiedBy, undefined);
  feed.stop();
});

test("createProjectFeed: injectEvent is a safe no-op when the feed isn't running", () => {
  const feed = createProjectFeed();
  assert.doesNotThrow(() => feed.injectEvent({ kind: "death" }));
});

test("createProjectFeed: events still land in the ring buffer via injectEvent (replay-on-reconnect works for injected events too)", () => {
  const feed = createProjectFeed();
  feed.start(NOOP_PROJECT, CONFIG, () => {});
  feed.injectEvent({ ts: new Date().toISOString(), agent: "control", kind: "control", summary: "pause_campaign" });
  const recent = feed.getRecentFeedEvents();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].kind, "control");
  feed.stop();
});
