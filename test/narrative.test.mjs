// Unit tests for the M2 novice-test narrative strip — the plain-English "which projects / who's
// working / on what / what happened / is anything broken" sentence shown at the top of every tab.
//
// v3.1 Stage 3: updated for the 8-state taxonomy (was v3.0's 5-state live/building/verifying/
// stalled/idle). Per no-drift discipline — the REQUIREMENT intentionally changed (owner directive),
// so these tests are updated to the new requirement, not left red or silently deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNarrative } from "../lib/narrative.mjs";

test("buildNarrative: no projects configured -> the empty-state sentence", () => {
  const text = buildNarrative([]);
  assert.match(text, /no projects configured/i);
});

test("buildNarrative: null projects -> the empty-state sentence (defensive)", () => {
  const text = buildNarrative(null);
  assert.match(text, /no projects configured/i);
});

test("buildNarrative: no agents at all -> says so explicitly, doesn't crash", () => {
  const text = buildNarrative([{ key: "p1", name: "demo", board: { agents: [] } }]);
  assert.match(text, /no agent is active/i);
  assert.match(text, /nothing needs attention/i);
});

test("buildNarrative: one WORKING agent -> named, with its last-action summary, age, and the right verb", () => {
  const projects = [
    {
      key: "p1",
      name: "demo",
      board: {
        agents: [{ name: "builder-1", state: "working", quietMs: 2000, lastAction: { summary: "Edit: src/x.ts" } }],
      },
    },
  ];
  const text = buildNarrative(projects);
  assert.match(text, /demo/);
  assert.match(text, /builder-1/);
  assert.match(text, /is working/);
  assert.match(text, /Edit: src\/x\.ts/);
});

test("buildNarrative: COMPOSING gets its own verb, distinct from working", () => {
  const projects = [{ key: "p1", name: "demo", board: { agents: [{ name: "thinker", state: "composing", quietMs: 2000, lastAction: null }] } }];
  const text = buildNarrative(projects);
  assert.match(text, /thinker is composing a response/);
});

test("buildNarrative: WAITING gets its own verb", () => {
  const projects = [{ key: "p1", name: "demo", board: { agents: [{ name: "waiter", state: "waiting", quietMs: 60000, lastAction: { summary: "waiting — Waiting on the build to finish" } }] } }];
  const text = buildNarrative(projects);
  assert.match(text, /waiter is waiting/);
});

test("buildNarrative: picks the LEAST-quiet active agent as the lead across multiple projects", () => {
  const projects = [
    { key: "p1", name: "alpha", board: { agents: [{ name: "slow-agent", state: "working", quietMs: 50000, lastAction: null }] } },
    { key: "p2", name: "beta", board: { agents: [{ name: "fast-agent", state: "working", quietMs: 500, lastAction: null }] } },
  ];
  const text = buildNarrative(projects);
  assert.match(text, /fast-agent/);
  assert.doesNotMatch(text, /slow-agent/);
});

test("buildNarrative: surfaces up to 3 problem agents (possibly_stuck + orphaned), sorted by longest-quiet first, each with the right verb", () => {
  const projects = [
    {
      key: "p1",
      name: "demo",
      board: {
        agents: [
          { name: "a", state: "possibly_stuck", quietMs: 400000, lastAction: null },
          { name: "b", state: "orphaned", quietMs: 900000, lastAction: null },
          { name: "c", state: "possibly_stuck", quietMs: 600000, lastAction: null },
        ],
      },
    },
  ];
  const text = buildNarrative(projects);
  assert.match(text, /3 agents need a look/i);
  assert.match(text, /b \(demo, presumed dead/); // orphaned gets "presumed dead", not "may be stuck"
  assert.match(text, /a \(demo, may be stuck/);
  // "b" (900000ms quiet) is the longest-quiet and must appear first in the list.
  const bIdx = text.indexOf("b (");
  const aIdx = text.indexOf("a (");
  assert.ok(bIdx > -1 && aIdx > -1 && bIdx < aIdx, "longest-quiet problem agent should be listed first");
});

test("buildNarrative: reports a tag milestone from the newest-tagged project when git data is present", () => {
  const projects = [
    {
      key: "p1",
      name: "demo",
      board: {
        agents: [],
        campaign: { git: { available: true, tags: [{ name: "v1.2.0", date: "2026-07-24", subject: "release" }] } },
      },
    },
  ];
  const text = buildNarrative(projects);
  assert.match(text, /Last milestone: tag v1\.2\.0 in demo/);
});

test("buildNarrative: never throws when a project has no board at all (defensive against partial state)", () => {
  assert.doesNotThrow(() => buildNarrative([{ key: "p1", name: "broken" }]));
});

test('buildNarrative: with no active agent but a recently-DONE one, names it as "finished" rather than falling back to "no agent is active"', () => {
  const projects = [
    {
      key: "p1",
      name: "keralora",
      board: { agents: [{ name: "build-dashboard3", state: "done", quietMs: 360000, lastAction: null }] },
    },
  ];
  const text = buildNarrative(projects);
  assert.match(text, /build-dashboard3 finished its task in keralora, 6m ago/);
  assert.doesNotMatch(text, /no agent is active/i);
});

test("buildNarrative: a done agent is never counted in the problems list", () => {
  const projects = [{ key: "p1", name: "demo", board: { agents: [{ name: "a", state: "done", quietMs: 400000, lastAction: null }] } }];
  const text = buildNarrative(projects);
  assert.match(text, /nothing needs attention/i);
});

test("buildNarrative: a STOPPED agent leads when there's no active or done agent, with its evidence quoted", () => {
  const projects = [
    {
      key: "p1",
      name: "demo",
      board: { agents: [{ name: "victim", state: "stopped", quietMs: 100000, lastAction: null, evidence: 'session-ending language: "session limit"' }] },
    },
  ];
  const text = buildNarrative(projects);
  assert.match(text, /victim was stopped/);
  assert.match(text, /session limit/);
});

test("buildNarrative: a PAUSED agent leads when there's no active/done/stopped agent", () => {
  const projects = [{ key: "p1", name: "demo", board: { agents: [{ name: "resting", state: "paused", quietMs: 100000, lastAction: null }] } }];
  const text = buildNarrative(projects);
  assert.match(text, /resting is paused in demo/);
});

test("buildNarrative: priority order — an active agent leads even when a done/stopped/paused agent also exists", () => {
  const projects = [
    {
      key: "p1",
      name: "demo",
      board: {
        agents: [
          { name: "worker", state: "working", quietMs: 500, lastAction: null },
          { name: "finisher", state: "done", quietMs: 100, lastAction: null },
          { name: "victim", state: "stopped", quietMs: 100, lastAction: null },
        ],
      },
    },
  ];
  const text = buildNarrative(projects);
  assert.match(text, /worker is working/);
  assert.doesNotMatch(text, /finisher finished/);
});
