#!/usr/bin/env node
// Ops Dashboard v3.2 — COLLECTOR. Runs natively on a machine where agents actually work (has the
// real filesystem: transcripts, git, reports) and streams what it sees to a HUB (server.mjs
// running in a container, possibly on a different machine entirely — see docker-compose.hub.yml).
//
// WHY this exists: the hub is meant to run as a Docker container on a server the owner controls,
// but Docker bind-mounts of THIS Mac's data are impossible from a different server. The collector
// is how a remote hub still sees this Mac's live agent activity — it watches locally (reusing the
// exact same project-manager/feed/board-state pipeline server.mjs uses for local mode, zero
// duplication) and pushes already-enriched events + periodic full snapshots over HTTPS.
//
// Reliability: every feed event is durably queued (lib/collector-outbox.mjs, disk-backed, bounded)
// BEFORE any network attempt — a network blip, hub restart, or this process itself restarting
// loses zero events (resumed from the on-disk queue). Snapshots are "latest wins, retried next
// tick" (no queue needed — an old snapshot has no value once a newer one exists). Heartbeats are
// NEVER queued (a missed heartbeat is supposed to show up as offline, not be backfilled late).
//
// Usage:
//   node collector.mjs --hub https://dash.example.com --token SECRET \
//     --project keralora:/Users/Able/keralora --project dotclaude:/Users/Able/.claude
//   node collector.mjs --config collector.config.json
//
// Config file (JSON): { "hub": "...", "token": "...", "collectorId": "optional-stable-id",
//   "projects": [{ "name": "keralora", "repoPath": "/Users/Able/keralora" }],
//   "snapshotIntervalMs": 10000, "heartbeatIntervalMs": 15000, "dataDir": "optional-override" }
// CLI flags override config-file values where both are given. `--data-dir` (default: a `data/`
// folder next to this script) is where the collector's identity + durable outbox live — override
// it to run more than one collector instance on the same machine, or to isolate a verification run.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

import { DEFAULTS } from "./lib/config.mjs";
import { createProjectManager, entryFromRepoPath } from "./lib/project-manager.mjs";
import { createOutbox } from "./lib/collector-outbox.mjs";
import { postJson } from "./lib/hub-client.mjs";

const PKG_DIR = import.meta.dirname;

function parseArgs(argv) {
  const out = { projects: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hub") out.hub = argv[++i];
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--config") out.configPath = argv[++i];
    else if (a === "--id") out.collectorId = argv[++i];
    else if (a === "--data-dir") out.dataDir = argv[++i];
    else if (a === "--project") {
      const spec = argv[++i];
      const idx = spec.indexOf(":");
      if (idx < 0) throw new Error(`--project must be "name:repoPath", got "${spec}"`);
      out.projects.push({ name: spec.slice(0, idx), repoPath: spec.slice(idx + 1) });
    } else if (a === "--snapshot-interval-ms") out.snapshotIntervalMs = Number(argv[++i]);
    else if (a === "--heartbeat-interval-ms") out.heartbeatIntervalMs = Number(argv[++i]);
  }
  return out;
}

function loadConfigFile(p) {
  if (!p) return {};
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return raw;
}

/** A stable identity across restarts (so the hub doesn't treat every restart as a new source) —
 * generated once and persisted under `dataDir`, unless overridden by --id / config-file
 * `collectorId`. Hostname-prefixed purely for human readability in logs/UI, not uniqueness (the
 * random suffix guarantees that). */
function resolveCollectorId(explicit, dataDir) {
  if (explicit) return explicit;
  const idFile = path.join(dataDir, "collector-id.json");
  try {
    const saved = JSON.parse(fs.readFileSync(idFile, "utf8"));
    if (saved && saved.collectorId) return saved.collectorId;
  } catch {
    // no prior id — generate + persist below
  }
  const id = `${safeHostname()}-${crypto.randomUUID().slice(0, 8)}`;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(idFile, JSON.stringify({ collectorId: id, createdAt: new Date().toISOString() }, null, 2));
  return id;
}
function safeHostname() {
  try {
    return os.hostname().replace(/[^a-zA-Z0-9-]/g, "-");
  } catch {
    return "collector";
  }
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const fileCfg = loadConfigFile(cli.configPath);
  const hub = cli.hub || fileCfg.hub;
  const token = cli.token || fileCfg.token;
  const projectSpecs = cli.projects.length ? cli.projects : fileCfg.projects || [];
  const snapshotIntervalMs = cli.snapshotIntervalMs || fileCfg.snapshotIntervalMs || 10_000;
  const heartbeatIntervalMs = cli.heartbeatIntervalMs || fileCfg.heartbeatIntervalMs || 15_000;
  // Defaults to a `data/` dir next to THIS script (so a plain `node collector.mjs` just works),
  // but is overridable — needed by anything running multiple collector instances on one machine,
  // or an isolated verification harness (verify/collector-hub.mjs) that must never write into the
  // real package's own data/ directory.
  const dataDir = cli.dataDir || fileCfg.dataDir || path.join(PKG_DIR, "data");
  const collectorId = resolveCollectorId(cli.collectorId || fileCfg.collectorId, dataDir);

  if (!hub) throw new Error("--hub (or config file's \"hub\") is required");
  if (!projectSpecs.length) throw new Error("at least one --project name:repoPath (or config file's \"projects\") is required");

  const outboxPath = path.join(dataDir, `collector-outbox-${collectorId}.ndjson`);
  const outbox = createOutbox(outboxPath);

  const projects = projectSpecs.map((s) => ({ ...entryFromRepoPath(s.repoPath, s.name), enabled: true }));
  const config = { ...DEFAULTS, projects };

  const projectManager = createProjectManager((taggedEvent) => {
    outbox.enqueue(taggedEvent);
  });
  projectManager.reconcile(config);

  console.log(`[collector ${collectorId}] watching ${projects.length} project(s): ${projects.map((p) => p.name).join(", ")} -> ${hub}`);

  // ---- outbox sender: durable events, retried until acked ----
  const BATCH_SIZE = 200;
  let sending = false;
  async function drainOutbox() {
    if (sending) return;
    const batch = outbox.peek(BATCH_SIZE);
    if (!batch.length) return;
    sending = true;
    try {
      const res = await postJson(hub, "/ingest", token, {
        type: "events",
        collectorId,
        ts: new Date().toISOString(),
        // Each item carries its outbox seq alongside the event itself — the hub uses seq to dedupe
        // a retried batch (this exact resend happens whenever a 2xx response is lost even though
        // the hub actually processed the batch; see lib/hub.mjs's ingestEvents doc comment).
        items: batch.map((rec) => ({ seq: rec.seq, event: rec.item })),
      });
      if (res.status >= 200 && res.status < 300) {
        outbox.ack(batch[batch.length - 1].seq);
      } else {
        console.warn(`[collector ${collectorId}] hub rejected events batch: HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[collector ${collectorId}] events send failed (will retry): ${err.message}`);
    } finally {
      sending = false;
    }
  }
  const senderTimer = setInterval(drainOutbox, 1000);

  // ---- snapshots: latest-wins, no queue (retried naturally next tick) ----
  async function sendSnapshot() {
    let state;
    try {
      // v3.3.1 — buildUnifiedState() is now async (parallelized git-status calls cascade up to
      // here); awaited inside this try so a rejected promise is still caught the same way a thrown
      // error always was.
      state = await projectManager.buildUnifiedState(config);
    } catch (err) {
      console.warn(`[collector ${collectorId}] snapshot build failed: ${err.message}`);
      return;
    }
    try {
      const res = await postJson(hub, "/ingest", token, {
        type: "snapshot",
        collectorId,
        ts: new Date().toISOString(),
        projects: state.projects.filter((p) => p.enabled && p.board),
      });
      if (res.status < 200 || res.status >= 300) console.warn(`[collector ${collectorId}] hub rejected snapshot: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`[collector ${collectorId}] snapshot send failed (will retry next tick): ${err.message}`);
    }
  }
  const snapshotTimer = setInterval(sendSnapshot, snapshotIntervalMs);
  sendSnapshot(); // don't wait a full interval for the hub's first picture

  // ---- heartbeat: never queued, a miss is honestly a miss ----
  async function sendHeartbeat() {
    try {
      const res = await postJson(hub, "/ingest", token, {
        type: "heartbeat",
        collectorId,
        ts: new Date().toISOString(),
        projectKeys: projects.map((p) => p.key),
      });
      if (res.status < 200 || res.status >= 300) console.warn(`[collector ${collectorId}] hub rejected heartbeat: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`[collector ${collectorId}] heartbeat failed: ${err.message}`);
    }
  }
  const heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
  sendHeartbeat();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[collector ${collectorId}] ${signal} received — flushing outbox (${outbox.size()} pending) and shutting down`);
    clearInterval(senderTimer);
    clearInterval(snapshotTimer);
    clearInterval(heartbeatTimer);
    projectManager.stopAll();
    await drainOutbox(); // best-effort final flush — anything left stays durably queued on disk for the next run
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`[collector] fatal: ${err.message}`);
  process.exit(1);
});
