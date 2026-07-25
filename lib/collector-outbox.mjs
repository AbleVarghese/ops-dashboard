// Bounded, disk-backed outbound queue for collector.mjs — the mechanism behind "a network blip
// loses ZERO events." Every item the collector wants to send to the hub is appended here FIRST
// (durable on disk before any network attempt), then drained in order as the hub accepts it. A
// crash or restart resumes from the on-disk file rather than the in-memory state that died with
// the process — that's the "resume cursor."
//
// Ring semantics: bounded by item COUNT (maxItems). If the hub is unreachable long enough that the
// queue fills, the OLDEST unsent items are dropped (never the newest — a live dashboard cares more
// about "what's happening now" than "what happened during a 2-hour outage") and a single synthetic
// `queue_overflow` marker item is enqueued in their place so the hub/operator can see data was
// lost, honestly, rather than silently gapping the feed.
//
// Zero deps, Node built-ins only, one file per queue instance (one collector process => one file).
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_ITEMS = 5000;

/** `filePath`: where the NDJSON outbox lives (one JSON object per line: {seq, item}). Loads any
 * unsent items left over from a prior run (crash/restart resume) on construction. */
export function createOutbox(filePath, { maxItems = DEFAULT_MAX_ITEMS } = {}) {
  let nextSeq = 1;
  let queue = []; // [{ seq, item }], oldest first, always sorted by seq
  let droppedTotal = 0;

  function loadFromDisk() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return; // no prior file — fresh start, seq starts at 1
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (typeof rec.seq === "number" && rec.item) {
          queue.push(rec);
          if (rec.seq >= nextSeq) nextSeq = rec.seq + 1;
        }
      } catch {
        // one corrupt line (e.g. a torn write mid-crash) — skip it, keep the rest; never let one
        // bad line lose the whole resumed queue
      }
    }
  }
  loadFromDisk();

  /** Rewrites the on-disk file to exactly match the in-memory queue — the compaction step that
   * keeps the file from growing forever as items are acked. Best-effort: a write failure here
   * doesn't lose in-memory state, only risks re-sending already-acked items after a crash (safe —
   * the hub's ingest is idempotent-enough for a live feed: a duplicate event just renders twice,
   * never corrupts state). */
  function persist() {
    try {
      const body = queue.map((rec) => JSON.stringify(rec)).join("\n");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, body.length ? `${body}\n` : "", "utf8");
    } catch {
      // disk full / permission issue — the in-memory queue is still correct; next successful
      // persist() call (e.g. after the next ack) will catch the file back up
    }
  }

  /** Adds `item` to the queue, persists durably, and enforces the bounded-ring cap. Returns the
   * assigned seq number. */
  function enqueue(item) {
    const seq = nextSeq++;
    queue.push({ seq, item });
    if (queue.length > maxItems) {
      const overflowBy = queue.length - maxItems;
      queue.splice(0, overflowBy);
      droppedTotal += overflowBy;
      queue.unshift({
        seq: queue[0] ? queue[0].seq - 0.5 : seq - 0.5, // sorts before the next real item without colliding
        item: { type: "queue_overflow", droppedCount: overflowBy, droppedTotal, ts: new Date().toISOString() },
      });
    }
    persist();
    return seq;
  }

  /** Up to `limit` oldest not-yet-acked items, `[{seq, item}]`, for a send attempt. Does not
   * remove them — call ack() only after the hub confirms receipt. */
  function peek(limit = 200) {
    return queue.slice(0, limit);
  }

  /** Removes every item with seq <= `uptoSeq` (the hub's cumulative ack) and compacts to disk. */
  function ack(uptoSeq) {
    const before = queue.length;
    queue = queue.filter((rec) => rec.seq > uptoSeq);
    if (queue.length !== before) persist();
  }

  function size() {
    return queue.length;
  }

  function stats() {
    return { pending: queue.length, droppedTotal, maxItems, oldestSeq: queue.length ? queue[0].seq : null };
  }

  return { enqueue, peek, ack, size, stats };
}
