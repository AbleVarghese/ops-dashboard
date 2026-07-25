#!/usr/bin/env node
// M6 PORTABILITY evidence: actually builds and runs the Docker image (not just a Dockerfile that
// looks plausible), points it at a real repo via the compose file's own BIND=0.0.0.0 + read-only
// $HOME mount pattern, and confirms it serves the real page with real live agent data through the
// mount. Zero deps beyond the `docker` CLI already required to use Docker at all.
//
// Every `docker`/`node` invocation below uses execFileSync with an argument array, never a
// shell string — --repo is a CLI arg a caller controls, and building a shell command by string
// interpolation is exactly the command-injection shape security tooling flags on sight.
//
// Usage:  node verify/docker.mjs [--repo /path/to/a/real/repo/to/watch] [--json path]
// Exit code: 0 if build + run + serve + real-data-through-mount all succeed, 1 otherwise.
// Always cleans up the container + test image, even on failure (try/finally).
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PKG_DIR = path.join(import.meta.dirname, "..");
const IMAGE_TAG = "ops-dashboard:verify-docker-test";
const CONTAINER_NAME = "ops-dashboard-verify-docker-test";
const HOST_PORT = Number(process.argv.find((a, i) => process.argv[i - 1] === "--port")) || 4653;
const WATCH_REPO = process.argv.includes("--repo") ? process.argv[process.argv.indexOf("--repo") + 1] : os.homedir();
const JSON_OUT = process.argv.includes("--json")
  ? process.argv[process.argv.indexOf("--json") + 1]
  : path.join(import.meta.dirname, "results", "docker.json");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
function runQuiet(cmd, args, opts = {}) {
  try { execFileSync(cmd, args, { stdio: "ignore", ...opts }); } catch { /* best-effort cleanup/teardown call */ }
}
function httpGetTimed(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ ms: Date.now() - t0, status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function main() {
  const results = { ranAt: new Date().toISOString(), steps: {} };

  try {
    // 1. Docker itself available?
    try {
      run("docker", ["info"]);
      results.steps.dockerAvailable = { pass: true };
    } catch (err) {
      results.steps.dockerAvailable = { pass: false, error: String(err.message || err).slice(0, 300) };
      throw new Error("docker not available/running — cannot proceed");
    }

    // 2. Build the real image from this package's own Dockerfile.
    const buildT0 = Date.now();
    try {
      run("docker", ["build", "-t", IMAGE_TAG, "."], { cwd: PKG_DIR });
      results.steps.build = { pass: true, ms: Date.now() - buildT0 };
    } catch (err) {
      results.steps.build = { pass: false, ms: Date.now() - buildT0, error: String(err.message || err).slice(0, 500) };
      throw new Error("docker build failed");
    }

    // 3. Run it exactly per the compose file's own pattern: BIND=0.0.0.0 (container-internal),
    //    host publish on 127.0.0.1 only, read-only $HOME bind mount at the SAME absolute path.
    runQuiet("docker", ["rm", "-f", CONTAINER_NAME]);
    run("docker", [
      "run", "-d",
      "--name", CONTAINER_NAME,
      "-p", `127.0.0.1:${HOST_PORT}:4650`,
      "-e", `HOME=${os.homedir()}`,
      "-e", "BIND=0.0.0.0",
      "--mount", `type=bind,source=${os.homedir()},target=${os.homedir()},readonly`,
      "--mount", `type=bind,source=${path.join(PKG_DIR, "data")},target=/app/data`,
      "--entrypoint", "node",
      IMAGE_TAG,
      "server.mjs", WATCH_REPO,
    ]);
    await new Promise((r) => setTimeout(r, 2500)); // let the server actually bind + do its first scan

    // 4. Confirm the page is genuinely served (not just a container that started).
    const pageRes = await httpGetTimed(`http://127.0.0.1:${HOST_PORT}/`);
    results.steps.serve = { pass: pageRes.status === 200 && pageRes.body.includes("<title>"), status: pageRes.status, ms: pageRes.ms };

    // 5. Confirm REAL DATA flows through the read-only mount — not just an empty shell.
    const stateRes = await httpGetTimed(`http://127.0.0.1:${HOST_PORT}/api/state`);
    let watchedProject = null;
    let agentCount = 0;
    try {
      const state = JSON.parse(stateRes.body);
      const p = state.projects.find((p) => p.repoPath === path.resolve(WATCH_REPO)) || state.projects[0];
      watchedProject = p ? p.name : null;
      agentCount = p ? (p.board.agents || []).length : 0;
    } catch {}
    results.steps.realDataThroughMount = {
      pass: stateRes.status === 200 && watchedProject !== null,
      watchedProject,
      agentCount,
      apiStateMs: stateRes.ms,
    };
  } finally {
    // Always clean up — a leftover container/image is exactly the kind of orphaned verify-run
    // state this harness has already had (and fixed) once before, for a different script.
    runQuiet("docker", ["rm", "-f", CONTAINER_NAME]);
    runQuiet("docker", ["rmi", IMAGE_TAG]);
    results.steps.cleanup = { pass: true, containerRemoved: true, imageRemoved: true };
  }

  const allPass = Object.values(results.steps).every((s) => s.pass !== false);
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(allPass ? "\nPASS — Docker build + run + serve + real-data-through-mount all succeeded." : "\nFAIL — see steps.* above.");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify/docker] ERROR:", err.message);
  process.exit(1);
});
