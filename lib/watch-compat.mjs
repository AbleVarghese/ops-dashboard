// Drop-in replacement for fs.watch() that transparently falls back to mtime-polling (~2s) when
// native fs.watch is unreliable — bind-mounted Docker volumes on some host filesystems (notably
// macOS Docker Desktop's gRPC-FUSE/VirtioFS backends, and some NFS/SMB mounts) don't always
// deliver inotify/FSEvents events across the mount boundary, going silently dead with no error.
// Container hardening (v3.2): auto-detected via /.dockerenv, or forced via
// OPS_DASH_WATCH_MODE=poll|native — the resolved mode is exposed via watchMode() so the server can
// surface it in the UI footer / API state (never a silent dead feed — the honest-degradation rule).
import fs from "node:fs";
import path from "node:path";

function detectContainer() {
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

/** "poll" | "native" — resolved once per call (cheap: one env read + one cached fs.existsSync). */
export function watchMode() {
  const forced = process.env.OPS_DASH_WATCH_MODE;
  if (forced === "poll" || forced === "native") return forced;
  return detectContainer() ? "poll" : "native";
}

// Read fresh on every PollWatcher construction, NOT cached as a module-level constant — a
// module-level `const` would freeze whatever OPS_DASH_WATCH_POLL_MS held at first import, which in
// practice is "before any test/caller had a chance to set it" (ES module bodies run once, at
// first import). A real bug caught by this file's own tests taking suspiciously close to their
// timeout window before the fix.
function pollIntervalMs() {
  return Number(process.env.OPS_DASH_WATCH_POLL_MS) || 2000;
}

/** relPath -> mtimeMs for targetPath itself, plus (if it's a directory) its children — one level
 * deep unless `recursive`, matching fs.watch's own {recursive} contract closely enough for this
 * codebase's actual usage (watching a single file, or a directory for new top-level entries). */
function statSnapshot(targetPath, recursive) {
  const snap = new Map();
  function walk(p, rel) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return; // gone/unreadable — absence is handled by the diff in _tick, not here
    }
    snap.set(rel, st.mtimeMs);
    if (st.isDirectory() && (recursive || rel === "")) {
      let entries;
      try {
        entries = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const name of entries) walk(path.join(p, name), rel ? `${rel}/${name}` : name);
    }
  }
  walk(targetPath, "");
  return snap;
}

class PollWatcher {
  constructor(targetPath, { recursive = false } = {}, callback) {
    this._closed = false;
    this._callback = callback;
    this._prev = statSnapshot(targetPath, recursive);
    this._timer = setInterval(() => this._tick(targetPath, recursive), pollIntervalMs());
    this._timer.unref?.(); // never keeps the process alive on its own — matches fs.watch's default
  }
  _tick(targetPath, recursive) {
    if (this._closed) return;
    const next = statSnapshot(targetPath, recursive);
    for (const [rel, mtime] of next) {
      if (this._prev.get(rel) !== mtime) this._emit(this._prev.has(rel) ? "change" : "rename", rel || null);
    }
    for (const rel of this._prev.keys()) {
      if (!next.has(rel)) this._emit("rename", rel || null);
    }
    this._prev = next;
  }
  _emit(eventType, filename) {
    try {
      this._callback(eventType, filename);
    } catch {
      // a listener throwing must never kill the poll loop — fs.watch's own listener errors don't
      // propagate to the watcher either, so this matches native behavior
    }
  }
  // fs.FSWatcher supports .on("error", fn) (feed-transcripts.mjs uses this); poll mode's stat
  // failures already degrade silently inside statSnapshot, so there is no error to forward — the
  // stub exists purely so call sites don't need an fs.watch-vs-PollWatcher branch.
  on() {
    return this;
  }
  close() {
    this._closed = true;
    clearInterval(this._timer);
  }
}

/** fs.watch(path[, options], listener) drop-in. `options` may be omitted (listener-as-2nd-arg,
 * matching fs.watch's own overload). Returns an { on(), close() } handle in both modes. */
export function watchCompat(targetPath, options, listener) {
  const cb = typeof options === "function" ? options : listener;
  const opts = typeof options === "function" ? {} : options || {};
  if (watchMode() === "poll") return new PollWatcher(targetPath, opts, cb);
  return fs.watch(targetPath, opts, cb);
}
