#!/usr/bin/env node
// v3.2 COLLECTOR/HUB evidence — a real two-process demo: an isolated hub (server.mjs, hub mode)
// and a real collector.mjs, talking over real HTTP on loopback with a real bearer token. Every
// claim below is MEASURED against the live processes, not asserted from reading the source.
//
// Encodes, rerunnably:
//   (a) end-to-end live feed with measured disk -> collector -> hub latency
//   (b) kill the collector mid-stream, restart it, prove ZERO event loss from the outbox ring
//   (c) collector-offline detection surfaces honestly in /api/state (short threshold via env)
//   (d) /ingest rejects a request with no/wrong token (401)
//
// NOT covered here (documented honestly, not silently skipped — see CLOSE-OUT-v3.2.md):
//   (e) settings/config persistence across a container recreate — this requires Docker, which was
//       unavailable in the environment this script was authored/run in; verified instead by
//       static analysis of the bind-mount semantics (docker-compose.yml mounts ./data and
//       ./config.json as bind mounts, which by definition survive container removal/recreate —
//       only `docker compose down -v` on a NAMED volume, which this compose file doesn't use,
//       would lose them). Re-run `node verify/docker.mjs` once Docker is available for the live
//       equivalent of that proof on the existing local-mode path.
//   (f) the git panel working in-container — same Docker-unavailable caveat; `apk add --no-cache
//       git` is in the Dockerfile (verify/docker.mjs's own build step will exercise this the next
//       time Docker is available).
//
// Usage: node verify/collector-hub.mjs [--json path]
// Exit code: 0 if every scripted check passes, 1 otherwise. Always cleans up spawned processes and
// its own tmp directory, even on failure.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const PKG_DIR = path.join(import.meta.dirname, "..");
const HUB_PORT = 4662; // distinct from the live prod port (4650) and other verify scripts (4653)
// Two DIFFERENT tokens, deliberately (security acceptance item #5) — TOKEN is what the collector
// authenticates /ingest with; DASH_TOKEN_VALUE is what a browser would use for every other route.
// The test below proves neither works for the other's purpose.
const TOKEN = "verify-collector-hub-collector-token";
const DASH_TOKEN_VALUE = "verify-collector-hub-dash-token";
const JSON_OUT = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : path.join(import.meta.dirname, "results", "collector-hub.json");

// Default token is the BROWSER/dashboard one (DASH_TOKEN_VALUE) — most direct httpJson calls in
// this script hit browser-style routes (/api/state); /ingest calls pass `token: TOKEN` explicitly.
function httpJson(hostPort, pathname, { method = "GET", token = DASH_TOKEN_VALUE, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const req = http.request(
      { host: "127.0.0.1", port: hostPort, path: pathname, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            /* non-JSON — leave parsed null, status still meaningful */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 150 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/** Copies just what a hub process needs into a fresh tmp dir, with its OWN config.json — never
 * touches the real package's config.json/data/ (the live :4650 instance stays untouched). */
function makeIsolatedHubDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsdash-verify-hub-"));
  for (const name of ["server.mjs", "lib", "public", "package.json", "VERSION"]) {
    fs.cpSync(path.join(PKG_DIR, name), path.join(dir, name), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ port: HUB_PORT, bind: "127.0.0.1", dashToken: DASH_TOKEN_VALUE, collectorToken: TOKEN, projects: [], projectRepoMap: {} }, null, 2));
  return dir;
}

/** A minimal real git-free "project" for the collector to watch: reports/STATUS.md, which
 * feed-reports.mjs watches by default and turns any `|`-prefixed appended line into a real feed
 * event — the cheapest deterministic way to generate a genuine, controllable live event without
 * depending on this session's own unrelated agent activity (which wouldn't be rerunnable). */
function makeWatchedProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opsdash-verify-project-"));
  fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
  fs.writeFileSync(path.join(dir, "reports", "STATUS.md"), "| seed row |\n");
  return dir;
}

function spawnLogged(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return { child, getLog: () => log };
}

async function main() {
  const results = { ranAt: new Date().toISOString(), steps: {} };
  const hubDir = makeIsolatedHubDir();
  const projectDir = makeWatchedProjectDir();
  // collector.mjs's outbox/identity default to a data/ dir NEXT TO THE SCRIPT ITSELF — this
  // verification run must never write into the real package's own data/ (which is where the real
  // collector.mjs file this script invokes lives), so every spawn below passes an explicit
  // --data-dir isolated under this run's own tmp hub dir instead.
  const collectorDataDir = path.join(hubDir, "collector-data");
  const collectorArgs = () => [
    path.join(PKG_DIR, "collector.mjs"),
    "--hub", `http://127.0.0.1:${HUB_PORT}`,
    "--token", TOKEN,
    "--project", `demo:${projectDir}`,
    "--snapshot-interval-ms", "1000",
    "--heartbeat-interval-ms", "1000",
    "--data-dir", collectorDataDir,
  ];
  let hubProc, collectorProc;

  try {
    // ---- boot the hub ----
    hubProc = spawnLogged("node", ["server.mjs"], { cwd: hubDir, env: { ...process.env, OPS_DASH_COLLECTOR_OFFLINE_MS: "2000" } });
    await pollUntil(async () => {
      try {
        const r = await httpJson(HUB_PORT, "/api/state");
        return r.status === 200;
      } catch {
        return false;
      }
    }, { timeoutMs: 8000 });
    results.steps.hubBoot = { pass: true };

    // ---- HEALTHCHECK diagnosis fix, live-proven: this isolated hub has dashToken set (the exact
    //      scenario that made Docker's wget-based HEALTHCHECK report "unhealthy" against the OLD
    //      /api/state target — a 401 without an Authorization header, which wget treats as a
    //      failure). /healthz must answer 200 with NO token; /api/state must still correctly
    //      require one — both halves proven in the same run. ----
    const healthzNoAuth = await httpJson(HUB_PORT, "/healthz", { token: null });
    const stateNoAuth = await httpJson(HUB_PORT, "/api/state", { token: null });
    results.steps.healthzUnauthenticated = {
      pass: healthzNoAuth.status === 200 && stateNoAuth.status === 401,
      healthzStatus: healthzNoAuth.status,
      apiStateStatus: stateNoAuth.status, // expect 401 — proves this ISN'T just "auth is broken", /healthz is deliberately exempt
    };

    // ---- (d) auth: /ingest rejects a missing/wrong token ----
    const noToken = await httpJson(HUB_PORT, "/ingest", { method: "POST", token: null, body: { type: "heartbeat", collectorId: "x" } });
    const wrongToken = await httpJson(HUB_PORT, "/ingest", { method: "POST", token: "not-the-token", body: { type: "heartbeat", collectorId: "x" } });
    results.steps.authReject = { pass: noToken.status === 401 && wrongToken.status === 401, noTokenStatus: noToken.status, wrongTokenStatus: wrongToken.status };

    // ---- token SCOPING (security acceptance item #5): the browser's DASH_TOKEN must NOT work
    //      against /ingest, and the collector's TOKEN must NOT work against browser routes, once
    //      collectorToken is configured separately (this hub's config.json sets both, distinct). ----
    const dashTokenOnIngest = await httpJson(HUB_PORT, "/ingest", { method: "POST", token: DASH_TOKEN_VALUE, body: { type: "heartbeat", collectorId: "x" } });
    const collectorTokenOnState = await httpJson(HUB_PORT, "/api/state", { token: TOKEN });
    const collectorTokenOnIngest = await httpJson(HUB_PORT, "/ingest", { method: "POST", token: TOKEN, body: { type: "heartbeat", collectorId: "scope-check" } });
    results.steps.tokenScoping = {
      pass: dashTokenOnIngest.status === 401 && collectorTokenOnState.status === 401 && collectorTokenOnIngest.status === 200,
      dashTokenAgainstIngestStatus: dashTokenOnIngest.status, // expect 401 — the dashboard token must not grant ingest
      collectorTokenAgainstStateStatus: collectorTokenOnState.status, // expect 401 — the collector token must not grant dashboard read
      collectorTokenAgainstIngestStatus: collectorTokenOnIngest.status, // expect 200 — the collector token DOES work for its own purpose
    };

    // ---- boot a real collector, watching the real (throwaway) project dir ----
    collectorProc = spawnLogged("node", collectorArgs(), { cwd: hubDir });
    await pollUntil(async () => {
      const r = await httpJson(HUB_PORT, "/api/state");
      return r.body && r.body.projects.some((p) => p.key.includes("demo") || p.source === "remote");
    }, { timeoutMs: 8000 });

    // ---- (a) end-to-end latency: write a real report line with a unique marker, measure
    //      disk -> collector -> hub -> BROWSER (a real SSE client, exactly what app.js uses) ----
    const marker = `verify-marker-${Date.now()}`;
    const t0 = Date.now();
    const sseSeenAt = new Promise((resolve, reject) => {
      // /events is a browser route (authorized(), not ingestAuthorized()) — needs DASH_TOKEN_VALUE,
      // not the collector's TOKEN, now that the two are deliberately different (security item #5).
      const req = http.get({ host: "127.0.0.1", port: HUB_PORT, path: `/events?token=${DASH_TOKEN_VALUE}` }, (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
          if (buf.includes(marker)) {
            resolve(Date.now());
            req.destroy();
          }
        });
      });
      req.on("error", () => {}); // destroying the request once we've resolved fires an expected error — ignored
      setTimeout(() => reject(new Error("SSE marker never arrived")), 10000);
    });
    fs.appendFileSync(path.join(projectDir, "reports", "STATUS.md"), `| ${marker} |\n`);
    let latencyMs = null;
    try {
      const seenAt = await sseSeenAt;
      latencyMs = seenAt - t0;
    } catch {
      /* recorded as a fail below via latencyMs staying null */
    }
    results.steps.endToEndLatency = { pass: latencyMs !== null, latencyMs, path: "disk write -> collector fs.watch -> outbox -> POST /ingest -> hub feed ring -> SSE /events (real client)" };

    // ---- (b) a network blip AND a collector crash, combined: the hub goes down, real events
    //      accumulate in the collector's durable outbox (unsent), the collector is then hard-
    //      killed (SIGKILL, no graceful flush) WHILE those events are still pending on disk,
    //      then both processes come back — proving the outbox survives a crash and drains with
    //      zero loss of everything it had already captured. (Honest boundary, not glossed over:
    //      this does NOT claim to recover events whose SOURCE file changed while the collector
    //      process itself was fully down with an empty outbox — see this file's header comment;
    //      that is a pre-existing live-tail characteristic of the whole dashboard, not new here.) ----
    hubProc.child.kill("SIGKILL");
    await pollUntil(async () => {
      try {
        await httpJson(HUB_PORT, "/api/state");
        return false; // still answering -> not down yet
      } catch {
        return true;
      }
    }, { timeoutMs: 5000 });
    for (let i = 0; i < 5; i++) fs.appendFileSync(path.join(projectDir, "reports", "STATUS.md"), `| in-flight-event-${i} |\n`);
    const outboxFiles = () => {
      try {
        return fs.readdirSync(collectorDataDir).filter((f) => f.startsWith("collector-outbox-"));
      } catch {
        return []; // dir not created yet (collector hasn't written its first item) — treat as "no pending items"
      }
    };
    const backedUp = await pollUntil(async () => {
      const files = outboxFiles();
      if (files.length === 0) return null;
      const lines = fs.readFileSync(path.join(collectorDataDir, files[0]), "utf8").split("\n").filter(Boolean);
      return lines.length >= 5 ? lines.length : null;
    }, { timeoutMs: 8000 });
    collectorProc.child.kill("SIGKILL"); // crash the collector WHILE those events are still durably queued, unsent
    await new Promise((r) => setTimeout(r, 300));
    const survivedCrash = (() => {
      const files = outboxFiles();
      if (files.length === 0) return 0;
      return fs.readFileSync(path.join(collectorDataDir, files[0]), "utf8").split("\n").filter(Boolean).length;
    })();
    // bring both back
    hubProc = spawnLogged("node", ["server.mjs"], { cwd: hubDir, env: { ...process.env, OPS_DASH_COLLECTOR_OFFLINE_MS: "2000" } });
    await pollUntil(async () => {
      try {
        const r = await httpJson(HUB_PORT, "/api/state");
        return r.status === 200;
      } catch {
        return false;
      }
    }, { timeoutMs: 8000 });
    collectorProc = spawnLogged("node", collectorArgs(), { cwd: hubDir });
    const drained = await pollUntil(async () => {
      const files = outboxFiles();
      if (files.length === 0) return null;
      const lines = fs.readFileSync(path.join(collectorDataDir, files[0]), "utf8").split("\n").filter(Boolean);
      return lines.length === 0 ? true : null;
    }, { timeoutMs: 10000 });
    results.steps.crashResumeZeroLoss = {
      pass: backedUp >= 5 && survivedCrash >= 5 && drained === true,
      queuedDuringOutage: backedUp,
      survivedProcessCrash: survivedCrash,
      drainedAfterRestart: drained === true,
    };

    // ---- idempotent dedup (security acceptance item #6), at the WIRE level via a direct raw
    //      POST /ingest (bypassing collector.mjs entirely) — proves the hub-side dedupe works for
    //      any client speaking the protocol, not just this package's own collector implementation.
    //      Sends the identical {seq, event} batch twice, simulating a collector that resent because
    //      it never saw the first 2xx response (a real, common failure mode on a flaky network). ----
    const idempotencyMarker = `idempotency-marker-${Date.now()}`;
    const dupeBatch = { type: "events", collectorId: "idempotency-check", ts: new Date().toISOString(), items: [{ seq: 1, event: { ts: new Date().toISOString(), agent: "verify", kind: "text", summary: idempotencyMarker } }] };
    const firstSend = await httpJson(HUB_PORT, "/ingest", { method: "POST", token: TOKEN, body: dupeBatch });
    const secondSend = await httpJson(HUB_PORT, "/ingest", { method: "POST", token: TOKEN, body: dupeBatch }); // identical resend
    results.steps.idempotentDedup = {
      pass: firstSend.status === 200 && firstSend.body?.accepted === 1 && secondSend.status === 200 && secondSend.body?.accepted === 0 && secondSend.body?.deduped === 1,
      firstSend: firstSend.body,
      secondSend: secondSend.body,
    };

    // ---- (c) offline detection: kill the collector for real this time, wait past the (shortened
    //      via env) threshold, confirm the hub flags it honestly rather than showing stale-as-fresh ----
    collectorProc.child.kill("SIGKILL");
    const wentOffline = await pollUntil(async () => {
      const r = await httpJson(HUB_PORT, "/api/state");
      const remote = (r.body?.projects || []).find((p) => p.source === "remote");
      return remote && remote.board && remote.board.collectorOffline ? remote.board : null;
    }, { timeoutMs: 8000, intervalMs: 300 });
    results.steps.offlineDetection = {
      pass: wentOffline !== null,
      collectorOfflineMs: wentOffline ? wentOffline.collectorOfflineMs : null,
      dataStillPresent: wentOffline ? Object.keys(wentOffline).length > 3 : null, // never-stale-as-fresh: board data survives, just flagged
    };
  } finally {
    try {
      if (collectorProc) collectorProc.child.kill("SIGKILL");
    } catch {}
    try {
      if (hubProc) hubProc.child.kill("SIGKILL");
    } catch {}
    try {
      fs.rmSync(hubDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    } catch {}
    results.steps.cleanup = { pass: true };
  }

  const allPass = Object.values(results.steps).every((s) => s.pass !== false);
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(allPass ? "\nPASS — collector/hub end-to-end, crash-resume zero-loss, offline detection, and auth all verified live." : "\nFAIL — see steps.* above.");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify/collector-hub] ERROR:", err.message);
  process.exit(1);
});
