// v3.1 Stage 1 (the correctness law's evidence layer): gathers raw evidence from every available
// ground-truth source WITHOUT classifying. The 8-state classifier (Stage 2) consumes this as a
// pure function's input — this module's ONLY job is honest, tested evidence-gathering.
//
// REAL FINDINGS from auditing all 8,208 real subagents/*.meta.json files on this machine (v3.1
// Stage 1 — read the actual shape before building around an assumed one, per the correctness
// law's own rule; full union + combination breakdown recorded in verify/V3.1-SPEC.md):
//
//   1. meta.json carries ONLY static spawn-time metadata — agentType, description, model,
//      teamName, parentAgentId, worktree info, spawnDepth, color, permissionMode, etc. There is
//      NO status/completion/idleReason/exitReason field anywhere, across all 8,208 files, zero
//      exceptions. It is useful as EVIDENCE-STRING CONTEXT (a "spawn brief" — what this agent was
//      asked to do), never as a liveness/completion signal. This corrects an assumption in the
//      owner's original directive ("meta.json ... may include authoritative status").
//
//   2. Every meta.json carrying a `taskKind` has the value "in_process_teammate" — subagents are
//      multiplexed within ONE orchestrator OS process, not separate processes with their own PID.
//      A per-subagent "process table" cross-check is therefore not a real available signal on
//      this machine's actual data. Scoped honestly below rather than faking a check that cannot
//      be meaningful at the subagent level.
import fs from "node:fs";
import { getControlState } from "./control.mjs";

const TAIL_ENTRIES = 2; // "within the last ~2 entries" per the owner's done-vs-stalled directive
// PERFORMANCE FIX (found live, this session): the first version of this function read the ENTIRE
// transcript file on every call to get the last 2 lines. transcripts.mjs calls it once per agent
// on every buildUnifiedState tick (every feed.refreshMs, default 5s) — with real transcript files
// up to 6.7MB and 5 real watched projects on this machine, that made server startup take 33s and
// would have made EVERY 5s poll cycle re-read tens of megabytes forever. Fixed: read only the last
// TAIL_READ_BYTES of the file via a positioned read, never the whole thing, regardless of file size.
const TAIL_READ_BYTES = 65536; // 64KB — comfortably fits the last 2 assistant JSONL entries in the overwhelming majority of real transcripts (verified against real data on this machine)

/** Reads the last `maxBytes` of a file via a positioned read — never more than that, regardless of
 * file size. Returns `{ text, truncated }` — `truncated` is true only when the read genuinely
 * started mid-file (start > 0), so the caller knows whether the first line it sees might be a
 * fragment (drop it) or is a real, complete line (keep it) — a real bug in this function's first
 * draft: for any file SMALLER than maxBytes, `start` is always 0, so the "first line might be
 * truncated" assumption was wrong and would have silently dropped a genuine line. Never throws —
 * `{ text: "", truncated: false }` on any error, same degrade-gracefully contract a full read had. */
function readTailBytes(filePath, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const readSize = Math.min(maxBytes, size);
    const start = size - readSize;
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, start);
    return { text: buf.toString("utf8"), truncated: start > 0 };
  } catch {
    return { text: "", truncated: false };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed or never opened — nothing to do */
      }
    }
  }
}

/** Reads the last N parsed assistant actions from a transcript .jsonl file's tail (bounded read —
 * see TAIL_READ_BYTES above; a snapshot, distinct from the live-feed's incremental offset-tracked
 * tailing). Returns oldest-first, at most N entries. Never throws — a missing/corrupt file, or one
 * whose last N actions happen to exceed the read window, yields fewer entries (honest degradation,
 * not a crash) rather than falling back to an unbounded full-file read. */
export function lastTranscriptActions(filePath, n = TAIL_ENTRIES) {
  const { text, truncated } = readTailBytes(filePath, TAIL_READ_BYTES);
  let lines = text.split("\n").filter(Boolean);
  // Only drop the first line when the read GENUINELY started mid-file (truncated===true) — for a
  // file smaller than the read window, `start` was 0, every line is complete, and dropping the
  // first one would silently discard a real line (the bug this fix's own header comment records).
  if (truncated && lines.length > 1) lines = lines.slice(1);
  const actions = [];
  for (let i = lines.length - 1; i >= 0 && actions.length < n; i--) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!obj || obj.type !== "assistant" || !obj.message) continue;
    const content = Array.isArray(obj.message.content) ? obj.message.content : [];
    for (let c = content.length - 1; c >= 0 && actions.length < n; c--) {
      const item = content[c];
      if (item.type === "tool_use") {
        actions.unshift({ kind: "tool_use", tool: item.name, ts: obj.timestamp || null });
      } else if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
        actions.unshift({ kind: "text", text: item.text.trim(), ts: obj.timestamp || null });
      }
    }
  }
  return actions;
}

/** Reads the agent's own spawn-time meta.json, if present. CONTEXT ONLY — never a liveness
 * signal; see the module header's audited finding. Never throws. */
export function readSpawnMeta(metaFilePath) {
  try {
    const j = JSON.parse(fs.readFileSync(metaFilePath, "utf8"));
    return {
      agentType: j.agentType || null,
      description: j.description || null,
      model: j.model || null,
      teamName: j.teamName || null,
      parentAgentId: j.parentAgentId || null,
      worktreeBranch: j.worktreeBranch || null,
    };
  } catch {
    return null;
  }
}

/** Cross-checks this project's control.json for requests naming this agent. Fact stated as-is:
 * "a request exists / is honored" — not an inference about whether the orchestrator actually
 * acted on it faster or slower than the ledger shows. The classifier (Stage 2) decides how much
 * weight this carries alongside the other evidence, not this module. */
export function controlEvidence(projectKey, agentName) {
  if (!projectKey || !agentName) return { hasPendingRequest: false, hasHonoredRequest: false, requests: [] };
  const state = getControlState(projectKey);
  const mine = state.requests.filter((r) => r.agent === agentName);
  return {
    hasPendingRequest: mine.some((r) => !r.honored),
    hasHonoredRequest: mine.some((r) => r.honored),
    requests: mine,
  };
}

/** Gathers ALL available evidence for one agent, WITHOUT classifying — Stage 2 consumes this
 * object as a pure function's input. `mtimeMs` comes from the caller (transcripts.mjs already
 * stats the file); `metaFilePath` is derived from the same base name as the transcript file (the
 * existing `agent-a<id>.jsonl` + `agent-a<id>.meta.json` convention). */
export function gatherAgentEvidence({ filePath, metaFilePath, mtimeMs, projectKey, agentName }) {
  const quietMs = Date.now() - mtimeMs;
  const tail = lastTranscriptActions(filePath, TAIL_ENTRIES);
  const spawnMeta = metaFilePath ? readSpawnMeta(metaFilePath) : null;
  const control = controlEvidence(projectKey, agentName);
  return {
    quietMs,
    mtimeMs,
    tail, // oldest-first, up to TAIL_ENTRIES most recent actions
    lastAction: tail.length ? tail[tail.length - 1] : null,
    secondLastAction: tail.length > 1 ? tail[tail.length - 2] : null,
    spawnMeta, // context only — never a liveness signal (see module header finding #1)
    control,
    // See module header finding #2: not a per-subagent signal on this machine's real data.
    processMatch: {
      scope: "session-level-only",
      note: "subagents are in_process_teammate (no individual PID); a per-subagent process-table check is not a real available signal on this machine's data",
    },
  };
}
