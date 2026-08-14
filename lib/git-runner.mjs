// THE GIT SUBPROCESS GOVERNOR — every `git` child process this dashboard ever spawns goes through
// runGitCommand() here, and nowhere else.
//
// WHY THIS FILE EXISTS (the incident, 2026-08-13 — read this before "simplifying" anything below).
// Production ops-dashboard was observed holding 20-46 SIMULTANEOUS `git status --porcelain=v2`
// processes, permanently, burning CPU and battery on an idle laptop. Proven by intervention:
// stopping ops-dashboard stopped the storm.
//
// The root cause was NOT a leak and NOT a runaway loop. It was the v3.3.1 latency optimization
// (git-status.mjs's header describes it): every git call was converted from the SYNCHRONOUS
// `execFileSync` to the asynchronous `execFile`, and independent calls were grouped under
// `Promise.all`. That change was correct about latency and wrong about resource control, because
// `execFileSync` had been acting as an ACCIDENTAL GLOBAL MUTEX — a single-threaded Node process
// running a synchronous subprocess cannot, by construction, have two subprocesses alive at once,
// and it cannot begin a second board refresh while the first is still running, because the first
// is occupying the event loop. Removing `Sync` removed that mutex. Nothing was put in its place:
// no single-flight, no semaphore, no cache, no in-flight coalescing. The fan-out (Promise.all over
// remotes, over branches, over projects) and the fan-in (a 150ms debounce, a 5s backstop timer,
// every SSE connect, every /api/state request) then multiplied against each other freely.
//
// The three guarantees this module provides, in the order they matter:
//   1. DEDUP     — two identical `git` invocations (same argv, same cwd) that overlap in time share
//                  ONE subprocess. Within a single snapshot they share one RESULT (the memo), so a
//                  snapshot is also internally consistent, not just cheap.
//   2. BOUND     — at most `concurrency` git children exist at any instant, process-wide, across
//                  every project, every worktree and every concurrent refresh. Excess work queues.
//   3. TERMINATE — every child has a finite timeout and a hard-kill backstop, so a git process that
//                  hangs on a network filesystem, an index.lock, or a wedged filter cannot occupy a
//                  concurrency slot forever (which would deadlock every other project's refresh).
//
// Counters are deliberately plain integers, updated inline, with no logging. The previous failure
// mode was invisible for weeks precisely because nothing counted subprocesses
// ([[observability-before-launch]]); the fix for that is a cheap always-on counter surfaced on
// demand at /api/git-metrics, NOT a per-spawn log line that would itself become the new noise.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

/** Per-snapshot context. Carries (a) the memo that makes a single snapshot spawn each distinct git
 * command at most once, and (b) the degradation flags that tell the caller's cache "do NOT keep
 * this result — it was built on top of a timeout or a spawn failure". AsyncLocalStorage is used
 * rather than threading a ctx argument through eleven functions because it propagates correctly
 * across `await` and `Promise.all` without touching a single call signature. */
export const snapshotCtx = new AsyncLocalStorage();

function envInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Defaults. Concurrency 2 is the owner-specified power-efficient default: enough to keep one git
// process running while another is in its fork/exec/stat-heavy startup, far below the ~7-core
// saturation the storm produced. The 20s child timeout is deliberately CONSERVATIVE — a cold
// `git status` on a very large repo with a cold page cache can legitimately take several seconds,
// and killing legitimate work would be a worse bug than the one being fixed.
const settings = {
  concurrency: envInt("OPS_DASH_GIT_CONCURRENCY", 2),
  timeoutMs: envInt("OPS_DASH_GIT_TIMEOUT_MS", 20000),
  gitBin: process.env.OPS_DASH_GIT_BIN || "git",
  maxBuffer: 8 * 1024 * 1024,
};

/** Test/ops seam. Production never calls this; the tests use it to shrink the timeout, point at a
 * deliberately-hung fake `git`, or prove the semaphore holds at a different limit. */
export function configureGitRunner(patch = {}) {
  Object.assign(settings, patch);
  return { ...settings };
}
export function getGitRunnerSettings() {
  return { ...settings };
}

const counters = {
  gitSpawns: 0, // real child processes created
  commandJoins: 0, // identical in-flight command reused across snapshots
  memoHits: 0, // identical command reused WITHIN one snapshot (the duplicate-worktree case)
  active: 0, // git children alive right now
  peakActive: 0, // high-water mark since last reset — the number the incident was about
  queued: 0, // callers waiting on a concurrency slot right now
  peakQueued: 0,
  timeouts: 0, // children killed for exceeding timeoutMs
  spawnErrors: 0, // git binary missing/unexecutable (ENOENT/EACCES) — NOT a normal non-zero exit
  exitFailures: 0, // ordinary non-zero exits (expected: `rev-parse --verify` on a missing ref)
};

export function getGitRunnerCounters() {
  return { ...counters };
}
export function resetGitRunnerCounters() {
  for (const k of Object.keys(counters)) counters[k] = 0;
  // active/queued are live gauges, not tallies — re-derive rather than zero them, so a reset
  // during flight cannot make the gauge lie (it would go negative on release).
  counters.active = liveActive;
  counters.queued = waiters.length;
  counters.peakActive = liveActive;
  counters.peakQueued = waiters.length;
}

/** Test-only spawn observer: called with {args, cwd} at the moment a REAL child is created (never
 * for a dedup/memo join). Kept null in production so the hot path costs one null check. */
let spawnObserver = null;
export function setSpawnObserver(fn) {
  spawnObserver = fn || null;
}

// ── The semaphore ────────────────────────────────────────────────────────────────────────────
// A counting semaphore, FIFO, with no dependencies. `liveActive` is the authoritative gauge;
// counters.active mirrors it for reporting.
let liveActive = 0;
const waiters = [];

function acquire() {
  if (liveActive < settings.concurrency) {
    liveActive++;
    counters.active = liveActive;
    if (liveActive > counters.peakActive) counters.peakActive = liveActive;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
    counters.queued = waiters.length;
    if (waiters.length > counters.peakQueued) counters.peakQueued = waiters.length;
  });
}

function release() {
  const next = waiters.shift();
  counters.queued = waiters.length;
  if (next) {
    // Slot handed straight to the next waiter — liveActive stays where it is.
    if (liveActive > counters.peakActive) counters.peakActive = liveActive;
    next();
    return;
  }
  liveActive--;
  counters.active = liveActive;
}

// ── The single-flight map (cross-snapshot) ───────────────────────────────────────────────────
// Key includes cwd AND every argv element, separated by NUL so no argument value can forge a key
// collision with a different command.
const inflight = new Map();

// CANONICALIZE THE PATH BEFORE KEYING. Found by this module's own worktree test, and it is a REAL
// production bug rather than a test artifact: `git worktree list --porcelain` reports RESOLVED
// paths, while the configured repoPath is whatever the owner typed. On macOS the
// `/var` -> `/private/var` symlink makes those two different spellings of the SAME directory, so
// the main working tree was scanned TWICE per snapshot - one wasted `git status --porcelain=v2`
// per project per refresh, on precisely the command the storm was made of. Any symlinked repo path
// (a very common setup) hits this. realpath is cached: it is a syscall over a tiny, fixed path set.
const realpathCache = new Map();
function canonical(cwd) {
  let real = realpathCache.get(cwd);
  if (real === undefined) {
    try {
      real = fs.realpathSync.native(cwd);
    } catch {
      real = cwd; // path gone (a deleted repo) - key on what we were given and let git report it
    }
    realpathCache.set(cwd, real);
  }
  return real;
}

// NUL-separated so no argument value can forge a collision with a different command.
function keyOf(args, cwd) {
  return [canonical(cwd), ...args].join("\u0000");
}

function spawnGit(args, cwd) {
  return new Promise((resolve, reject) => {
    counters.gitSpawns++;
    if (spawnObserver) {
      try {
        spawnObserver({ args, cwd });
      } catch {
        /* an observer fault must never break a git call */
      }
    }
    const child = execFile(
      settings.gitBin,
      args,
      // `detached: true` puts the child in its own process GROUP. That is what makes the hard-kill
      // backstop below able to kill a grandchild (a git hook, a credential helper, a pager) that
      // inherited the stdout pipe — killing only the direct child would leave the pipe open, the
      // execFile callback unfired, and the concurrency slot held indefinitely, which is the exact
      // deadlock this whole module exists to prevent. Accepted trade-off: a git child briefly
      // outlives a SIGKILLed server instead of dying with it; these processes live milliseconds.
      { cwd, encoding: "utf8", maxBuffer: settings.maxBuffer, timeout: settings.timeoutMs, killSignal: "SIGKILL", detached: true },
      (err, stdout) => {
        clearTimeout(hardKill);
        if (!err) return resolve(stdout);
        // CLASSIFY the failure. This distinction is load-bearing: `rev-parse --verify --quiet` on a
        // branch that has never been pushed exits non-zero on EVERY healthy refresh, so treating
        // "non-zero exit" as degradation would mean the snapshot cache is never usable and the
        // whole fix silently does nothing ([[fail-loudly]] C3 — a signal that always fires is the
        // same as no signal).
        const store = snapshotCtx.getStore();
        if (err.killed || err.signal === "SIGKILL" || err.code === "ETIMEDOUT") {
          counters.timeouts++;
          if (store) store.timeouts++;
          err.opsDashTimeout = true;
        } else if (err.code === "ENOENT" || err.code === "EACCES") {
          counters.spawnErrors++;
          if (store) store.spawnErrors++;
        } else {
          counters.exitFailures++;
        }
        reject(err);
      }
    );
    // GUARANTEED CLEANUP. execFile's own `timeout` is the primary mechanism, but its callback only
    // fires once the child's stdio pipes close — a child that leaked a pipe to a surviving
    // grandchild can therefore outlive its own timeout. This backstop kills the process group
    // member directly a little later, so a concurrency slot can never be held forever.
    // Grace is bounded to [250ms, 2000ms] rather than a flat +2000ms so a test that shrinks the
    // timeout to a few hundred milliseconds still finishes quickly, while production keeps a full
    // 2s of slack before escalating from "kill the child" to "kill its whole process group".
    const graceMs = Math.min(2000, Math.max(250, settings.timeoutMs));
    const hardKill = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL"); // negative pid = the whole group (see detached above)
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, settings.timeoutMs + graceMs);
    if (typeof hardKill.unref === "function") hardKill.unref();
  });
}

/**
 * The ONE entry point for running git. Resolves with stdout; rejects on any failure (the caller
 * decides how to degrade — git-status.mjs turns every rejection into an empty string, which is the
 * behavior every one of its callers has always relied on).
 *
 * Order of the three short-circuits matters:
 *   memo (same snapshot)  →  in-flight (different snapshots, overlapping in time)  →  semaphore.
 * Checking the memo first is what guarantees "no duplicate same-worktree status operation" inside
 * one snapshot even when the two callers are in different stages and do not overlap in time.
 */
export function runGitCommand(args, cwd) {
  const key = keyOf(args, cwd);

  const store = snapshotCtx.getStore();
  if (store) {
    const memoed = store.memo.get(key);
    if (memoed) {
      counters.memoHits++;
      return memoed;
    }
  }

  let promise = inflight.get(key);
  if (promise) {
    counters.commandJoins++;
  } else {
    promise = (async () => {
      await acquire();
      try {
        return await spawnGit(args, cwd);
      } finally {
        release();
      }
    })();
    inflight.set(key, promise);
    // Remove from the in-flight map the instant it settles, so a later refresh gets fresh data
    // rather than a stale shared promise. The no-op catch prevents an unhandled rejection from the
    // bookkeeping copy of the promise (the real caller still sees the rejection).
    promise.then(
      () => inflight.delete(key),
      () => inflight.delete(key)
    );
  }

  if (store) store.memo.set(key, promise);
  return promise;
}

/** Runs `fn` inside a fresh snapshot context. Returns {result, degraded} where `degraded` means at
 * least one git call timed out or failed to spawn — the caller MUST NOT cache a degraded result,
 * or one hung git call would poison the dashboard for the whole TTL. */
export async function withSnapshot(fn) {
  const store = { memo: new Map(), timeouts: 0, spawnErrors: 0 };
  const result = await snapshotCtx.run(store, fn);
  store.memo.clear(); // bounded lifetime — the memo never outlives its snapshot
  return { result, degraded: store.timeouts > 0 || store.spawnErrors > 0, timeouts: store.timeouts, spawnErrors: store.spawnErrors };
}
