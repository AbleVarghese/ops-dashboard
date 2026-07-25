// v3.2 collector/hub split — lib/hub.mjs's ingest state: heartbeat/snapshot/events handling,
// offline detection from missed heartbeats, and defense-in-depth secret-stripping on the ingest
// path (owner directive: "secret-strip on ingest paths too").
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHub } from "../lib/hub.mjs";

test("createHub: ingestSnapshot stores a project, getRemoteProjectsState reflects it as source:remote", () => {
  const hub = createHub();
  hub.ingestSnapshot({
    collectorId: "c1",
    ts: new Date().toISOString(),
    projects: [{ key: "proj-a", name: "Project A", repoPath: "/x/a", board: { agents: [] } }],
  });
  const remote = hub.getRemoteProjectsState();
  assert.equal(remote.length, 1);
  assert.equal(remote[0].key, "proj-a");
  assert.equal(remote[0].source, "remote");
  assert.equal(remote[0].board.collectorOffline, false);
});

test("createHub: a project with no heartbeat yet still resolves offline from receivedAt (never crashes on an unknown collector)", () => {
  const hub = createHub({ offlineThresholdMs: 10 });
  hub.ingestSnapshot({ collectorId: "c1", projects: [{ key: "p", name: "P", repoPath: "/p", board: { agents: [] } }] });
  return new Promise((resolve) => {
    setTimeout(() => {
      const [p] = hub.getRemoteProjectsState();
      assert.equal(p.board.collectorOffline, true);
      assert.ok(p.board.collectorOfflineMs >= 10);
      resolve();
    }, 30);
  });
});

test("createHub: a fresh heartbeat clears offline status for every project that collector owns", () => {
  const hub = createHub({ offlineThresholdMs: 50 });
  hub.ingestSnapshot({ collectorId: "c1", projects: [{ key: "p", name: "P", repoPath: "/p", board: { agents: [] } }] });
  hub.ingestHeartbeat({ collectorId: "c1", projectKeys: ["p"] });
  const [p] = hub.getRemoteProjectsState();
  assert.equal(p.board.collectorOffline, false);
});

test("createHub: last-known board data is NEVER deleted when a collector goes offline — only flagged", () => {
  const hub = createHub({ offlineThresholdMs: 1 });
  hub.ingestSnapshot({ collectorId: "c1", projects: [{ key: "p", name: "P", repoPath: "/p", board: { agents: [{ name: "agent-x" }] } }] });
  return new Promise((resolve) => {
    setTimeout(() => {
      const [p] = hub.getRemoteProjectsState();
      assert.equal(p.board.collectorOffline, true);
      assert.equal(p.board.agents.length, 1, "stale board data must still be present, not hidden");
      assert.equal(p.board.agents[0].name, "agent-x");
      resolve();
    }, 10);
  });
});

test("createHub: ingestEvents forwards each event through onFeedEvent and stores it in the feed ring", () => {
  const received = [];
  const hub = createHub({ onFeedEvent: (e) => received.push(e) });
  hub.ingestEvents({ collectorId: "c1", items: [{ seq: 1, event: { ts: "2026-01-01T00:00:00.000Z", agent: "a", kind: "text", summary: "hello" } }] });
  assert.equal(received.length, 1);
  assert.equal(hub.getRecentFeed(10).length, 1);
});

test("createHub: ingestEvents re-sanitizes event summaries (defense in depth on the ingest path)", () => {
  const received = [];
  const hub = createHub({ onFeedEvent: (e) => received.push(e) });
  hub.ingestEvents({
    collectorId: "c1",
    items: [{ seq: 1, event: { ts: "2026-01-01T00:00:00.000Z", agent: "a", kind: "text", summary: 'api_key: "sk_live_abcdef1234567890"' } }],
  });
  assert.ok(!received[0].summary.includes("sk_live_abcdef1234567890"), "a secret-shaped string must be redacted even though the collector should already have sanitized it");
});

test("createHub: ingestEvents skips malformed items instead of throwing", () => {
  const hub = createHub();
  const result = hub.ingestEvents({ collectorId: "c1", items: [null, { seq: 1, event: { ts: "x", kind: "text", summary: "ok" } }, 42, { seq: "not-a-number" }] });
  assert.equal(result.accepted, 1);
});

test("createHub: ingestEvents rejects a kind that isn't in the reviewed EVENT_KIND_NAMES set (security item #4)", () => {
  const received = [];
  const hub = createHub({ onFeedEvent: (e) => received.push(e) });
  const result = hub.ingestEvents({
    collectorId: "c1",
    items: [
      { seq: 1, event: { ts: "x", kind: "totally_made_up_kind", summary: "should be refused" } },
      { seq: 2, event: { ts: "x", kind: "text", summary: "a real kind" } },
    ],
  });
  assert.equal(result.accepted, 1);
  assert.equal(result.rejectedKind, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].summary, "a real kind");
});

test("createHub: ingestEvents dedupes a retried batch by seq — idempotent under a lost-response resend (security item #6)", () => {
  const received = [];
  const hub = createHub({ onFeedEvent: (e) => received.push(e) });
  const batch = { collectorId: "c1", items: [{ seq: 1, event: { ts: "x", kind: "text", summary: "one" } }, { seq: 2, event: { ts: "x", kind: "text", summary: "two" } }] };
  const first = hub.ingestEvents(batch);
  assert.equal(first.accepted, 2);
  assert.equal(first.deduped, 0);
  // Simulate the collector never seeing the 2xx (response lost) and resending the SAME batch.
  const retry = hub.ingestEvents(batch);
  assert.equal(retry.accepted, 0);
  assert.equal(retry.deduped, 2);
  assert.equal(received.length, 2, "the duplicate resend must not double-broadcast into the feed");
});

test("createHub: ingestEvents accepts NEW seqs after a partial dedupe (a batch overlapping already-processed items)", () => {
  const hub = createHub();
  hub.ingestEvents({ collectorId: "c1", items: [{ seq: 1, event: { ts: "x", kind: "text", summary: "one" } }] });
  const result = hub.ingestEvents({
    collectorId: "c1",
    items: [
      { seq: 1, event: { ts: "x", kind: "text", summary: "one (resent)" } },
      { seq: 2, event: { ts: "x", kind: "text", summary: "two (new)" } },
    ],
  });
  assert.equal(result.accepted, 1);
  assert.equal(result.deduped, 1);
});

test("createHub: dedupe is scoped per collector — two collectors can both legitimately use seq 1", () => {
  const received = [];
  const hub = createHub({ onFeedEvent: (e) => received.push(e) });
  hub.ingestEvents({ collectorId: "c1", items: [{ seq: 1, event: { ts: "x", kind: "text", summary: "from c1" } }] });
  hub.ingestEvents({ collectorId: "c2", items: [{ seq: 1, event: { ts: "x", kind: "text", summary: "from c2" } }] });
  assert.equal(received.length, 2);
});

test("createHub: listCollectors reports offline status per collector", () => {
  const hub = createHub({ offlineThresholdMs: 5 });
  hub.ingestHeartbeat({ collectorId: "c1", projectKeys: ["p"] });
  return new Promise((resolve) => {
    setTimeout(() => {
      const list = hub.listCollectors();
      assert.equal(list.length, 1);
      assert.equal(list[0].collectorId, "c1");
      assert.equal(list[0].offline, true);
      resolve();
    }, 20);
  });
});

test("createHub: ingestHeartbeat/ingestSnapshot/ingestEvents reject a missing collectorId", () => {
  const hub = createHub();
  assert.throws(() => hub.ingestHeartbeat({}));
  assert.throws(() => hub.ingestSnapshot({ projects: [] }));
  assert.throws(() => hub.ingestEvents({ items: [] }));
});
