// The liveness classifier shared by transcripts.mjs (per-agent), board-state.mjs (roll-up for the
// narrative strip + stall list), and kanban.mjs (card accent). ONE function decides the state
// everywhere it's shown so the color dot, the kanban card, and the narrative sentence can never
// disagree about whether an agent is stalled (single source of truth — no-drift).
//
// States (owner spec, M3 + M7, "done" added per a real false-positive the owner caught live —
// build-dashboard3 had deliberately stood down after finishing, but showed as "possibly stalled",
// a red/alarming state; the M2 trust cost of a false alarm is real, so completion semantics in the
// agent's own sign-off now win over a pure quiet-timer read):
//   live      quiet < liveWindowMs                          green pulse  — streaming right now
//   done      quiet >= liveWindowMs + completion semantics   dim, calm    — finished/stood down on its own words
//   building  liveWindowMs..stallMs, no completion semantics amber        — active, last tool edits/writes/runs
//   verifying liveWindowMs..stallMs, no completion semantics blue         — active, last tool looks like a test/gate run
//   stalled   stallMs..idleMs, no completion semantics       red          — flagged, sorted to top, age shown
//   idle      >= idleMs, no completion semantics             dim          — collapsed behind a "+N idle" disclosure
//
// SCOPE NOTE: this is the single-last-action version of the classification the owner's fuller
// 8-state taxonomy directive describes (WORKING/COMPOSING/WAITING/DONE/STOPPED/PAUSED/POSSIBLY
// STUCK/ORPHANED, with multi-entry tail reading, meta.json/process-table cross-checks, and a
// fact-vs-inference evidence string per card). That's real, substantial new scope flagged
// separately to the orchestrator rather than rushed into this pass — this fix targets exactly the
// concrete bug reported (a stood-down agent reading as a false "stalled" alarm) with the data this
// module already has (one lastAction), not the full sensing-layer rebuild.

const VERIFY_RE = /\b(test|typecheck|tsc|lint|vitest|playwright|jest|build|biome|check|verify|gate)\b/i;
const BUILD_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "Bash", "MultiEdit"]);
// Completion/stand-down semantics in the agent's own final TEXT message (never a tool_use — a
// mid-tool-call agent is not done, no matter what an unrelated earlier sentence said).
// summary strings are truncated upstream (sanitizeAndTruncate, ~90 chars + "…") — a real miss
// found live this session: "Nothing further..." got cut to "Nothing furthe…", and \bnothing
// further\b (word-boundary-terminated) never matched. Phrases likely to survive truncation get a
// trailing \b; phrases likely to sit right at the cut point (a closing clause near the end of a
// sign-off) deliberately drop the trailing \b so a partial match still counts.
const DONE_RE =
  /\b(stand(?:ing)? down|stood down|standing down|final report|nothing furth|idling now|all\s+\S+\s+work was already completed|task(?:s)? (?:is|are|'s)? ?complete|complete[d]?[.,]|mission (?:is )?complete|fully closed|fully (?:complete|done|verified)|verified,? and committed|is fully clos)/i;

/** `lastAction` is { tool, summary, ts, kind } | null (as captured by transcripts.mjs). */
export function classifyAgentState(mtimeMs, thresholds, lastAction) {
  const quietMs = Date.now() - mtimeMs;
  const { liveWindowMs, stallThresholdMs, idleThresholdMs } = thresholds;
  if (quietMs < liveWindowMs) return { state: "live", quietMs };

  const isDoneSignoff = lastAction && lastAction.kind === "text" && DONE_RE.test(lastAction.summary || "");
  if (isDoneSignoff) return { state: "done", quietMs };

  if (quietMs >= idleThresholdMs) return { state: "idle", quietMs };
  if (quietMs >= stallThresholdMs) return { state: "stalled", quietMs };
  // "active but not this instant" — split into building/verifying by what the last tool call looked like.
  const tool = lastAction && lastAction.tool;
  const summary = (lastAction && lastAction.summary) || "";
  if (tool && BUILD_TOOLS.has(tool) && VERIFY_RE.test(summary)) return { state: "verifying", quietMs };
  return { state: "building", quietMs };
}

/** Plain-English age, e.g. "12s ago", "7m quiet", "2h ago". */
export function humanAge(ms) {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export const STATE_LABEL = {
  live: "live",
  building: "building",
  verifying: "verifying",
  stalled: "possibly stalled",
  idle: "idle",
  done: "done",
};
