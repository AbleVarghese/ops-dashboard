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
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function gitSafe(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch {
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
async function buildMatrixRow(cwd, branch, primaryRemote, worktreeByBranch, mergedIntoDefault) {
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
    const remoteExists = await gitSafe(["rev-parse", "--verify", "--quiet", remoteRef], cwd);
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
  const mergedLines = await gitLines(["branch", "--merged", defaultBranch], cwd);
  const mergedIntoDefault = new Set(mergedLines.map((s) => s.replace(/^\*?\s*/, "")));
  const worktreeByBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch, w.path]));

  const rows = await Promise.all(branches.map((branch) => buildMatrixRow(cwd, branch, primaryRemote, worktreeByBranch, mergedIntoDefault)));

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

export async function getGitStatus(project) {
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
