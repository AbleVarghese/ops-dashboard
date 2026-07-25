#!/usr/bin/env node
// M5 ROBUSTNESS evidence: RSS memory of the LIVE dashboard server process, sampled over time, to
// check for unbounded growth (a leak) rather than a bounded plateau. Zero deps.
//
// Default duration is short (90s) so this script itself finishes quickly and can be re-run as
// part of a normal verification pass; pass --duration <ms> for the full soak the M5 gate spec
// calls for (>=10min = 600000ms) when doing a final pre-ship check — this script is the same
// either way, only the sampling window differs.
//
// Usage:  node verify/soak-snapshot.mjs [--duration 90000] [--interval 5000] [--json path]
// Exit code: 0 if RSS growth over the window is within GROWTH_FACTOR_LIMIT of its starting value
// (a bounded plateau/sawtooth from GC is fine; monotonic unbounded growth is not), 1 otherwise.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DURATION_MS = Number(process.argv.find((a, i) => process.argv[i - 1] === "--duration")) || 90000;
const INTERVAL_MS = Number(process.argv.find((a, i) => process.argv[i - 1] === "--interval")) || 5000;
const JSON_OUT = process.argv.includes("--json")
  ? process.argv[process.argv.indexOf("--json") + 1]
  : path.join(import.meta.dirname, "results", "soak-snapshot.json");
const GROWTH_FACTOR_LIMIT = 1.5; // RSS may not exceed 1.5x its own starting value over the window

function findServerPid() {
  try {
    return execFileSync("pgrep", ["-f", "node server.mjs"]).toString().trim().split("\n")[0];
  } catch {
    return null;
  }
}

function rssKbFor(pid) {
  try {
    // macOS/BSD ps: -o rss= prints resident set size in KB with no header.
    return Number(execFileSync("ps", ["-o", "rss=", "-p", pid]).toString().trim());
  } catch {
    return null;
  }
}

async function main() {
  const pid = findServerPid();
  if (!pid) {
    console.error("[verify/soak-snapshot] no running `node server.mjs` process found — start the dashboard first.");
    process.exit(1);
  }
  console.log(`[verify/soak-snapshot] watching pid=${pid} for ${DURATION_MS}ms, sampling every ${INTERVAL_MS}ms`);

  const samples = [];
  const start = Date.now();
  while (Date.now() - start < DURATION_MS) {
    const rssKb = rssKbFor(pid);
    if (rssKb === null) {
      console.error(`[verify/soak-snapshot] pid ${pid} disappeared mid-soak — server crashed during the window.`);
      const results = { pid, ranAt: new Date().toISOString(), durationMs: DURATION_MS, samples, crashed: true, pass: false };
      fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
      fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
      process.exit(1);
    }
    samples.push({ tMs: Date.now() - start, rssKb });
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  const startRss = samples[0].rssKb;
  const endRss = samples[samples.length - 1].rssKb;
  const maxRss = Math.max(...samples.map((s) => s.rssKb));
  const growthFactor = maxRss / startRss;
  const pass = growthFactor <= GROWTH_FACTOR_LIMIT;

  const results = {
    pid,
    ranAt: new Date().toISOString(),
    durationMs: DURATION_MS,
    intervalMs: INTERVAL_MS,
    sampleCount: samples.length,
    startRssKb: startRss,
    endRssKb: endRss,
    maxRssKb: maxRss,
    growthFactor: Math.round(growthFactor * 100) / 100,
    growthFactorLimit: GROWTH_FACTOR_LIMIT,
    crashed: false,
    pass,
    samples,
    note: DURATION_MS < 600000
      ? `This run sampled ${Math.round(DURATION_MS / 1000)}s, not the full 10min soak the M5 spec calls for — re-run with --duration 600000 for the complete window; this is a real reproducible measurement either way, just a shorter one by default so routine re-verification stays fast.`
      : "Full 10-minute soak window.",
  };

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ ...results, samples: `[${samples.length} samples, see JSON file]` }, null, 2));
  console.log(pass ? `\nPASS — RSS stayed within ${GROWTH_FACTOR_LIMIT}x of its start (${startRss}KB -> max ${maxRss}KB).` : `\nFAIL — RSS grew ${results.growthFactor}x (${startRss}KB -> ${maxRss}KB), over the ${GROWTH_FACTOR_LIMIT}x limit.`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("[verify/soak-snapshot] ERROR:", err.message);
  process.exit(1);
});
