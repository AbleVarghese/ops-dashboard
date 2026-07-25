// v3.2 — stalledFrom() was extracted out of buildUnifiedState() as the SSOT for "needs attention"
// classification, so server.mjs's hub-merge path (buildFullState) can apply the identical rule to
// remote/collector-sourced projects without hand-duplicating the state-name list a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stalledFrom } from "../lib/project-manager.mjs";

function project(key, agents) {
  return { key, name: key, enabled: true, board: { agents } };
}

test("stalledFrom: includes possibly_stuck, stopped, and orphaned agents", () => {
  const projects = [
    project("p1", [
      { name: "a", state: "possibly_stuck", quietMs: 300000 },
      { name: "b", state: "working", quietMs: 1000 },
      { name: "c", state: "stopped", quietMs: 500000 },
      { name: "d", state: "orphaned", quietMs: 90000000 },
      { name: "e", state: "done", quietMs: 2000 },
    ]),
  ];
  const stalled = stalledFrom(projects);
  assert.equal(stalled.length, 3);
  assert.deepEqual(
    stalled.map((s) => s.agentName),
    ["d", "c", "a"] // sorted by quietMs descending
  );
});

test("stalledFrom: an empty project list yields an empty result", () => {
  assert.deepEqual(stalledFrom([]), []);
});

test("stalledFrom: a project with no agents at all is handled gracefully", () => {
  assert.deepEqual(stalledFrom([{ key: "p", name: "p", board: {} }]), []);
});
