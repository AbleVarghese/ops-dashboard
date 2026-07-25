// v3.2 collector/hub split — lib/collector-outbox.mjs's durability guarantees: enqueue-before-send,
// bounded ring with honest overflow marking, ack-based compaction, and crash/restart resume from
// disk (the mechanism behind "a network blip loses ZERO events").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutbox } from "../lib/collector-outbox.mjs";

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "opsdash-outbox-")), name);
}

test("createOutbox: enqueue then peek returns items in seq order", () => {
  const ob = createOutbox(tmpFile("q.ndjson"));
  ob.enqueue({ a: 1 });
  ob.enqueue({ a: 2 });
  ob.enqueue({ a: 3 });
  const peeked = ob.peek(10);
  assert.deepEqual(peeked.map((r) => r.item.a), [1, 2, 3]);
  assert.equal(ob.size(), 3);
});

test("createOutbox: ack removes only items up to and including the given seq", () => {
  const ob = createOutbox(tmpFile("q.ndjson"));
  const s1 = ob.enqueue({ a: 1 });
  const s2 = ob.enqueue({ a: 2 });
  ob.enqueue({ a: 3 });
  ob.ack(s2);
  const remaining = ob.peek(10);
  assert.deepEqual(remaining.map((r) => r.item.a), [3]);
  assert.equal(s1 < s2, true);
});

test("createOutbox: resumes pending items from disk after a simulated crash (new instance, same file)", () => {
  const file = tmpFile("q.ndjson");
  const first = createOutbox(file);
  first.enqueue({ event: "one" });
  first.enqueue({ event: "two" });
  // No ack() called — simulates a crash before the hub confirmed receipt. A brand-new outbox
  // instance pointed at the SAME file (as a restarted collector process would do) must see both
  // items still pending — this is the "resume cursor" the network-blip guarantee depends on.
  const resumed = createOutbox(file);
  const pending = resumed.peek(10);
  assert.deepEqual(pending.map((r) => r.item.event), ["one", "two"]);
});

test("createOutbox: acked items do not reappear after a resume (compaction persisted)", () => {
  const file = tmpFile("q.ndjson");
  const first = createOutbox(file);
  const seq = first.enqueue({ event: "will-be-acked" });
  first.enqueue({ event: "still-pending" });
  first.ack(seq);
  const resumed = createOutbox(file);
  const pending = resumed.peek(10);
  assert.deepEqual(pending.map((r) => r.item.event), ["still-pending"]);
});

test("createOutbox: a corrupt line in the resume file is skipped, not fatal (degrade gracefully)", () => {
  const file = tmpFile("q.ndjson");
  const first = createOutbox(file);
  first.enqueue({ event: "good-one" });
  fs.appendFileSync(file, "{not valid json\n");
  first.enqueue({ event: "good-two" });
  const resumed = createOutbox(file);
  const events = resumed.peek(10).map((r) => r.item.event);
  assert.ok(events.includes("good-one"));
  assert.ok(events.includes("good-two"));
});

test("createOutbox: bounded ring drops the OLDEST items on overflow and marks the drop honestly", () => {
  const ob = createOutbox(tmpFile("q.ndjson"), { maxItems: 3 });
  ob.enqueue({ n: 1 });
  ob.enqueue({ n: 2 });
  ob.enqueue({ n: 3 });
  ob.enqueue({ n: 4 }); // over the cap — should drop n:1, insert an overflow marker
  const items = ob.peek(10).map((r) => r.item);
  const overflowMarker = items.find((i) => i.type === "queue_overflow");
  assert.ok(overflowMarker, "expected a queue_overflow marker item");
  assert.equal(overflowMarker.droppedCount, 1);
  assert.ok(!items.some((i) => i.n === 1), "the oldest item (n:1) should have been dropped");
  assert.ok(items.some((i) => i.n === 4), "the newest item (n:4) must survive — never drop the newest");
});

test("createOutbox: stats() reports pending count and dropped total", () => {
  const ob = createOutbox(tmpFile("q.ndjson"), { maxItems: 2 });
  ob.enqueue({ n: 1 });
  ob.enqueue({ n: 2 });
  ob.enqueue({ n: 3 }); // drops n:1
  const stats = ob.stats();
  assert.equal(stats.maxItems, 2);
  assert.equal(stats.droppedTotal, 1);
});
