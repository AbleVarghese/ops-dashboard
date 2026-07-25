// Parses subagent JSONL transcripts for ONE project (never a machine-wide scan). v1 incident
// (preserved here as the reason this matters): a literal `~/.claude/projects/*/*` glob hung the
// server outright — 2.2GB across 356 project dirs on the dev machine. Every call here takes the
// resolved `project` explicitly (see paths.mjs) and, if that project's Claude Code dir doesn't
// exist yet, returns an empty board rather than falling back to scanning everything — a
// project-agnostic tool must degrade to "no data for this project" cleanly, not silently widen
// its scope. v3: also captures each agent's LAST tool_use/text (the "currently doing" live line,
// M1) and classifies liveness (agent-status.mjs, M7) — both consumed by board-state.mjs.
import fs from "node:fs";
import path from "node:path";
import { deriveAgentName } from "./agent-name.mjs";
import { summarizeToolInput } from "./summarize-tool.mjs";
import { sanitizeAndTruncate } from "./sanitize.mjs";
import { gatherAgentEvidence } from "./agent-evidence.mjs";
import { classifyAgentV31 } from "./agent-status-v31.mjs";

const MAX_READABLE_BYTES = 50 * 1024 * 1024;

// path -> { mtimeMs, size, parsed } — full reparse only when the file actually changed.
const fileCache = new Map();
// filePath -> the last classified v3.1 state string. Deliberately separate from fileCache: a
// cache HIT on file content still needs a FRESH classification every call (quietMs depends on
// Date.now(), not file content) — this map exists purely to feed classifyAgentV31's hysteresis
// (previousState), not to skip reclassification. Never persisted to disk — resets on server
// restart, which is fine: hysteresis only needs to survive between polls within one running
// server session, not across restarts.
const previousStateCache = new Map();

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// SCALE FIX (found live this session, real data): a project with a long history can have
// thousands of agent transcript files — LawyerServed on this machine has 3,543 across 88 sessions
// (1.8GB). Scanning + parsing all of them on EVERY poll (buildUnifiedState runs every
// feed.refreshMs, default 5s) made that one project's board build take 10+ SECONDS, breaking M1's
// realtime promise for the whole dashboard (a slow project delays the unified snapshot every
// project shares). A live dashboard cares about RECENT activity, not deep history — capped to the
// most-recently-modified MAX_AGENT_FILES, same "never scan more than the tool actually needs"
// principle as the v1 machine-wide-glob incident documented above.
const MAX_AGENT_FILES = 300;

function findAgentFiles(project) {
  if (!project.claudeProjectDirExists) return [];
  const results = [];
  for (const sessionEnt of safeReaddir(project.claudeProjectDir)) {
    if (!sessionEnt.isDirectory()) continue;
    const subagentsPath = path.join(project.claudeProjectDir, sessionEnt.name, "subagents");
    for (const fileEnt of safeReaddir(subagentsPath)) {
      if (fileEnt.isFile() && fileEnt.name.startsWith("agent-a") && fileEnt.name.endsWith(".jsonl")) {
        const filePath = path.join(subagentsPath, fileEnt.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(filePath).mtimeMs;
        } catch {
          /* file vanished between readdir and stat — skip it below via the 0-mtime sort-to-bottom */
        }
        results.push({ filePath, sessionDir: sessionEnt.name, mtimeMs });
      }
    }
  }
  if (results.length > MAX_AGENT_FILES) {
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return results.slice(0, MAX_AGENT_FILES);
  }
  return results;
}

/** Last tool_use (or, absent that, last text) content block in an assistant message -> the
 * "currently doing" line: { tool, summary, ts, kind }. */
function lastActionFromMessage(obj, lastAction) {
  if (!obj || obj.type !== "assistant" || !obj.message) return lastAction;
  const ts = obj.timestamp || null;
  const content = Array.isArray(obj.message.content) ? obj.message.content : [];
  for (const item of content) {
    if (item.type === "tool_use") {
      return { tool: item.name, summary: sanitizeAndTruncate(summarizeToolInput(item.name, item.input), 90), ts, kind: "tool_use" };
    }
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      return { tool: null, summary: sanitizeAndTruncate(item.text.trim(), 90), ts, kind: "text" };
    }
  }
  return lastAction;
}

function parseAgentFile(entry) {
  const { filePath, sessionDir } = entry;
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { ...cached.parsed, mtimeMs: stat.mtimeMs };
  }
  if (stat.size > MAX_READABLE_BYTES) return cached ? cached.parsed : null;

  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return cached ? cached.parsed : null;
  }

  let agentId = null;
  let cwd = null;
  let gitBranch = null;
  let sessionId = null;
  const models = new Set();
  let turnCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let firstTs = null;
  let lastTs = null;
  let lastAction = null;

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // tolerate a partial trailing line mid-write
    }
    if (!agentId && obj.agentId) agentId = obj.agentId;
    if (!cwd && obj.cwd) cwd = obj.cwd;
    if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch;
    if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
    if (obj.timestamp) {
      if (!firstTs) firstTs = obj.timestamp;
      lastTs = obj.timestamp;
    }
    if (obj.type === "assistant" && obj.message) {
      turnCount++;
      if (obj.message.model) models.add(obj.message.model);
      const usage = obj.message.usage;
      if (usage) {
        tokensIn += usage.input_tokens || 0;
        tokensOut += usage.output_tokens || 0;
      }
      lastAction = lastActionFromMessage(obj, lastAction);
    }
  }

  const name = deriveAgentName(agentId, path.basename(filePath));
  const parsed = {
    filePath,
    sessionDir,
    agentId,
    name,
    cwd,
    gitBranch,
    sessionId,
    models: [...models],
    turnCount,
    tokensIn,
    tokensOut,
    tokensTotal: tokensIn + tokensOut,
    firstTs,
    lastTs,
    lastAction,
    sizeBytes: stat.size,
  };
  fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
  return { ...parsed, mtimeMs: stat.mtimeMs };
}

/** The raw {filePath, sessionDir} entries — exposed for the live-feed watcher. */
export function listAgentFileEntries(project) {
  return findAgentFiles(project);
}

const DEFAULT_THRESHOLDS = {
  liveWindowMs: 60000,
  stallThresholdMs: 300000,
  idleThresholdMs: 1800000, // unused by v3.1 classification below; kept for any caller still on v3.0 defaults
  orphanThresholdMs: 86400000,
  hysteresisGraceMs: 15000,
};

// v3.1 8-state priority (0 = needs eyes first): possibly_stuck/stopped are real, unresolved
// problems (tied for top attention); orphaned is a confirmed-dead inference, still flagged but
// less actionable; working/composing/waiting is normal active operation; paused is a deliberate,
// expected state; done is fully resolved — least urgent, shown but never demanding attention.
const RANK_V31 = { possibly_stuck: 0, stopped: 0, orphaned: 1, working: 2, composing: 2, waiting: 2, paused: 3, done: 4 };
const NEEDS_ATTENTION = new Set(["possibly_stuck", "stopped", "orphaned"]);
const ACTIVE_STATES = new Set(["working", "composing", "waiting"]);

/** Every subagent transcript found for this project, classified (v3.1 8-state, lib/agent-status-
 * v31.mjs) + sorted: possibly_stuck/stopped first (oldest-quiet-first within that tier so the
 * worst offender leads), then orphaned, then working/composing/waiting (newest first), then
 * paused, then done last. Never throws — degrades to []. */
export function getAgents(project, thresholds = DEFAULT_THRESHOLDS) {
  const agents = [];
  for (const entry of findAgentFiles(project)) {
    const parsed = parseAgentFile(entry);
    if (!parsed) continue;

    const metaFilePath = entry.filePath.replace(/\.jsonl$/, ".meta.json");
    const evidenceObj = gatherAgentEvidence({
      filePath: entry.filePath,
      metaFilePath: fs.existsSync(metaFilePath) ? metaFilePath : null,
      mtimeMs: parsed.mtimeMs,
      projectKey: project.projectKey,
      agentName: parsed.name,
    });
    const previous = previousStateCache.get(entry.filePath) || null;
    const classification = classifyAgentV31(evidenceObj, thresholds, previous);
    previousStateCache.set(entry.filePath, classification.state);

    // Sanitize the evidence string before it ever reaches the UI — agent-evidence.mjs's raw tail
    // read is NOT secret-stripped by design (Stage 1 is a pure evidence-gathering layer with no
    // display concerns); this is the display boundary where that happens, same discipline v3.0
    // already applies to every other UI-facing string.
    const safeEvidence = sanitizeAndTruncate(classification.evidence, 160);

    agents.push({
      ...parsed,
      active: ACTIVE_STATES.has(classification.state),
      state: classification.state,
      confidence: classification.confidence,
      evidence: safeEvidence,
      sourceConflict: classification.sourceConflict === true,
      quietMs: evidenceObj.quietMs,
    });
  }
  agents.sort((a, b) => {
    const r = RANK_V31[a.state] - RANK_V31[b.state];
    if (r !== 0) return r;
    if (NEEDS_ATTENTION.has(a.state)) return b.quietMs - a.quietMs; // longest-quiet worst-offender leads
    return (b.lastTs || "").localeCompare(a.lastTs || "");
  });
  return agents;
}
