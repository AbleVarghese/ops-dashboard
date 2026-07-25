// Per-PROJECT control ledger, stored under this package's own data/<projectKey>/control.json —
// v1 put control.json inside the target repo (tools/ops-dashboard/control.json); v2 is
// project-agnostic and must never write into a repo it's merely observing. The dashboard cannot
// reach into the orchestrator session directly — it writes REQUESTS the orchestrator's watchdog
// reads and honors. See README "Control contract".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dataDirFor } from "./paths.mjs";

const ALLOWED_ACTIONS = new Set(["ping", "stand_down", "respawn", "pause_campaign", "resume_campaign"]);

function controlPathFor(projectKey) {
  return path.join(dataDirFor(projectKey), "control.json");
}

function readRaw(projectKey) {
  try {
    const raw = fs.readFileSync(controlPathFor(projectKey), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.requests) ? parsed : { requests: [] };
  } catch {
    return { requests: [] };
  }
}

function writeRaw(projectKey, data) {
  const dir = dataDirFor(projectKey);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(controlPathFor(projectKey), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function ensureControlFile(projectKey) {
  if (!fs.existsSync(controlPathFor(projectKey))) writeRaw(projectKey, { requests: [] });
}

export function getControlState(projectKey) {
  const data = readRaw(projectKey);
  return { requests: data.requests, pendingCount: data.requests.filter((r) => !r.honored).length };
}

export function appendControlRequest(projectKey, { action, agent, note }) {
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`invalid action "${action}" — must be one of ${[...ALLOWED_ACTIONS].join(", ")}`);
  }
  const data = readRaw(projectKey);
  const entry = {
    id: crypto.randomUUID(),
    action,
    agent: agent || null,
    note: note || null,
    ts: new Date().toISOString(),
    honored: false,
  };
  data.requests.push(entry);
  writeRaw(projectKey, data);
  return entry;
}
