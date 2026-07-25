import { test } from "node:test";
import assert from "node:assert/strict";
import { getKanbanBoard } from "../lib/kanban.mjs";

const COLUMNS = ["Queued", "In Progress", "Verifying", "Done"];

function phaseTable(rows) {
  return { headers: ["#", "Item", "Owner", "Status", "Why", "Next"], rows };
}

test("getKanbanBoard: a row with a currently-active owner lands in Verifying with a W-record", () => {
  const reportsData = { phaseTable: phaseTable([["1", "Build the thing", "`build-x`", "🟡 in progress", "mid-build", "finish it"]]) };
  const agents = [{ name: "build-x", active: true, state: "working", models: ["sonnet"], evidence: "last tool call 3s ago: Edit", quietMs: 3000 }];
  const board = getKanbanBoard({ repoPath: "/tmp/nope" }, reportsData, agents, COLUMNS);
  assert.equal(board.cards.length, 1);
  const card = board.cards[0];
  assert.equal(card.column, "Verifying");
  assert.deepEqual(card.activeAgents, ["build-x"]);
  assert.equal(card.stalled, false);
  assert.equal(card.ownerRecords.length, 1);
  assert.equal(card.ownerRecords[0].name, "build-x");
  assert.deepEqual(card.ownerRecords[0].models, ["sonnet"]);
  assert.equal(card.ownerRecords[0].state, "working");
  assert.equal(card.ownerRecords[0].quietMs, 3000);
});

test("getKanbanBoard: a row whose owner is possibly_stuck is flagged stalled with an ownerRecord even though inactive", () => {
  const reportsData = { phaseTable: phaseTable([["1", "Fix the bug", "`build-y`", "🟡 in progress", "stuck", "unblock"]]) };
  const agents = [{ name: "build-y", active: false, state: "possibly_stuck", models: ["opus"], evidence: "quiet 6m, mid-task", quietMs: 360000 }];
  const board = getKanbanBoard({ repoPath: "/tmp/nope" }, reportsData, agents, COLUMNS);
  const card = board.cards[0];
  assert.equal(card.stalled, true);
  assert.deepEqual(card.stalledAgents, ["build-y"]);
  assert.deepEqual(card.activeAgents, []);
  assert.equal(card.ownerRecords[0].state, "possibly_stuck");
});

test("getKanbanBoard: an owner named on the row with NO matching agent transcript gets an honest n/a-shaped record, not a crash", () => {
  const reportsData = { phaseTable: phaseTable([["1", "Ghost task", "`nobody-here`", "🔴 queued", "", ""]]) };
  const board = getKanbanBoard({ repoPath: "/tmp/nope" }, reportsData, [], COLUMNS);
  const card = board.cards[0];
  assert.equal(card.ownerRecords.length, 1);
  assert.equal(card.ownerRecords[0].name, "nobody-here");
  assert.equal(card.ownerRecords[0].evidence, null);
  assert.equal(card.ownerRecords[0].state, null);
  assert.deepEqual(card.ownerRecords[0].models, []);
});

test("getKanbanBoard: a done row maps to Done regardless of agent state", () => {
  const reportsData = { phaseTable: phaseTable([["1", "Shipped feature", "`build-z`", "✅ done", "", ""]]) };
  const agents = [{ name: "build-z", active: false, state: "done", models: ["sonnet"], evidence: "sign-off", quietMs: 90000 }];
  const board = getKanbanBoard({ repoPath: "/tmp/nope" }, reportsData, agents, COLUMNS);
  assert.equal(board.cards[0].column, "Done");
  assert.equal(board.cards[0].stalled, false);
});

test("getKanbanBoard: empty/missing phase table degrades to zero cards, never throws", () => {
  assert.deepEqual(getKanbanBoard({ repoPath: "/tmp/nope" }, {}, [], COLUMNS).cards, []);
  assert.deepEqual(getKanbanBoard({ repoPath: "/tmp/nope" }, { phaseTable: null }, [], COLUMNS).cards, []);
});
