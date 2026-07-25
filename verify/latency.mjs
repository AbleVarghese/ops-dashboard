#!/usr/bin/env node
// M1 REALTIME evidence, reproducible. Zero deps (node:http/fs/child_process only — matches this
// package's own zero-npm-deps rule; unlike verify/screenshots.mjs and verify/axe.mjs, this script
// needs no browser and re-runs anywhere Node runs).
//
// Measures, against a REAL running dashboard server (default http://127.0.0.1:4650, override with
// DASH_URL): disk-write -> SSE-arrival latency for two different source types (a watched
// reports/*.md file, and a git commit), and a cold /api/state response time. Kill-server ->
// browser-auto-reconnect time is a genuinely BROWSER-side behavior (EventSource's own retry logic)
// and lives in verify/browser-checks.mjs instead, which is honest about needing Playwright rather
// than pretending a raw-HTTP script can exercise it.
//
// Usage:  node verify/latency.mjs [--trials N] [--json path]
// Exit code: 0 if every measured latency is under its gate threshold, 1 otherwise.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DASH_URL = process.env.DASH_URL || "http://127.0.0.1:4650";
const TRIALS = Number(process.argv.find((a, i) => process.argv[i - 1] === "--trials")) || 4;
const JSON_OUT = process.argv.includes("--json")
  ? process.argv[process.argv.indexOf("--json") + 1]
  : path.join(import.meta.dirname, "results", "latency.json");

const GATE_MS = { reportWrite: 1000, gitCommit: 1000, apiStateCold: 2000 };

function httpGetTimed(url) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ ms: Date.now() - t0, status: res.statusCode, body: data }));
    }).on("error", reject);
  });
}

function httpPostJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpDelete(url) {
  return new Promise((resolve, reject) => {
    http.request(url, { method: "DELETE" }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject).end();
  });
}

function waitForSseMarker(marker, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${DASH_URL}/events`, (res) => {
      let buf = "";
      res.on("data", (chunk) => {
        buf += chunk.toString();
        if (buf.includes(marker)) {
          req.destroy();
          resolve(Date.now());
        }
      });
      res.on("end", () => reject(new Error("SSE stream ended before marker arrived")));
    });
    req.on("error", reject);
    setTimeout(() => { req.destroy(); reject(new Error(`timeout waiting for marker ${marker}`)); }, timeoutMs);
  });
}

async function measureOnce(source, writeFn) {
  const marker = `LATENCY-${source}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ssePromise = waitForSseMarker(marker);
  await new Promise((r) => setTimeout(r, 300)); // let the SSE connection actually establish first
  const writeAt = Date.now();
  writeFn(marker);
  const arrivedAt = await ssePromise;
  return arrivedAt - writeAt;
}

async function main() {
  console.log(`[verify/latency] target=${DASH_URL} trials=${TRIALS}`);

  // Set up a throwaway watched project so this script never touches a real project's files.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-dash-verify-latency-"));
  fs.mkdirSync(path.join(dir, "reports"));
  fs.writeFileSync(path.join(dir, "reports", "TEST-RUNS.md"), "# Test Runs\n\n| # | Date | Trigger | Scope | Result |\n|---|---|---|---|---|\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "verify@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "verify"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const projectKey = `-${dir.split("/").filter(Boolean).join("-")}`;
  const results = { targetUrl: DASH_URL, ranAt: new Date().toISOString(), trials: TRIALS, samples: {} };

  // Everything that can fail lives inside this try; `finally` guarantees the throwaway project is
  // removed from the live server AND the temp dir is deleted even if a measurement throws midway
  // (a real bug in an earlier version of this script left an orphaned "verify-latency" project
  // registered on the live dashboard after a failed run — this structurally prevents a repeat).
  try {
    const addRes = await httpPostJson(`${DASH_URL}/api/projects`, { repoPath: dir, name: "verify-latency" });
    if (addRes.status !== 200 && addRes.status !== 201) throw new Error(`failed to add throwaway project: ${addRes.status} ${addRes.body.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 500)); // let the watcher arm

    // 1. Cold /api/state response time (repeat TRIALS times; "cold" here means no client-side cache —
    //    the server itself may have warm offset-tracker state from prior calls, which is realistic).
    results.samples.apiStateMs = [];
    for (let i = 0; i < TRIALS; i++) {
      const r = await httpGetTimed(`${DASH_URL}/api/state`);
      results.samples.apiStateMs.push(r.ms);
    }

    // 2. Report-file write -> SSE arrival.
    results.samples.reportWriteMs = [];
    for (let i = 0; i < TRIALS; i++) {
      const ms = await measureOnce("report", (marker) => {
        fs.appendFileSync(path.join(dir, "reports", "TEST-RUNS.md"), `| ${i} | ${new Date().toISOString()} | verify | latency | ${marker} |\n`);
      });
      results.samples.reportWriteMs.push(ms);
    }

    // 3. git commit -> SSE arrival.
    results.samples.gitCommitMs = [];
    for (let i = 0; i < TRIALS; i++) {
      const ms = await measureOnce("git", (marker) => {
        execFileSync("git", ["commit", "--allow-empty", "-q", "-m", marker], { cwd: dir });
      });
      results.samples.gitCommitMs.push(ms);
    }
  } finally {
    await httpDelete(`${DASH_URL}/api/projects/${encodeURIComponent(projectKey)}`).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  results.summary = {
    apiStateMeanMs: Math.round(mean(results.samples.apiStateMs)),
    reportWriteMeanMs: Math.round(mean(results.samples.reportWriteMs)),
    gitCommitMeanMs: Math.round(mean(results.samples.gitCommitMs)),
  };
  results.gate = {
    reportWrite: { thresholdMs: GATE_MS.reportWrite, pass: results.summary.reportWriteMeanMs < GATE_MS.reportWrite },
    gitCommit: { thresholdMs: GATE_MS.gitCommit, pass: results.summary.gitCommitMeanMs < GATE_MS.gitCommit },
    apiStateCold: { thresholdMs: GATE_MS.apiStateCold, pass: results.summary.apiStateMeanMs < GATE_MS.apiStateCold },
  };
  const allPass = Object.values(results.gate).every((g) => g.pass);

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  console.log(allPass ? "\nPASS — all latency gates under threshold." : "\nFAIL — see gate.* above.");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify/latency] ERROR:", err.message);
  process.exit(1);
});
