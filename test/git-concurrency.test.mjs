// REGRESSION SUITE FOR THE GIT PROCESS STORM (2026-08-13).
//
// Production ops-dashboard was proven by intervention to be the source of 20-46 simultaneous
// `git status --porcelain=v2` processes. lib/git-runner.mjs's header documents the root cause; this
// file is the machinery that proves the fix holds and, more importantly, that it would FAIL if
// somebody removed it ([[structural-prevention]] Law 3 — a guard that has only ever passed is
// unproven).
//
// Everything here runs against REAL throwaway git repositories under os.tmpdir() and the REAL git
// binary — no mocks. None of the owner's working repositories (Keralora / Licentric / LawyerServed
// / solvemax) are touched, by construction: every path used is a mkdtemp under the OS temp dir.
//
// The one deliberate fake is a hung `git` (a shell script that sleeps), injected via the runner's
// gitBin seam, because "a git process that never returns" cannot be produced honestly with the
// real binary and is precisely the failure that would hold a concurrency slot forever.
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getGitStatus, clearGitStatusCache, getGitStatusCacheSize, getGitStatusCacheCounters, invalidateGitStatus } from "../lib/git-status.mjs";
import {
  configureGitRunner,
  getGitRunnerCounters,
  resetGitRunnerCounters,
  setSpawnObserver,
} from "../lib/git-runner.mjs";

const PRODUCTION_DEFAULTS = { concurrency: 2, timeoutMs: 20000, gitBin: "git" };
const tmpDirs = [];

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(label = "storm") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ops-dash-${label}-`));
  tmpDirs.push(dir);
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "one");
  git(["add", "a.txt"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  return dir;
}

/** Records every REAL git spawn (dedup/memo joins are invisible here — that is the point: these
 * counts are subprocesses, not calls). Returns a live array plus a status-only view. */
function recordSpawns() {
  const spawns = [];
  setSpawnObserver((s) => spawns.push(s));
  return {
    all: spawns,
    statusOps: () => spawns.filter((s) => s.args[0] === "status" && s.args.includes("--porcelain=v2")),
  };
}

before(() => {
  configureGitRunner(PRODUCTION_DEFAULTS);
});

/** Stale-while-revalidate refreshes are deliberately fire-and-forget, so a previous test can still
 * have a background scan in flight when the next one starts asserting on PROCESS-WIDE gauges
 * (`active`, `peakActive`). That is correct production behaviour and a real hazard for a shared-
 * state test file, so every test starts from a quiesced runner rather than from hope. */
async function waitForIdle(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (getGitRunnerCounters().active > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(getGitRunnerCounters().active, 0, "runner did not go idle between tests");
}

beforeEach(async () => {
  await waitForIdle();
  configureGitRunner(PRODUCTION_DEFAULTS);
  delete process.env.OPS_DASH_GIT_TTL_MS;
  delete process.env.OPS_DASH_GIT_MAX_STALE_MS;
  clearGitStatusCache();
  resetGitRunnerCounters();
  setSpawnObserver(null);
});

after(() => {
  setSpawnObserver(null);
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── 1. PER-REPOSITORY SINGLE-FLIGHT ──────────────────────────────────────────────────────────
test("100 simultaneous requests for ONE repo produce exactly ONE `git status --porcelain=v2` for it (max concurrency 1)", async () => {
  const dir = makeRepo("singleflight");
  const project = { repoPath: dir, gitDirExists: true };
  const rec = recordSpawns();

  const results = await Promise.all(Array.from({ length: 100 }, () => getGitStatus(project)));

  // The strongest available form of "max concurrency for this repo is 1": across 100 overlapping
  // callers the working tree was inspected exactly ONCE, so two such processes cannot have
  // co-existed. Before the fix this was 100 snapshots x (1 + worktrees) status processes.
  assert.equal(rec.statusOps().length, 1, "one working-tree scan for 100 concurrent callers");
  assert.equal(getGitRunnerCounters().peakActive <= 2, true, "global bound respected");
  // Single-flight must not change WHAT callers get: every one of the 100 sees the same real answer.
  for (const r of results) {
    assert.equal(r.available, true);
    assert.equal(r.branch, "main");
  }
  assert.equal(results.every((r) => r === results[0]), true, "all callers joined the one snapshot");
});

test("NEGATIVE CONTROL: the PRE-FIX code path really does produce a process storm (the instrument is sound)", async () => {
  // A guard that has only ever passed is unproven, and a measurement that has never seen the fault
  // is not a measurement (CLAUDE.md Law 1 — prove the instrument, and a false alarm costs as much
  // as a miss). This reconstructs exactly what v3.3.1 did — ungoverned async `execFile`, the shape
  // every call site had before lib/git-runner.mjs existed — and counts how many git children are
  // alive AT THE SAME INSTANT. It must reproduce the incident; if this test ever goes quiet, the
  // assertions above stop meaning anything.
  const dir = makeRepo("prefix-control");
  let alive = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      new Promise((resolve) => {
        alive++;
        if (alive > peak) peak = alive;
        execFile("git", ["status", "--porcelain=v2"], { cwd: dir }, () => {
          alive--;
          resolve();
        });
      })
    )
  );
  assert.equal(peak >= 10, true, `pre-fix path peaked at only ${peak} concurrent git processes — expected a storm`);

  // ...and the SAME workload through the governed path, for the direct comparison.
  clearGitStatusCache();
  resetGitRunnerCounters();
  const rec = recordSpawns();
  await Promise.all(Array.from({ length: 20 }, () => getGitStatus({ repoPath: dir, gitDirExists: true })));
  assert.equal(rec.statusOps().length, 1, "governed path: one scan");
  assert.equal(getGitRunnerCounters().peakActive <= 2, true, "governed path: bounded peak");
});

// ── 2. GLOBAL CONCURRENCY LIMIT ──────────────────────────────────────────────────────────────
test("across MANY repos at once, live git subprocesses never exceed the configured limit", async () => {
  const repos = Array.from({ length: 6 }, (_, i) => makeRepo(`fleet${i}`));
  for (const limit of [1, 2, 4]) {
    configureGitRunner({ concurrency: limit });
    clearGitStatusCache();
    resetGitRunnerCounters();
    await Promise.all(repos.map((dir) => getGitStatus({ repoPath: dir, gitDirExists: true })));
    const c = getGitRunnerCounters();
    assert.equal(
      c.peakActive <= limit,
      true,
      `peakActive ${c.peakActive} exceeded configured concurrency ${limit}`
    );
    assert.equal(c.gitSpawns > limit, true, "sanity: the workload really was bigger than the limit");
    assert.equal(c.active, 0, "no subprocess left running after the refresh settled");
  }
});

// ── 3. WORKTREES — NO DUPLICATE SAME-WORKTREE SCAN ───────────────────────────────────────────
test("a repo with multiple worktrees scans each worktree at most ONCE per snapshot", async () => {
  const dir = makeRepo("worktrees");
  const extras = [];
  for (const name of ["wt-a", "wt-b", "wt-c"]) {
    const wtPath = path.join(path.dirname(dir), `${path.basename(dir)}-${name}`);
    tmpDirs.push(wtPath);
    git(["worktree", "add", "-q", "-b", name, wtPath], dir);
    extras.push(wtPath);
  }
  const rec = recordSpawns();
  const result = await getGitStatus({ repoPath: dir, gitDirExists: true });

  const statusCwds = rec.statusOps().map((s) => s.cwd);
  assert.equal(
    new Set(statusCwds).size,
    statusCwds.length,
    `duplicate worktree scan: ${JSON.stringify(statusCwds)}`
  );
  // The main working tree is scanned by the dirty-summary AND is a matrix row (main is checked out
  // there) — that overlap was a real duplicate spawn before the per-snapshot memo, so assert the
  // main tree specifically appears once.
  assert.equal(statusCwds.filter((c) => c === dir).length, 1, "main working tree scanned exactly once");
  assert.equal(new Set(statusCwds).size, 4, "one scan per live worktree (main + 3), no more, no fewer");
  const canonicalScanned = new Set(statusCwds.map((c) => fs.realpathSync(c)));
  for (const wt of extras) assert.equal(canonicalScanned.has(fs.realpathSync(wt)), true, `worktree ${wt} was scanned`);
  assert.equal(result.worktrees.length, 4);
});

// ── 4. CHILD TIMEOUT ─────────────────────────────────────────────────────────────────────────
test("a hung git is killed by the timeout, the slot is released, and the caller still gets an answer", async () => {
  // A `git` that never returns AND leaks its stdout pipe to a grandchild (`sleep` is NOT exec'd),
  // which is the case a naive child.kill() fails to clean up: the direct child dies, the pipe stays
  // open, and the concurrency slot is held forever. This is the negative control for the
  // process-group hard-kill backstop in git-runner.mjs.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-dash-hunggit-"));
  tmpDirs.push(binDir);
  const fakeGit = path.join(binDir, "git");
  fs.writeFileSync(fakeGit, "#!/bin/sh\nsleep 60\n");
  fs.chmodSync(fakeGit, 0o755);

  const dir = makeRepo("timeout");
  configureGitRunner({ gitBin: fakeGit, timeoutMs: 300, concurrency: 4 });

  const started = Date.now();
  const result = await getGitStatus({ repoPath: dir, gitDirExists: true });
  const elapsed = Date.now() - started;

  assert.equal(getGitRunnerCounters().timeouts > 0, true, "timeouts were counted");
  assert.equal(getGitRunnerCounters().active, 0, "every concurrency slot was released");
  assert.equal(result.available, true, "a hung git degrades, it does not throw");
  assert.equal(elapsed < 15000, true, `hung snapshot resolved in ${elapsed}ms — the timeout did not bound it`);
});

// ── 5. RECOVERY AFTER TIMEOUT ────────────────────────────────────────────────────────────────
test("the request immediately after a timeout succeeds — a degraded snapshot is never cached", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-dash-hunggit2-"));
  tmpDirs.push(binDir);
  const fakeGit = path.join(binDir, "git");
  fs.writeFileSync(fakeGit, "#!/bin/sh\nexec sleep 60\n");
  fs.chmodSync(fakeGit, 0o755);

  const dir = makeRepo("recovery");
  const project = { repoPath: dir, gitDirExists: true };

  configureGitRunner({ gitBin: fakeGit, timeoutMs: 250, concurrency: 4 });
  const degraded = await getGitStatus(project);
  assert.equal(degraded.branch, "(detached HEAD)", "the hung run really did produce empty data");
  assert.equal(getGitStatusCacheSize(), 0, "a degraded snapshot must not stay in the cache");

  configureGitRunner(PRODUCTION_DEFAULTS);
  const healthy = await getGitStatus(project); // NO cache clear — recovery must be automatic
  assert.equal(healthy.branch, "main", "the very next refresh recovered real data");
  assert.equal(healthy.available, true);
});

// ── 6. SHORT-TTL CACHE + STALE-WHILE-REVALIDATE ──────────────────────────────────────────────
test("within the TTL several consumers reuse one snapshot; after it expires the repo is re-scanned", async () => {
  process.env.OPS_DASH_GIT_TTL_MS = "400";
  const dir = makeRepo("ttl");
  const project = { repoPath: dir, gitDirExists: true };
  const rec = recordSpawns();

  const first = await getGitStatus(project);
  const spawnsAfterFirst = rec.all.length;
  assert.equal(spawnsAfterFirst > 0, true);

  const second = await getGitStatus(project); // sequential, well inside the TTL
  assert.equal(rec.all.length, spawnsAfterFirst, "a within-TTL consumer spawned no git processes");
  assert.equal(second, first, "and got the identical snapshot object");

  await new Promise((r) => setTimeout(r, 500));

  // STALE-WHILE-REVALIDATE: the caller is served the previous snapshot IMMEDIATELY (it must never
  // block on git once a repo has been scanned once) and a background refresh is kicked off.
  const stale = await getGitStatus(project);
  assert.equal(stale, first, "an expired entry is served instantly rather than making the UI wait");

  await new Promise((r) => setTimeout(r, 800)); // let the background refresh land
  assert.equal(rec.all.length > spawnsAfterFirst, true, "the background refresh really re-scanned");
  const fresh = await getGitStatus(project);
  assert.notEqual(fresh, first, "and the next caller gets the newly-built snapshot");
  assert.equal(fresh.branch, "main");
});

test("STALE-WHILE-REVALIDATE bounds git work to ONE scan per TTL no matter how many callers arrive", async () => {
  // The regression this guards is the one found on the live 5-project deployment: with a plain TTL
  // shorter than the scan it caches, 40 concurrent callers each paid for a full fresh scan and the
  // burst took 99 seconds. Here 50 callers arrive continuously across several TTL windows and the
  // total number of working-tree scans must stay in single digits.
  process.env.OPS_DASH_GIT_TTL_MS = "100";
  const dir = makeRepo("swr");
  const project = { repoPath: dir, gitDirExists: true };
  await getGitStatus(project); // warm (the only blocking scan a caller ever pays for)
  const rec = recordSpawns();

  const started = Date.now();
  for (let i = 0; i < 50; i++) {
    const r = await getGitStatus(project);
    assert.equal(r.branch, "main", "every caller got real data, never a placeholder");
    await new Promise((res) => setTimeout(res, 10));
  }
  const elapsed = Date.now() - started;

  const scans = rec.statusOps().length;
  assert.equal(scans <= 8, true, `50 callers over ~${elapsed}ms triggered ${scans} scans — coalescing regressed`);
  assert.equal(elapsed < 3000, true, `50 warm callers took ${elapsed}ms — callers are blocking on git again`);
});

test("EVENT-DRIVEN INVALIDATION: a real commit makes the next read rescan instead of waiting out the TTL", async () => {
  process.env.OPS_DASH_GIT_TTL_MS = "60000"; // a long TTL, so ONLY invalidation can refresh this
  const dir = makeRepo("invalidate");
  const project = { repoPath: dir, gitDirExists: true };

  const before = await getGitStatus(project);
  const firstCommit = before.lastCommit.hash;

  fs.writeFileSync(path.join(dir, "b.txt"), "two");
  git(["add", "b.txt"], dir);
  git(["commit", "-q", "-m", "second"], dir);

  const stillCached = await getGitStatus(project);
  assert.equal(stillCached.lastCommit.hash, firstCommit, "without invalidation the long TTL holds (control)");

  assert.equal(invalidateGitStatus(dir), true, "invalidation found the entry");
  await getGitStatus(project); // served stale + triggers the refresh
  await new Promise((r) => setTimeout(r, 600));
  const after = await getGitStatus(project);
  assert.notEqual(after.lastCommit.hash, firstCommit, "the commit reached the board without waiting out the TTL");
  assert.equal(after.lastCommit.subject, "second");
});

test("TTL=0 disables reuse entirely (the escape hatch works in the direction that matters)", async () => {
  process.env.OPS_DASH_GIT_TTL_MS = "0";
  process.env.OPS_DASH_GIT_MAX_STALE_MS = "1"; // no stale-serving either — force a real scan
  const dir = makeRepo("ttlzero");
  const project = { repoPath: dir, gitDirExists: true };
  const rec = recordSpawns();
  await getGitStatus(project);
  const after = rec.all.length;
  await getGitStatus(project);
  delete process.env.OPS_DASH_GIT_MAX_STALE_MS;
  assert.equal(rec.all.length > after, true, "TTL=0 must re-scan every time");
});

// ── 7. ERROR SAFETY ──────────────────────────────────────────────────────────────────────────
test("a git binary that cannot be spawned leaves NO poisoned state — the next refresh succeeds", async () => {
  const dir = makeRepo("errsafe");
  const project = { repoPath: dir, gitDirExists: true };

  configureGitRunner({ gitBin: path.join(os.tmpdir(), "definitely-not-a-real-git-binary") });
  const broken = await getGitStatus(project);
  assert.equal(broken.available, true, "a missing git degrades gracefully, it does not throw");
  assert.equal(getGitRunnerCounters().spawnErrors > 0, true, "spawn failures were counted");
  assert.equal(getGitStatusCacheSize(), 0, "nothing poisoned was retained");
  assert.equal(getGitRunnerCounters().active, 0, "no slot leaked on the failure path");

  configureGitRunner(PRODUCTION_DEFAULTS);
  const recovered = await getGitStatus(project);
  assert.equal(recovered.branch, "main");
});

test("an ordinary non-zero git exit is NOT treated as degradation (or the cache would never work)", async () => {
  // `rev-parse --verify --quiet` on a branch that was never pushed exits non-zero on every healthy
  // refresh of a repo with a remote. If that counted as degradation, nothing would ever be cached
  // and the whole fix would silently do nothing while still passing every other test here.
  const dir = makeRepo("exitcode");
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ops-dash-bare-"));
  tmpDirs.push(bare);
  git(["init", "-q", "--bare"], bare);
  git(["remote", "add", "origin", bare], dir);
  git(["branch", "never-pushed"], dir);

  const project = { repoPath: dir, gitDirExists: true };
  const first = await getGitStatus(project);
  assert.equal(getGitRunnerCounters().exitFailures > 0, true, "the expected non-zero exits happened");
  assert.equal(getGitStatusCacheSize(), 1, "and the snapshot was still cached");
  const second = await getGitStatus(project);
  assert.equal(second, first, "so the next consumer reused it");
});

// ── OBSERVABILITY ────────────────────────────────────────────────────────────────────────────
test("counters report joins, cache reuse, spawns and the peak that the incident was about", async () => {
  process.env.OPS_DASH_GIT_TTL_MS = "5000";
  const dir = makeRepo("counters");
  const project = { repoPath: dir, gitDirExists: true };
  await Promise.all(Array.from({ length: 10 }, () => getGitStatus(project)));
  await getGitStatus(project);

  const c = getGitRunnerCounters();
  assert.equal(c.gitSpawns > 0, true, "spawns are counted");
  assert.equal(c.memoHits > 0, true, "within-snapshot duplicate commands are counted");
  assert.equal(c.peakActive <= 2, true, "peak never exceeded the configured bound");
  assert.equal(c.active, 0, "the live gauge returns to zero");
  assert.equal(typeof c.timeouts, "number");
  assert.equal(typeof c.queued, "number");
});
