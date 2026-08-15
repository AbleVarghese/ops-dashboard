// Comprehensive, READ-ONLY git status for one project — mission item #3 ("GIT" gate).
// Everything here is a plain `git` plumbing/porcelain call guarded by try/catch (gitSafe), so a
// missing repo, a detached HEAD, or a repo with no remotes degrades to empty fields, never throws.
// Cache invalidation is the CALLER's job (feed-git.mjs already watches .git and fires on
// HEAD/tag change; the board-state 5s refresh re-derives this fresh each tick, which is cheap —
// these are local `git` calls, not network).
//
// v3.3.1 — PARALLELIZED (owner directive: latency; measured 685ms-1825ms per call, root-caused to
// up to ~15 SEQUENTIAL synchronous `execFileSync` subprocess spawns for a single project — each
// fork/exec has real OS overhead, and they ran one after another). Converted every git call from
// synchronous `execFileSync` to async `execFile` (`node:util.promisify`), and every group of git
// calls with NO data dependency on each other now runs via `Promise.all` instead of sequentially.
// Calls that GENUINELY depend on a prior result (e.g. per-remote ahead/behind needs `branch`
// first; the work-disposition matrix needs `worktrees` and the branch list first) still run in
// their necessary order — this is real parallelism of independent work, not a fake await sprinkle.
// `getGitStatus` is now `async` — this cascades to its two callers (`board-state.mjs`,
// `project-manager.mjs`) and from there to `server.mjs`'s `buildFullState()`; every call site was
// updated to `await` (see CLOSE-OUT-v3.3.md / the v3.3.1 commit for the full list).
//
// v3.3.2 — RESOURCE-GOVERNED (owner directive, 2026-08-13, after production was proven to be the
// source of a 20-46 simultaneous `git status --porcelain=v2` process storm). The v3.3.1 note above
// is still accurate about LATENCY and was silently wrong about RESOURCE USE: `execFileSync` had
// been an accidental global mutex, and converting to async removed it without replacing it. Two
// things changed here, and neither alters a single output field:
//   1. every git call now goes through lib/git-runner.mjs (global concurrency bound, per-command
//      single-flight, per-snapshot memo, finite child timeout, counters);
//   2. getGitStatus() is now a thin cache/single-flight wrapper around computeGitStatus() — the
//      whole function body below is unchanged and is what actually does the work.
// The Promise.all fan-out below is DELIBERATELY LEFT AS IT IS: it now expresses "these calls have
// no data dependency", while the runner decides how many may actually run at once. Collapsing the
// fan-out back into sequential awaits would hard-code a concurrency policy into eleven call sites.
import { runGitCommand, withSnapshot } from "./git-runner.mjs";

async function gitSafe(args, cwd) {
  try {
    const stdout = await runGitCommand(args, cwd);
    return stdout.trim();
  } catch {
    // Unchanged contract: ANY failure degrades to "" and never throws. A non-zero exit is normal
    // here (`rev-parse --verify --quiet` on an unpushed branch); a timeout or a missing git binary
    // is not, and the runner has already recorded that on the snapshot context so the caller's
    // cache knows not to keep this result.
    return "";
  }
}

async function gitLines(args, cwd) {
  const out = await gitSafe(args, cwd);
  return out ? out.split("\n") : [];
}

function parsePorcelainStatusLine(line) {
  // `status --porcelain=v2` ordinary-change lines: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
  // rename lines: "2 <XY> ... <path>\t<origPath>"; untracked: "? <path>"
  if (line.startsWith("? ")) return { path: line.slice(2), state: "untracked" };
  if (line.startsWith("1 ") || line.startsWith("2 ")) {
    const parts = line.split(" ");
    const xy = parts[1] || "";
    const filePath = parts.slice(8).join(" ").split("\t")[0];
    const staged = xy[0] !== "." && xy[0] !== undefined;
    const unstaged = xy[1] !== "." && xy[1] !== undefined;
    return { path: filePath, state: staged && unstaged ? "staged+unstaged" : staged ? "staged" : "unstaged", xy };
  }
  if (line.startsWith("u ")) return { path: line.split(" ").slice(-1)[0], state: "conflict" };
  return null;
}

async function dirtySummary(cwd) {
  const lines = await gitLines(["status", "--porcelain=v2"], cwd);
  const files = lines.map(parsePorcelainStatusLine).filter(Boolean);
  return { count: files.length, files: files.slice(0, 300) };
}

/** Ahead/behind for every remote — the remotes are already known by the time this is called
 * (fetched once by the caller and passed in), so every remote's rev-parse+rev-list pair runs
 * CONCURRENTLY with every other remote's (a repo with 3 remotes used to pay 3x sequential git
 * calls here; now pays 1x wall-clock time). */
async function aheadBehindPerRemote(cwd, branch, remotes) {
  const result = {};
  await Promise.all(
    remotes.map(async (remote) => {
      const ref = `refs/remotes/${remote}/${branch}`;
      const exists = await gitSafe(["rev-parse", "--verify", "--quiet", ref], cwd);
      if (!exists) {
        result[remote] = { tracked: false, ahead: 0, behind: 0 };
        return;
      }
      const counts = await gitSafe(["rev-list", "--left-right", "--count", `HEAD...${ref}`], cwd);
      const [ahead, behind] = counts.split(/\s+/).map((n) => Number(n) || 0);
      result[remote] = { tracked: true, ahead, behind };
    })
  );
  return result;
}

async function commitCadence(cwd, days = 14) {
  // one commit-count bucket per calendar day, oldest -> newest, for a sparkline
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const log = await gitLines(["log", `--since=${since}`, "--format=%cs"], cwd); // %cs = committer date, short
  const counts = new Map();
  for (const d of log) counts.set(d, (counts.get(d) || 0) + 1);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    buckets.push({ date: d, count: counts.get(d) || 0 });
  }
  return buckets;
}

async function tagsTimeline(cwd) {
  const raw = await gitLines(["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)|%(creatordate:short)|%(subject)", "refs/tags"], cwd);
  return raw.slice(0, 25).map((line) => {
    const [name, date, subject] = line.split("|");
    return { name, date, subject: subject || "" };
  });
}

async function getWorktrees(cwd) {
  const raw = await gitSafe(["worktree", "list", "--porcelain"], cwd);
  if (!raw) return [];
  const trees = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) trees.push(cur);
      cur = { path: line.slice(9), branch: null, bare: false, detached: false };
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      cur.bare = true;
    } else if (line === "detached") {
      cur.detached = true;
    }
  }
  if (cur) trees.push(cur);
  return trees;
}

/** One branch's full row for the work-disposition matrix — the 1-3 git calls this needs
 * (worktree-dirty-check, remote-rev-parse, remote-rev-list) are specific to THIS branch and
 * independent of every OTHER branch's row, so the caller runs one of these per branch via
 * Promise.all rather than looping sequentially (a repo with 10 local branches used to pay up to
 * 20 sequential git calls just for this matrix; now pays ~1-2x wall-clock time). */
async function buildMatrixRow(cwd, branch, primaryRemote, worktreeByBranch, mergedIntoDefault, remoteBranches) {
  const worktreePath = worktreeByBranch.get(branch) || null;
  let committedCell = { status: "ok", count: 0, note: "all work committed" };
  let pushedPromise;
  if (worktreePath) {
    const dirtyLines = await gitLines(["status", "--porcelain=v2"], worktreePath);
    committedCell = dirtyLines.length > 0
      ? { status: "red", count: dirtyLines.length, note: `${dirtyLines.length} uncommitted change(s) in worktree` }
      : { status: "ok", count: 0, note: "all work committed" };
  }

  let pushedCell = { status: "ok", count: 0, note: "no remote configured" };
  if (primaryRemote) {
    const remoteRef = `refs/remotes/${primaryRemote}/${branch}`;
    // v3.3.2 — set membership against ONE bulk `for-each-ref` the caller already fetched, instead
    // of one `rev-parse --verify` subprocess PER BRANCH. Measured on the live deployment: Licentric
    // has 229 local branches, so this row-builder alone was spawning ~458 git processes per refresh
    // (the 466 counted `exitFailures` were literally one rev-parse miss per unpushed branch). The
    // answer to "does this ref exist" was already fully contained in a single ref listing; asking
    // the same question 229 times as 229 subprocesses was the real cost. Identical output.
    const remoteExists = remoteBranches.has(`${primaryRemote}/${branch}`);
    if (!remoteExists) {
      pushedCell = { status: "amber", count: -1, note: `not on ${primaryRemote}` };
    } else {
      const ahead = Number((await gitSafe(["rev-list", "--count", `${remoteRef}..${branch}`], cwd)) || 0);
      pushedCell = ahead > 0
        ? { status: ahead >= 5 ? "red" : "amber", count: ahead, note: `${ahead} unpushed commit(s)` }
        : { status: "ok", count: 0, note: "pushed" };
    }
  }

  const isMerged = mergedIntoDefault.has(branch);
  const mergedCell = isMerged
    ? { status: "ok", count: 1, note: "merged" }
    : { status: "amber", count: 0, note: "not yet merged" };

  return { branch, worktreePath, committed: committedCell, pushed: pushedCell, merged: mergedCell };
}

/** The WORK-DISPOSITION MATRIX (mission item #3): rows = local branches (+ worktree tag when a
 * branch is checked out in a worktree), columns = committed -> pushed -> merged. Each cell is
 * {status: "ok"|"amber"|"red", count} plus a lightweight drawer payload (the actual sha list is
 * intentionally capped — this is a status board, not a git log viewer). `remotes` and `branches`
 * are passed in (already fetched by the caller for its own use) rather than re-queried here —
 * one fewer redundant `git remote` call than the pre-v3.3.1 version had. */
async function buildWorkDispositionMatrix(cwd, worktrees, branches, remotes) {
  const primaryRemote = remotes.includes("origin") ? "origin" : remotes[0];
  // "merged" means merged into the DEFAULT line (main/master), never into "whatever is currently
  // checked out" — using HEAD here would make a checked-out feature branch trivially "merged into
  // itself" every time (a real bug this module's own tests caught: `git branch --merged HEAD` always
  // lists HEAD's own branch). Fall back to HEAD only when neither main nor master exists locally.
  const defaultBranch = branches.includes("main") ? "main" : branches.includes("master") ? "master" : "HEAD";
  // Both of these are ONE subprocess each and answer a question that would otherwise be asked once
  // per branch: which branches are merged into the default line, and which exist on the remote.
  const [mergedLines, remoteRefs] = await Promise.all([
    gitLines(["branch", "--merged", defaultBranch], cwd),
    primaryRemote ? gitLines(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${primaryRemote}`], cwd) : Promise.resolve([]),
  ]);
  const mergedIntoDefault = new Set(mergedLines.map((s) => s.replace(/^\*?\s*/, "")));
  const remoteBranches = new Set(remoteRefs);
  const worktreeByBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w.path]));

  const rows = await Promise.all(branches.map((branch) => buildMatrixRow(cwd, branch, primaryRemote, worktreeByBranch, mergedIntoDefault, remoteBranches)));

  const stranded = rows.filter((r) => r.committed.status === "red" || r.pushed.status === "red" || (!r.merged.count && r.pushed.status !== "ok"));
  return { primaryRemote, rows, strandedBranches: stranded.map((r) => r.branch) };
}

function rollupSentence(branch, aheadBehind, dirty, matrix) {
  const parts = [];
  parts.push(`On \`${branch}\`.`);
  const remoteEntries = Object.entries(aheadBehind);
  if (remoteEntries.length === 0) parts.push("No remotes configured.");
  for (const [remote, ab] of remoteEntries) {
    if (!ab.tracked) { parts.push(`Not tracked on ${remote}.`); continue; }
    if (ab.ahead === 0 && ab.behind === 0) parts.push(`Up to date with ${remote}.`);
    else parts.push(`${ab.ahead} ahead / ${ab.behind} behind ${remote}.`);
  }
  parts.push(dirty.count > 0 ? `${dirty.count} uncommitted file(s).` : "Working tree clean.");
  if (matrix.strandedBranches.length) parts.push(`${matrix.strandedBranches.length} branch(es) need attention: ${matrix.strandedBranches.join(", ")}.`);
  return parts.join(" ");
}

async function computeGitStatus(project) {
  const cwd = project.repoPath;
  if (!project.gitDirExists) return { available: false };

  // STAGE 1 — the few things everything else depends on: current branch, the remote list, and the
  // local branch list. Three independent calls, run concurrently.
  const [branch, remotes, branches] = await Promise.all([
    gitSafe(["branch", "--show-current"], cwd).then((b) => b || "(detached HEAD)"),
    gitLines(["remote"], cwd),
    gitLines(["for-each-ref", "--format=%(refname:short)", "refs/heads"], cwd),
  ]);

  // STAGE 2 — everything that only needs STAGE 1's results (branch/remotes/branches), none of
  // which depend on each other. This is the bulk of the parallelism win: dirty-summary,
  // stash-list, last-commit, worktrees, tags, and the 14-day cadence log used to run one after
  // another; they now all run at once.
  const [aheadBehind, dirty, stash, lastCommitRaw, worktrees, tags, cadence] = await Promise.all([
    aheadBehindPerRemote(cwd, branch, remotes),
    dirtySummary(cwd),
    gitLines(["stash", "list"], cwd),
    gitSafe(["log", "-1", "--format=%h|%s|%cI|%an"], cwd),
    getWorktrees(cwd),
    tagsTimeline(cwd),
    commitCadence(cwd, 14),
  ]);

  const [hash, subject, iso, author] = lastCommitRaw ? lastCommitRaw.split("|") : ["", "", "", ""];
  const lastCommit = hash ? { hash, subject, iso, author } : null;
  const unpushedAgeMin = lastCommit && Object.values(aheadBehind).some((r) => r.ahead > 0)
    ? Math.round((Date.now() - new Date(iso).getTime()) / 60000)
    : 0;

  // STAGE 3 — the work-disposition matrix needs `worktrees` (stage 2) and `branches`/`remotes`
  // (stage 1) as inputs, so it can't start until those resolve — but it's the one piece that
  // itself fans out to N more concurrent calls internally (buildMatrixRow, per branch).
  const matrix = await buildWorkDispositionMatrix(cwd, worktrees, branches, remotes);

  const result = {
    available: true,
    branch,
    remotes,
    aheadBehind,
    dirty,
    stash,
    stashCount: stash.length,
    lastCommit,
    unpushedAgeMin,
    unpushedAmber: unpushedAgeMin > 30,
    tags,
    cadence,
    worktrees,
    matrix,
  };
  result.rollup = rollupSentence(branch, aheadBehind, dirty, matrix);
  return result;
}

// ── PER-REPOSITORY SINGLE-FLIGHT + STALE-WHILE-REVALIDATE CACHE ──────────────────────────────
// The second half of the storm fix. The runner (lib/git-runner.mjs) bounds how many git children
// exist; this bounds how many SNAPSHOTS are ever built. Without it, N overlapping refreshes each
// build a complete snapshot of the same repo — the runner would keep the machine from melting, but
// every refresh would still queue ~10+2R+2B+W redundant git calls behind the semaphore.
//
// WHY STALE-WHILE-REVALIDATE, AND NOT A PLAIN TTL (measured on the live 5-project deployment,
// 2026-08-15 — this is the second bug this design had, found only by running it for real):
// a plain TTL cache is worthless whenever the TTL is SHORTER THAN THE SCAN IT CACHES. Five real
// repositories (some with dozens of branches) take seconds to snapshot at concurrency 2, so a 2s
// entry had always expired by the time the next caller arrived: every queued caller paid for a
// full fresh scan, and 40 concurrent /api/state requests took 99 SECONDS with peakQueued at 241.
// The bound held (peak stayed at 2 — the storm could not come back) but the dashboard was
// unusable, which is its own kind of failure.
//
// So a caller never waits for a scan it does not have to wait for:
//   FRESH  (age < ttl)          → return the cached snapshot.
//   STALE  (ttl < age < ceiling)→ return the cached snapshot IMMEDIATELY and kick off ONE
//                                 background refresh. The UI stays instant; git work stays bounded
//                                 to one scan per repo per TTL no matter how many callers arrive.
//   COLD / TOO STALE            → block on a real scan (single-flight: all concurrent callers of a
//                                 cold repo join the one promise; there is never a second scan).
// The staleness ceiling exists so a repo whose git is persistently broken cannot serve
// indefinitely-old data behind a background refresh that never succeeds — past the ceiling,
// callers block and take a real answer or a real failure.
//
// DEGRADED snapshots (a git call timed out or git could not be spawned) are never treated as
// fresh. If an earlier good snapshot exists it keeps being served while retries happen in the
// background (last-known-good beats nothing); if there is none, the entry is dropped entirely so
// the very next caller retries for real. That is the difference between a transient hiccup and a
// dashboard frozen on a bad result.
//
// Freshness is ALSO event-driven, which is what makes a long TTL safe: lib/feed-git.mjs calls
// invalidateGitStatus() the moment it sees HEAD or the tag list actually move, so a commit shows up
// at once instead of at the end of a TTL window. It deliberately does NOT invalidate on raw .git
// filesystem churn — `git status` itself writes .git/index (it refreshes the stat cache), so
// invalidating on every .git event would make this module retrigger itself in a loop, which is the
// exact shape of the failure being fixed.
const snapshots = new Map(); // repoPath -> { promise|null, value|null, settledAt, degraded }

const cacheCounters = { hitsFresh: 0, servedStale: 0, backgroundRefreshes: 0, blockingScans: 0, joins: 0, invalidations: 0 };
export function getGitStatusCacheCounters() {
  return { ...cacheCounters };
}

function ttlMs() {
  const raw = Number(process.env.OPS_DASH_GIT_TTL_MS);
  // 5000ms matches config.feed.refreshMs, the board's own backstop tick: git data is never staler
  // than the poll cadence this dashboard had before any of this work, while costing at most ONE
  // scan per repo per tick however many browsers, SSE clients and watchers are asking.
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
}

function maxStaleMs() {
  const raw = Number(process.env.OPS_DASH_GIT_MAX_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60000;
}

/** Test/ops seam — drops every cached snapshot. */
export function clearGitStatusCache() {
  snapshots.clear();
}

export function getGitStatusCacheSize() {
  return snapshots.size;
}

/** Event-driven freshness. Called by lib/feed-git.mjs when a repo's HEAD or tag list actually
 * moved, so the next read rescans instead of serving a snapshot that is now known to be wrong. */
export function invalidateGitStatus(repoPath) {
  const entry = snapshots.get(repoPath);
  if (!entry) return false;
  cacheCounters.invalidations++;
  entry.settledAt = 0; // known-stale: served once more while the refresh it triggers runs
  return true;
}

function startScan(key, project) {
  let entry = snapshots.get(key);
  if (!entry) {
    entry = { promise: null, value: null, settledAt: 0, degraded: false };
    snapshots.set(key, entry);
  }
  if (entry.promise) return entry.promise; // single-flight: one scan per repo, always

  entry.promise = (async () => {
    try {
      const { result, degraded } = await withSnapshot(() => computeGitStatus(project));
      entry.degraded = degraded;
      if (!degraded) entry.value = result;
      return result;
    } finally {
      entry.promise = null;
      entry.settledAt = Date.now();
      // Nothing usable and nothing remembered -> remove the entry outright rather than leave a
      // husk that later reads would have to reason about. No poisoned state, ever.
      if (entry.degraded && entry.value === null && snapshots.get(key) === entry) snapshots.delete(key);
    }
  })();
  entry.promise.catch(() => {
    if (snapshots.get(key) === entry && entry.value === null) snapshots.delete(key);
  });
  return entry.promise;
}

export async function getGitStatus(project) {
  if (!project.gitDirExists) return { available: false };
  const key = project.repoPath;
  const entry = snapshots.get(key);

  if (entry && entry.value !== null) {
    const age = Date.now() - entry.settledAt;
    if (!entry.degraded && age < ttlMs()) {
      cacheCounters.hitsFresh++;
      return entry.value;
    }
    if (age < maxStaleMs()) {
      cacheCounters.servedStale++;
      if (!entry.promise) {
        cacheCounters.backgroundRefreshes++;
        startScan(key, project).catch(() => {}); // revalidate behind the caller's back
      }
      return entry.value; // instant: the caller never waits on git
    }
  }

  if (entry && entry.promise) {
    cacheCounters.joins++;
    return entry.promise;
  }
  cacheCounters.blockingScans++;
  return startScan(key, project);
}
