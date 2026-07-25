// Generic "give me only the bytes appended since last time" reader, shared by every feed watcher
// (transcripts, orchestrator sessions, reports). Never re-reads a whole multi-MB file on append —
// tracks a byte offset per path and reads exactly the delta, buffering any trailing partial line
// (a write can land mid-line) until it's completed by the next read.
import fs from "node:fs";

// filePath -> { offset: number, pending: Buffer }
const trackers = new Map();

/** Seeds the tracker at the file's CURRENT size, before any watcher can fire on it. Call this at
 * registration time — never rely on readNewLines() to self-prime, or the delta that triggered the
 * very first fs.watch event is silently lost (already-written by the time we read). */
export function primeAtCurrentEnd(filePath) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    // file may not exist yet (e.g. a session about to start writing) — prime at 0
  }
  trackers.set(filePath, { offset: size, pending: Buffer.alloc(0) });
}

export function isTracked(filePath) {
  return trackers.has(filePath);
}

export function stopTracking(filePath) {
  trackers.delete(filePath);
}

/** Drops all tracked offsets — used by a single-project CLI run tearing down its one watcher set.
 * NOT safe when multiple projects' watchers share this module (v3, project-manager.mjs) — use
 * stopTrackingMany() with that project's own path list instead, or one project's teardown would
 * wipe every other concurrently-watched project's offsets too. */
export function resetAllTrackers() {
  trackers.clear();
}

/** Drops tracked offsets for exactly the given paths — the multi-project-safe teardown. */
export function stopTrackingMany(filePaths) {
  for (const p of filePaths) trackers.delete(p);
}

/** Complete text lines appended since the last call (or since primeAtCurrentEnd). [] if nothing
 * new, the file shrank/rotated (offset reset to 0), or the file is momentarily unreadable. */
export function readNewLines(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  let tracker = trackers.get(filePath);
  if (!tracker) {
    // Not explicitly primed — treat now as the baseline rather than dumping full history.
    tracker = { offset: stat.size, pending: Buffer.alloc(0) };
    trackers.set(filePath, tracker);
    return [];
  }
  if (stat.size < tracker.offset) {
    // Truncated or rotated — restart from the top rather than reading garbage offsets.
    tracker.offset = 0;
    tracker.pending = Buffer.alloc(0);
  }
  if (stat.size === tracker.offset) return [];

  const length = stat.size - tracker.offset;
  const buf = Buffer.alloc(length);
  let bytesRead = 0;
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    bytesRead = fs.readSync(fd, buf, 0, length, tracker.offset);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  tracker.offset += bytesRead;

  const combined = Buffer.concat([tracker.pending, buf.subarray(0, bytesRead)]);
  const lines = [];
  let start = 0;
  for (let i = 0; i < combined.length; i++) {
    if (combined[i] === 0x0a) {
      lines.push(combined.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  tracker.pending = combined.subarray(start); // leftover partial line, completed next read
  return lines;
}
