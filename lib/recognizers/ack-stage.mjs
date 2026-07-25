// v3.1 Stage 4 (the sensing layer) — token/spawn/ACK semantics. Per verify/V3.1-SPEC.md §3:
// "extend to stage-ping/ACK detection in SendMessage-shaped tool calls" so the dashboard surfaces
// them as first-class events rather than raw truncated text. Token-usage fields (tokensIn/
// tokensOut/turnCount) and spawn events (`agent_spawned`, feed-transcripts.mjs) are ALREADY
// surfaced by v3.0/Stage-3 code — this module's job is narrowly the ACK/STAGE protocol-message
// classification, not a re-implementation of that existing surfacing.
//
// This dashboard's own multi-agent build campaigns are dogfooded as the source of truth for what
// this protocol actually looks like in real usage (this project's CLAUDE.md-equivalent convention:
// a spawned agent sends an immediate SendMessage ACK, then periodic SendMessage STAGE pings, per
// the coordination protocol this campaign itself follows). Real captured fixtures (this machine,
// ~/.claude/projects/-Users-Able-keralora/302b18c1.../subagents/*.jsonl — verbatim SendMessage
// tool_use `summary`/`message` fields from this exact campaign, never reconstructed):
//   ACK    {"to":"main","summary":"ACK: P9c feature block","message":"ACK: P9c feature block. ..."}
//   ACK    {"to":"team-lead","summary":"ACK: starting RBAC build (Sonnet)","message":"ACK — starting ..."}
//   STAGE  {"to":"team-lead","summary":"STAGE: alive, adding named-test-type coverage now", ...}
//   DONE   {"to":"main","summary":"Debt-closure done, standing down", ...}  (already handled by
//          agent-status-v31.mjs's DONE_RE — recognized here too, for the feed's `ack`/`stage`/`done`
//          vocabulary, not to duplicate the taxonomy classifier's own job)

// "ACK" at the start, optionally followed by ":" or "—"/"-" (both real punctuation styles seen
// above), OR the word "acknowledged" opening the message (also a real observed variant).
const ACK_RE = /^\s*ACK\b\s*[:\-—]?|^\s*Acknowledged\b/i;
// "STAGE" as an explicit protocol marker (this campaign's own convention — see the team-lead
// handoff instruction requiring "STAGE pings"), OR a bare stage-number progress marker.
const STAGE_RE = /^\s*STAGE\b\s*[:\-—]?/i;

function truncate(text, max = 140) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Recognizes an ACK/STAGE-ping-shaped agent message. `input` is either a SendMessage tool_use's
 * `{ to, summary, message }` input object, or a plain text string. Returns `{ type: "ack" |
 * "stage_ping", to, summary }` or `null` — most agent messages are neither (ordinary progress
 * text, a completion report matched by agent-status-v31's own DONE detection instead), and this
 * recognizer must not overreach into classifying those. Never throws.
 *
 * Classification reads `message` (the actual protocol text as sent) in preference to `summary` —
 * `summary` is a short human-facing preview the SendMessage tool generates ("a 5-10 word summary"
 * per its own schema) and real captured traffic shows it can reword away from the literal ACK/
 * STAGE marker even when the underlying message clearly opens with one (e.g. summary "Debt-closure
 * done, standing down" for a message that opens "Acknowledged. …") — `message` is the ground truth
 * for what the agent actually wrote. The returned `summary` field still prefers the SHORT summary
 * text for display when present (cleaner for the feed row), falling back to the message itself. */
export function recognizeAckStage(input) {
  let to = null;
  let summary = null;
  let message = null;

  if (typeof input === "string") {
    message = input;
  } else if (input && typeof input === "object") {
    to = typeof input.to === "string" ? input.to : null;
    summary = typeof input.summary === "string" ? input.summary : null;
    message = typeof input.message === "string" ? input.message : null;
  }
  const classifyText = message || summary;
  if (!classifyText) return null;

  const displayText = summary || message;
  if (ACK_RE.test(classifyText)) {
    return { type: "ack", to, summary: truncate(displayText) };
  }
  if (STAGE_RE.test(classifyText)) {
    return { type: "stage_ping", to, summary: truncate(displayText) };
  }
  return null;
}
