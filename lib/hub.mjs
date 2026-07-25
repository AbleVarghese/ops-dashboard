// Hub-mode ingest state (v3.2 collector/hub split). A "collector" is a separate process
// (collector.mjs) running natively on a machine where agents actually work, watching its own local
// projects and POSTing already-enriched feed events + periodic full board snapshots + heartbeats
// to this hub over HTTP(S). The hub never touches those machines' filesystems directly — this
// module is the hub's entire model of "what did collectors tell me."
//
// Multi-MACHINE model: one collector can own several projects (its --project flags); several
// collectors can feed one hub. Each project is owned by exactly one collector at a time (the most
// recent snapshot's collectorId wins — a project re-registering under a new collector, e.g. after
// a collector restart with a new process, simply takes over cleanly).
//
// Defense in depth (owner directive: "secret-strip on ingest paths too"): collector.mjs already
// runs the SAME sanitizeAndTruncate-backed pipeline (feed.mjs/board-state.mjs/reports.mjs/
// git-status.mjs) that a local server.mjs run does, so ingested text is sanitized AT THE SOURCE —
// this is not the only line of defense. This module re-applies sanitizeAndTruncate to every
// incoming event summary anyway, so a buggy or compromised collector forwarding raw text still
// can't leak a secret-shaped string through the hub. Board-snapshot free-text fields (routing/
// control notes/test-run cells) are NOT re-sanitized field-by-field here — that would require
// hand-walking every nested shape board-state.mjs produces (a second copy of knowledge sanitize.mjs
// already encodes, exactly the duplication structural-prevention.md forbids). Stated as an honest
// boundary, not glossed over.
import { sanitizeAndTruncate } from "./sanitize.mjs";
import { EVENT_KIND_NAMES } from "./event-kinds.mjs";

const DEFAULT_OFFLINE_THRESHOLD_MS = 45_000; // 3x the collector's 15s heartbeat interval
const DEFAULT_FEED_RING_MAX = 500; // matches feed.mjs's own default bufferMax
const VALID_KINDS = new Set(EVENT_KIND_NAMES);

export function createHub({ offlineThresholdMs = DEFAULT_OFFLINE_THRESHOLD_MS, feedRingMax = DEFAULT_FEED_RING_MAX, onFeedEvent = () => {} } = {}) {
  const collectors = new Map(); // collectorId -> { lastSeen: ms, projectKeys: string[], firstSeen: ms }
  const remoteProjects = new Map(); // projectKey -> { key, name, repoPath, collectorId, receivedAt, board }
  const lastSeqByCollector = new Map(); // collectorId -> highest seq already processed (idempotency)
  let feedRing = [];

  function touchCollector(collectorId, projectKeys) {
    const now = Date.now();
    const existing = collectors.get(collectorId);
    collectors.set(collectorId, {
      lastSeen: now,
      firstSeen: existing ? existing.firstSeen : now,
      projectKeys: Array.isArray(projectKeys) && projectKeys.length ? projectKeys : existing ? existing.projectKeys : [],
    });
  }

  /** `{ collectorId, projectKeys, ts }` — a bare liveness ping. Never queued/retried by the
   * collector (see collector.mjs) — a missed heartbeat is supposed to show up as offline, not be
   * silently backfilled late. */
  function ingestHeartbeat({ collectorId, projectKeys }) {
    if (!collectorId) throw new Error("heartbeat requires collectorId");
    touchCollector(collectorId, projectKeys);
    return { ok: true };
  }

  /** `{ collectorId, ts, projects: [{ key, name, repoPath, board }] }` — a full board-state
   * snapshot for every project that collector watches, same shape buildBoardState() produces
   * locally. Replaces (not merges) each project's stored board — a snapshot is authoritative for
   * everything it contains, same as a local project-manager re-render. */
  function ingestSnapshot({ collectorId, projects }) {
    if (!collectorId) throw new Error("snapshot requires collectorId");
    if (!Array.isArray(projects)) throw new Error("snapshot requires a projects array");
    const now = Date.now();
    const keys = [];
    for (const p of projects) {
      if (!p || typeof p.key !== "string" || !p.key) continue;
      keys.push(p.key);
      remoteProjects.set(p.key, {
        key: p.key,
        name: p.name || p.key,
        repoPath: p.repoPath || null,
        collectorId,
        receivedAt: now,
        board: p.board || null,
      });
    }
    touchCollector(collectorId, keys);
    return { ok: true, accepted: keys.length };
  }

  /** `{ collectorId, ts, items: [{ seq, event: taggedEvent }, ...] }` — already-enriched feed
   * events (red-flag tagged, cross-source linked, projectKey/projectName-tagged) exactly as a
   * local project-manager produces them, each wrapped with the collector-local outbox `seq` number
   * that assigned it (lib/collector-outbox.mjs). Three checks before an item is accepted:
   *   1. IDEMPOTENCY (security item #6): a collector retries a batch whenever it doesn't get a 2xx
   *      back — including when the hub actually processed it but the RESPONSE was lost. `seq` is
   *      monotonic per collector (assigned once, in order, by collector-outbox.mjs), so any item
   *      with `seq <= ` the highest already processed for that collector is a resend, skipped
   *      (not re-broadcast, not re-counted) rather than double-appearing in the feed.
   *   2. KIND VALIDATION (security item #4): `event.kind` must be one of the real, reviewed
   *      EVENT_KIND_NAMES (lib/event-kinds.mjs) — an arbitrary string can't inject a fake kind that
   *      bypasses red-flag classification or renders oddly client-side.
   *   3. Re-sanitizes `summary` (defense in depth, security item #3 — see module header).
   * Accepted items push into the hub's own bounded ring for feed replay and forward through
   * onFeedEvent (server.mjs wires this to the SAME broadcast("feed", ...) a local watcher event
   * goes through — one pipeline, one shape, browsers can't tell a remote event from a local one). */
  function ingestEvents({ collectorId, items }) {
    if (!collectorId) throw new Error("events requires collectorId");
    if (!Array.isArray(items)) throw new Error("events requires an items array");
    let accepted = 0;
    let deduped = 0;
    let rejectedKind = 0;
    const lastSeq = lastSeqByCollector.get(collectorId) ?? -1;
    let maxSeqThisBatch = lastSeq;
    for (const entry of items) {
      if (!entry || typeof entry !== "object") continue;
      const seq = typeof entry.seq === "number" ? entry.seq : null;
      const raw = entry.event;
      if (!raw || typeof raw !== "object") continue;
      if (seq !== null && seq <= lastSeq) {
        deduped++;
        continue; // already processed this seq for this collector — a retried batch, not new data
      }
      if (typeof raw.kind !== "string" || !VALID_KINDS.has(raw.kind)) {
        rejectedKind++;
        continue; // not one of the reviewed EVENT_KIND_NAMES — refuse rather than inject an unknown kind
      }
      const event = { ...raw };
      if (typeof event.summary === "string") event.summary = sanitizeAndTruncate(event.summary, 200);
      feedRing.push(event);
      if (feedRing.length > feedRingMax) feedRing.shift();
      onFeedEvent(event);
      accepted++;
      if (seq !== null && seq > maxSeqThisBatch) maxSeqThisBatch = seq;
    }
    if (maxSeqThisBatch > lastSeq) lastSeqByCollector.set(collectorId, maxSeqThisBatch);
    if (accepted > 0 || deduped > 0) touchCollector(collectorId, undefined);
    return { ok: true, accepted, deduped, rejectedKind };
  }

  /** Every remote project as a unified-state-shaped entry, with `board.collectorOffline` /
   * `board.collectorOfflineMs` set honestly from the owning collector's last heartbeat — the data
   * itself is NEVER deleted or hidden when a collector goes quiet (last-known state stays visible,
   * per the "never stale-data-as-fresh" directive: it's shown, but flagged, not silently presented
   * as current). */
  function getRemoteProjectsState() {
    const now = Date.now();
    const out = [];
    for (const rp of remoteProjects.values()) {
      const col = collectors.get(rp.collectorId);
      const lastSeen = col ? col.lastSeen : rp.receivedAt;
      const offlineMs = now - lastSeen;
      const offline = offlineMs > offlineThresholdMs;
      const board = rp.board
        ? { ...rp.board, collectorId: rp.collectorId, collectorOffline: offline, collectorOfflineMs: offline ? offlineMs : 0, snapshotAgeMs: now - rp.receivedAt }
        : null;
      out.push({ key: rp.key, name: rp.name, repoPath: rp.repoPath, enabled: true, source: "remote", collectorId: rp.collectorId, board });
    }
    return out;
  }

  function getRecentFeed(limit = 200) {
    return feedRing.slice(-limit);
  }

  /** Collector roster for an ops/status view — every collector ever seen this process's lifetime,
   * with live offline status. */
  function listCollectors() {
    const now = Date.now();
    return [...collectors.entries()].map(([collectorId, c]) => {
      const offlineMs = now - c.lastSeen;
      return { collectorId, projectKeys: c.projectKeys, lastSeenMs: c.lastSeen, offline: offlineMs > offlineThresholdMs, offlineMs: offlineMs > offlineThresholdMs ? offlineMs : 0 };
    });
  }

  return { ingestHeartbeat, ingestSnapshot, ingestEvents, getRemoteProjectsState, getRecentFeed, listCollectors };
}
