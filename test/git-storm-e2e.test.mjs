// END-TO-END PROOF of the git-storm fix, through the REAL server process over REAL HTTP.
//
// The unit-level guarantees live in test/git-concurrency.test.mjs. This file exists because the
// storm was produced by the SERVER's fan-in (concurrent /api/state requests, SSE connects, the
// periodic tick and feed-driven pushes all landing at once), and a guarantee proven only at the
// module boundary would not have caught it: the module was already "correct" in isolation before
// the fix, and still melted the machine in production ([[always-verify-implemented-work]] — a
// passing unit test is not proof the real path works).
//
// It spawns an isolated server.mjs (same technique as test/static-assets-auth.test.mjs) against a
// THROWAWAY repository under os.tmpdir(), hammers it the way several browser tabs would, and then
// reads the governor's own counters back out of /api/git-metrics. No production repository and no
// production server is involved: isolated directory, isolated config, its own port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG_DIR = path.join(import.meta.dirname, "..");
const PORT = 39231; // fixed, unlikely-collision port — deliberately NOT 4650 (production's port)

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsdash-storm-repo-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "one");
  git(["add", "a.txt"]);
  git(["commit", "-q", "-m", "init"]);
  for (const b of ["feat-a", "feat-b", "feat-c"]) git(["branch", b]);
  fs.writeFileSync(path.join(dir, "dirty.txt"), "uncommitted");
  return dir;
}

function makeServerDir(repoPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsdash-storm-server-"));
  for (const name of ["server.mjs", "lib", "public", "package.json", "VERSION"]) {
    fs.cpSync(path.join(PKG_DIR, name), path.join(dir, name), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify(
      {
        port: PORT,
        bind: "127.0.0.1",
        dashToken: "",
        collectorToken: null,
        projects: [{ key: "storm", name: "storm", repoPath, enabled: true }],
        projectRepoMap: {},
        controlContractEnabled: true,
        feed: { refreshMs: 5000, debounceMs: 200, bufferMax: 500, liveWindowMs: 180000, stallThresholdMs: 300000, idleThresholdMs: 1800000, orphanThresholdMs: 86400000, hysteresisGraceMs: 15000 },
        watchedReportFiles: ["STATUS.md"],
        kanban: { columns: ["Queued", "In Progress", "Verifying", "Done"] },
        secretStripPatterns: [],
        suggestLimit: 8,
      },
      null,
      2
    )
  );
  return dir;
}

async function pollHealthz(deadlineMs = 8000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test("40 concurrent /api/state requests + SSE connects never push the live server past the git concurrency limit", async () => {
  const repoPath = makeRepo();
  const dir = makeServerDir(repoPath);
  const proc = spawn("node", ["server.mjs"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));

  try {
    assert.equal(await pollHealthz(), true, `server did not come up; log:\n${log}`);

    // Every independent refresh trigger the dashboard actually has, fired at once: browser polls of
    // /api/state, plus SSE connects (each of which sends an immediate full state frame).
    const sseControllers = Array.from({ length: 4 }, () => new AbortController());
    const load = [
      ...Array.from({ length: 40 }, () => fetch(`http://127.0.0.1:${PORT}/api/state`)),
      ...sseControllers.map((c) => fetch(`http://127.0.0.1:${PORT}/events`, { signal: c.signal }).catch(() => null)),
    ];
    const responses = await Promise.all(load);
    for (const c of sseControllers) c.abort();

    for (const r of responses.slice(0, 40)) assert.equal(r.status, 200, "every state request succeeded");
    const states = await Promise.all(responses.slice(0, 40).map((r) => r.json()));
    for (const s of states) {
      assert.equal(s.projects.length, 1);
      assert.equal(s.projects[0].board.campaign.git.available, true, "real git data was served, not a degraded stub");
      assert.equal(s.projects[0].board.campaign.git.branch, "main");
    }

    const metrics = await (await fetch(`http://127.0.0.1:${PORT}/api/git-metrics`)).json();
    assert.equal(
      metrics.counters.peakActive <= metrics.settings.concurrency,
      true,
      `peak ${metrics.counters.peakActive} git processes exceeded the limit ${metrics.settings.concurrency}`
    );
    // The number that reproduces the incident if the fix regresses: 40 requests x a repo with 4
    // branches used to be free to spawn hundreds of children. Bound it generously but firmly —
    // this must stay in the tens, not the hundreds.
    assert.equal(
      metrics.counters.gitSpawns < 120,
      true,
      `40 concurrent refreshes spawned ${metrics.counters.gitSpawns} git processes — coalescing regressed`
    );
    assert.equal(metrics.counters.timeouts, 0, "no git call timed out on a tiny local repo");
    assert.equal(metrics.counters.spawnErrors, 0, "git spawned cleanly");
    assert.equal(metrics.counters.active <= metrics.settings.concurrency, true, "live gauge is sane");
  } finally {
    proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
});
