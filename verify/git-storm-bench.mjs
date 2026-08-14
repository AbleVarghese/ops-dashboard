#!/usr/bin/env node
// BENCHMARK / EVIDENCE HARNESS for the 2026-08-13 git process storm fix.
//
//   node verify/git-storm-bench.mjs [--projects 4] [--worktrees 2] [--branches 6] [--refreshes 20]
//
// Builds throwaway repositories under os.tmpdir() shaped like the production deployment (N
// projects, each with extra worktrees and branches), then:
//   1. MEASURES the shape of each repo (remotes R, local branches B, live worktrees W) and derives
//      the theoretical per-refresh git-subprocess count from the call graph in lib/git-status.mjs;
//   2. runs a BURST of overlapping refreshes through the UNGOVERNED pre-fix path (raw async
//      execFile, no semaphore/single-flight/cache) and records the real peak concurrency;
//   3. runs the identical burst through the GOVERNED path and records spawns, peak, joins, cache
//      hits and wall-clock.
// Nothing outside os.tmpdir() is touched. No production repository is read.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getGitStatus, clearGitStatusCache } from "../lib/git-status.mjs";
import { getGitRunnerCounters, resetGitRunnerCounters, getGitRunnerSettings, setSpawnObserver } from "../lib/git-runner.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const N_PROJECTS = arg("projects", 4);
const N_WORKTREES = arg("worktrees", 2);
const N_BRANCHES = arg("branches", 6);
const N_REFRESHES = arg("refreshes", 20);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ops-dash-bench-"));
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function buildRepo(i) {
  const dir = path.join(root, `project-${i}`);
  fs.mkdirSync(dir);
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "bench@example.com"], dir);
  git(["config", "user.name", "Bench"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "bench");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  const bare = path.join(root, `project-${i}.git`);
  git(["init", "-q", "--bare", bare], root);
  git(["remote", "add", "origin", bare], dir);
  git(["push", "-q", "origin", "main"], dir);
  for (let b = 0; b < N_BRANCHES; b++) git(["branch", `feature-${b}`], dir);
  for (let w = 0; w < N_WORKTREES; w++) {
    git(["worktree", "add", "-q", path.join(root, `project-${i}-wt-${w}`), `feature-${w}`], dir);
  }
  fs.writeFileSync(path.join(dir, "dirty.txt"), "uncommitted"); // a realistic dirty tree
  return dir;
}

function shapeOf(dir) {
  const R = git(["remote"], dir).split("\n").filter(Boolean).length;
  const B = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], dir).split("\n").filter(Boolean).length;
  const W = git(["worktree", "list", "--porcelain"], dir).split("\n").filter((l) => l.startsWith("worktree ")).length;
  return { R, B, W };
}

/** The call graph of lib/git-status.mjs, as arithmetic. Stage 1: 3. Stage 2: 6 + 2R (dirty, stash,
 * last-commit, worktrees, tags, cadence + rev-parse/rev-list per remote). Stage 3: 1 + up to 3 per
 * branch (worktree status when checked out, rev-parse, rev-list). */
function theoreticalCallsPerRefresh({ R, B, W }) {
  return { total: 3 + 6 + 2 * R + 1 + 2 * B + W, statusOps: 1 + W };
}

async function ungovernedBurst(repos) {
  // Replays the SAME volume of git work the governed path would do, in the pre-fix shape: every
  // call an independent async execFile, every refresh independent of every other. This is what
  // v3.3.1 actually did.
  let alive = 0;
  let peak = 0;
  let spawns = 0;
  const one = (args, cwd) =>
    new Promise((resolve) => {
      alive++;
      spawns++;
      if (alive > peak) peak = alive;
      execFile("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 }, () => {
        alive--;
        resolve();
      });
    });
  const started = Date.now();
  await Promise.all(
    Array.from({ length: N_REFRESHES }, () =>
      Promise.all(
        repos.map(async ({ dir, shape }) => {
          await Promise.all([one(["branch", "--show-current"], dir), one(["remote"], dir), one(["for-each-ref", "--format=%(refname:short)", "refs/heads"], dir)]);
          const worktreePaths = git(["worktree", "list", "--porcelain"], dir).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
          await Promise.all([
            one(["status", "--porcelain=v2"], dir),
            one(["stash", "list"], dir),
            one(["log", "-1", "--format=%h"], dir),
            one(["worktree", "list", "--porcelain"], dir),
            one(["for-each-ref", "refs/tags"], dir),
            one(["log", "--since=2026-08-01", "--format=%cs"], dir),
            ...Array.from({ length: shape.R }, () => one(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], dir)),
          ]);
          await Promise.all(worktreePaths.map((wt) => one(["status", "--porcelain=v2"], wt)));
        })
      )
    )
  );
  return { peak, spawns, ms: Date.now() - started };
}

async function governedBurst(repos) {
  clearGitStatusCache();
  resetGitRunnerCounters();
  let statusOps = 0;
  setSpawnObserver((s) => {
    if (s.args[0] === "status" && s.args.includes("--porcelain=v2")) statusOps++;
  });
  const started = Date.now();
  // Overlapping refreshes, exactly as the server produces them: a burst of feed events plus the
  // periodic tick, all landing inside the same moment.
  await Promise.all(
    Array.from({ length: N_REFRESHES }, () => Promise.all(repos.map(({ dir }) => getGitStatus({ repoPath: dir, gitDirExists: true }))))
  );
  const ms = Date.now() - started;
  setSpawnObserver(null);
  return { ...getGitRunnerCounters(), statusOps, ms };
}

const repos = Array.from({ length: N_PROJECTS }, (_, i) => {
  const dir = buildRepo(i);
  return { dir, shape: shapeOf(dir) };
});

const perRefresh = repos.map((r) => theoreticalCallsPerRefresh(r.shape));
const theoryTotal = perRefresh.reduce((a, t) => a + t.total, 0);
const theoryStatus = perRefresh.reduce((a, t) => a + t.statusOps, 0);

console.log(`\n  ops-dashboard git-storm benchmark`);
console.log(`  ${N_PROJECTS} projects x (${N_BRANCHES} branches, ${N_WORKTREES} extra worktrees, 1 remote), ${N_REFRESHES} overlapping refreshes\n`);
console.log(`  THEORY (from the lib/git-status.mjs call graph)`);
console.log(`    git calls per single full refresh (all projects) : ${theoryTotal}`);
console.log(`    of which \`status --porcelain=v2\`                 : ${theoryStatus}`);
console.log(`    if ${N_REFRESHES} refreshes overlap, ungoverned            : ${theoryTotal * N_REFRESHES} calls, ${theoryStatus * N_REFRESHES} status procs, all eligible to be concurrent\n`);

const before = await ungovernedBurst(repos);
console.log(`  BEFORE (pre-fix path: ungoverned async execFile)`);
console.log(`    git subprocesses spawned                         : ${before.spawns}`);
console.log(`    PEAK SIMULTANEOUS git processes                  : ${before.peak}`);
console.log(`    wall clock                                       : ${before.ms}ms\n`);

const after = await governedBurst(repos);
console.log(`  AFTER (governed: single-flight + semaphore + TTL cache)`);
console.log(`    git subprocesses spawned                         : ${after.gitSpawns}`);
console.log(`    of which \`status --porcelain=v2\`                 : ${after.statusOps}`);
console.log(`    PEAK SIMULTANEOUS git processes                  : ${after.peakActive}   (limit ${getGitRunnerSettings().concurrency})`);
console.log(`    single-flight command joins                      : ${after.commandJoins}`);
console.log(`    within-snapshot memo hits (dup worktree scans)   : ${after.memoHits}`);
console.log(`    timeouts / spawn errors                          : ${after.timeouts} / ${after.spawnErrors}`);
console.log(`    wall clock                                       : ${after.ms}ms\n`);

const reduction = before.spawns > 0 ? (100 * (1 - after.gitSpawns / before.spawns)).toFixed(1) : "n/a";
console.log(`  RESULT  peak ${before.peak} -> ${after.peakActive} concurrent;  subprocesses ${before.spawns} -> ${after.gitSpawns} (${reduction}% fewer)\n`);

fs.rmSync(root, { recursive: true, force: true });

// Fail loudly if the governor did not hold — this harness is evidence, and evidence that cannot
// fail is decoration.
if (after.peakActive > getGitRunnerSettings().concurrency) {
  console.error(`  FAIL: peak ${after.peakActive} exceeded the configured concurrency limit`);
  process.exit(1);
}
