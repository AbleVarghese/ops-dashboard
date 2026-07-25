// v3.1 Stage 2 — the 8-state classifier. Built and tested STANDALONE, per verify/V3.1-PLAN.md's
// sequencing: this is a pure function of the evidence lib/agent-evidence.mjs (Stage 1) gathers,
// NOT YET wired into the live UI (transcripts.mjs/kanban.mjs/narrative.mjs/app.js still run
// v3.0's accepted, shipped 6-state `classifyAgentState` from agent-status.mjs — that cutover is
// Stage 3, a separate, reviewable step). Two files stay side by side deliberately until Stage 3
// deletes the old one — never both live in the UI at once.
//
// Consumes the CORRECTED evidence model from lib/agent-evidence.mjs / verify/META-JSON-AUDIT.md:
// transcript tail + control.json are real cross-checkable signals; spawn-meta is context only;
// a true per-subagent process check does not exist on this machine's data (see STOPPED's scope
// note below — this is the honest boundary of what Stage 2 can detect, not glossed over).
//
// FACT vs. INFERENCE (the correctness law): every returned state carries `confidence: "fact" |
// "inference"` and an `evidence` string a novice can read as the "why." PAUSED/DONE/STOPPED/
// WORKING/COMPOSING/WAITING are backed by direct evidence (a control record, the agent's own
// words) — asserted as fact. POSSIBLY_STUCK/ORPHANED are inferences from absence-of-evidence
// (no completion signal, just quiet) — always labeled as such, never asserted plainly.
import { humanAge } from "./agent-status.mjs";

// Deliberate stand/pause language in the agent's own final TEXT (never a tool_use — see
// agent-status.mjs's identical DONE_RE rationale re: truncation-tolerant matching).
const DONE_RE =
  /\b(stand(?:ing)? down|stood down|standing down|final report|nothing furth|idling now|all\s+\S+\s+work was already completed|task(?:s)? (?:is|are|'s)? ?complete|complete[d]?[.,]|mission (?:is )?complete|fully closed|fully (?:complete|done|verified)|verified,? and committed|is fully clos)/i;

// A deliberate WAIT/poll pattern — the agent said it's waiting on something specific, not just
// gone quiet. Distinct from POSSIBLY_STUCK (quiet with NO explanation).
const WAIT_RE = /\b(waiting (?:on|for)|blocked on|pending on|polling|watching for|will resume once|paused until)/i;

// Terminal-failure language IN THE AGENT'S OWN WORDS. SCOPE NOTE (honest boundary, not an
// oversight): Stage 2 has no tool_result/API-error-object inspection — that's the sensing layer's
// job (v3.1 Stage 4, verify/V3.1-SPEC.md §3). A SILENT kill (the session dies mid-tool_use with no
// explanatory text) is NOT detected as STOPPED here; it correctly falls through to
// POSSIBLY_STUCK/ORPHANED instead, which is honest (Stage 2 genuinely cannot tell "silently killed"
// from "still silently working" without deeper tooling) rather than a false-precision guess.
const STOPPED_RE = /\b(session limit|context limit|rate limit(?:ed)?|hit an? error and (?:cannot|can't) continue|being (?:cut off|terminated)|session (?:was )?(?:killed|terminated)|API error)/i;

function truncate(text, max = 90) {
  const t = String(text || "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function describeAction(action) {
  if (!action) return "no recorded action";
  return action.kind === "tool_use" ? `tool call: ${action.tool}` : `text: "${truncate(action.text)}"`;
}

const DEFAULT_HYSTERESIS_GRACE_MS = 15000;

/**
 * Pure function: (evidence, thresholds, previousState) -> { state, confidence, evidence }.
 * `evidence` is `gatherAgentEvidence()`'s output (lib/agent-evidence.mjs). `thresholds` extends
 * v3.0's { liveWindowMs, stallThresholdMs } with `orphanThresholdMs` (defaults to 24h) and an
 * optional `hysteresisGraceMs` (default 15s). `previousState` is the LAST state this same agent
 * was classified as (or null on first classification) — used only for hysteresis at the
 * POSSIBLY_STUCK/ORPHANED entry boundary; every other branch is independent of history.
 */
export function classifyAgentV31(evidenceObj, thresholds, previousState = null) {
  const { liveWindowMs, stallThresholdMs, orphanThresholdMs = 24 * 3600 * 1000, hysteresisGraceMs = DEFAULT_HYSTERESIS_GRACE_MS } = thresholds;
  const { quietMs, lastAction, control } = evidenceObj;
  const text = lastAction && lastAction.kind === "text" ? lastAction.text : null;

  // 1. PAUSED — an explicit, HONORED control request. Highest priority: a deliberate action
  //    overrides any timer-based read. Fact: the control ledger recorded it. SOURCE CONFLICT
  //    handling (the correctness law: "when sources disagree, show the conflict, don't arbitrate
  //    silently"): if control says paused/honored but the transcript shows FRESH activity
  //    (quietMs < liveWindowMs — the agent is demonstrably still doing something right now), that
  //    is a genuine disagreement between the two real evidence sources. The control ledger is
  //    still the higher-authority signal for the STATE returned (a human/orchestrator action beats
  //    a timer read), but the conflict is stated in the evidence string, not hidden.
  if (control && control.hasHonoredRequest) {
    const pauseReq = (control.requests || []).find((r) => r.honored && (r.action === "pause_campaign" || r.action === "stand_down"));
    if (pauseReq) {
      const conflicting = quietMs < liveWindowMs;
      return {
        state: "paused",
        confidence: "fact",
        evidence: conflicting
          ? `paused via control request at ${pauseReq.ts}, but transcript shows activity ${humanAge(quietMs)} ago — CONFLICTING SIGNALS`
          : `paused via control request at ${pauseReq.ts}`,
        sourceConflict: conflicting,
      };
    }
  }

  // 2. DONE — a genuine sign-off, in the agent's own words. Fact: it asserted this itself.
  if (text && DONE_RE.test(text)) {
    return { state: "done", confidence: "fact", evidence: `sign-off: "${truncate(text)}"` };
  }

  // 3. STOPPED/KILLED — terminal-failure language in the agent's own tail. Fact (as far as it
  //    goes — see STOPPED_RE's scope note: this only catches EXPLAINED terminations).
  if (text && STOPPED_RE.test(text)) {
    return { state: "stopped", confidence: "fact", evidence: `session-ending language: "${truncate(text)}"` };
  }

  // 4. WORKING/COMPOSING — currently active (within the live window). Fact: recent mtime.
  if (quietMs < liveWindowMs) {
    if (lastAction && lastAction.kind === "tool_use") {
      return { state: "working", confidence: "fact", evidence: `last tool call ${humanAge(quietMs)} ago: ${lastAction.tool}` };
    }
    return { state: "composing", confidence: "fact", evidence: `composing, ${humanAge(quietMs)} ago` };
  }

  // 5. WAITING — a deliberate wait/poll pattern, still within a reasonable (pre-stall) window.
  //    Fact: the agent said what it's waiting on.
  if (text && WAIT_RE.test(text) && quietMs < stallThresholdMs) {
    return { state: "waiting", confidence: "fact", evidence: `waiting: "${truncate(text)}", ${humanAge(quietMs)} ago` };
  }

  // 6/7. ORPHANED / POSSIBLY STUCK — INFERENCES from absence of evidence, with hysteresis at the
  //    entry boundary: once already flagged, a slightly-lower quietMs (within the grace margin)
  //    does not immediately revert to an active state — only genuinely new evidence (a fresh
  //    lastAction, which resets quietMs near zero and is handled by branch 4 above) clears it.
  const wasFlagged = previousState === "possibly_stuck" || previousState === "orphaned";
  const effectiveOrphanThreshold = wasFlagged ? orphanThresholdMs - hysteresisGraceMs : orphanThresholdMs;
  const effectiveStallThreshold = wasFlagged ? stallThresholdMs - hysteresisGraceMs : stallThresholdMs;

  if (quietMs >= effectiveOrphanThreshold) {
    return {
      state: "orphaned",
      confidence: "inference",
      // M2 (plain language, no internal jargon leaking into UI copy) — a real issue this string
      // had until caught by looking at the actual rendered Agents tab: it used to cite
      // "lib/agent-evidence.mjs's processMatch note", an internal file reference meaningless to a
      // novice viewer. The technical limitation (no per-subagent process check exists yet) is
      // still true and still documented — in the code comments and verify/V3.1-SPEC.md — just not
      // in front of the person reading the dashboard.
      evidence: `quiet ${humanAge(quietMs)}, no sign-off — presumed dead`,
    };
  }
  if (quietMs >= effectiveStallThreshold) {
    return {
      state: "possibly_stuck",
      confidence: "inference",
      evidence: `quiet ${humanAge(quietMs)}, mid-task — ${describeAction(lastAction)}`,
    };
  }

  // 8. Fallback — still nominally active (between liveWindowMs and stallThresholdMs), not yet
  //    flagged. Fact: based on the last recorded action type.
  if (lastAction && lastAction.kind === "tool_use") {
    return { state: "working", confidence: "fact", evidence: `last tool call ${humanAge(quietMs)} ago: ${lastAction.tool}` };
  }
  return { state: "composing", confidence: "fact", evidence: `last activity ${humanAge(quietMs)} ago` };
}

export const STATE_LABEL_V31 = {
  working: "working",
  composing: "composing",
  waiting: "waiting",
  done: "done",
  stopped: "stopped",
  paused: "paused",
  possibly_stuck: "possibly stuck",
  orphaned: "presumed dead",
};

export const STATE_COLOR_V31 = {
  working: "green-pulse",
  composing: "green",
  waiting: "blue",
  done: "dim-calm",
  stopped: "grey-red",
  paused: "amber",
  possibly_stuck: "red",
  orphaned: "dark-red",
};
