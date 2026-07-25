// v3.1 Stage 4 (the sensing layer) — error/death recognition. Per verify/V3.1-SPEC.md §3: "API
// errors, session-limit deaths, permission denials, tool errors — classified from transcript
// content, feeding directly into taxonomy state 5 (STOPPED/KILLED)'s evidence." This module is the
// piece Stage 2's STOPPED_RE text-only heuristic (lib/agent-status-v31.mjs) is documented as
// depending on for richer classification (verify/V3.1-PLAN.md row 4's dependency note) — it does
// NOT replace that heuristic (Stage 2 stays a pure function of the evidence layer's shape); it adds
// a STRUCTURED category on top, for feed events and richer evidence strings.
//
// Two real signal shapes exist on this machine, found by auditing actual transcript lines (the
// correctness law's "read the real shape before building around an assumed one" applied again,
// same discipline as verify/META-JSON-AUDIT.md):
//
//   1. A STRUCTURED api-error line — the raw parsed JSONL object itself carries `isApiErrorMessage:
//      true`, `error: "rate_limit"`, `apiErrorStatus: 429`, alongside ordinary assistant text. REAL
//      CAPTURED EXAMPLE (this exact campaign, this machine,
//      ~/.claude/projects/-Users-Able-keralora/302b18c1.../subagents/agent-abuild-rbac-*.jsonl):
//        { "type":"assistant", "message": { "content":[{"type":"text","text":
//          "You've hit your session limit · resets 1:20am (America/Toronto)"}] },
//          "error":"rate_limit", "isApiErrorMessage":true, "apiErrorStatus":429 }
//      This is a FAR more reliable session-death signal than text-pattern matching — it's a typed
//      field the harness itself sets, not prose an agent chose to write.
//   2. UNSTRUCTURED tool-output text — a Bash tool_result body, or an assistant's own words,
//      carrying permission-denial / tool-error / process-crash language. REAL CAPTURED EXAMPLES
//      (same campaign): `Permission to use Bash with command … has been denied.`,
//      `File does not exist. Note: your current working directory is …`, and a genuine Node.js
//      process crash: `node:internal/modules/cjs/loader:1404\n  throw err;\n  ^\n\nError: Cannot
//      find module 'dotenv'`.
//
// `recognizeError` accepts EITHER shape — a raw parsed transcript-line object (checked for the
// structured fields first, since when present those are strictly more trustworthy) or a plain
// text string (tool_result content, an assistant's text, anything else). Returns `null` when
// nothing recognized — most transcript lines and most tool output are NOT errors, and misfiring
// here would falsely elevate normal activity (see red-flag auto-elevation, which consumes this).

const PERMISSION_DENIED_RE = /\bpermission (?:to use|denied)\b.*\bdenied\b|\baccess denied\b|\bEACCES\b/i;
const TOOL_ERROR_RE = /\bfile does not exist\b|<tool_use_error>|\bcommand not found\b|\bno such file or directory\b|\bENOENT\b/i;
// A genuine Node.js uncaught-exception crash signature — the literal two-line shape Node prints to
// stderr before exiting (`throw err;` followed by a bare `^` caret line), distinct from a mere
// "Error:" substring appearing inside normal log output (which would false-positive constantly).
const PROCESS_DEATH_RE = /throw (?:err|error);\s*\n?\s*\^|\bSegmentation fault\b|\bFATAL ERROR\b|\bcore dumped\b/i;
// Session/API-limit language an agent might state in its OWN words (a weaker signal than the
// structured isApiErrorMessage field, but real transcripts do sometimes narrate this in prose too
// — kept as a fallback, not the primary path).
const SESSION_LIMIT_TEXT_RE = /\bsession limit\b|\bcontext limit\b|\brate limit(?:ed)?\b/i;

function truncate(text, max = 160) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function textFromApiErrorLine(obj) {
  const content = obj.message && Array.isArray(obj.message.content) ? obj.message.content : [];
  const textItem = content.find((c) => c && c.type === "text" && typeof c.text === "string");
  return textItem ? textItem.text : "";
}

/** Recognizes error/death signatures. `input` is either a raw parsed transcript-line object (an
 * assistant line, possibly carrying `isApiErrorMessage`) or a plain string (tool output / any
 * text). Returns `{ category, detail, fatal }` or `null`. `fatal: true` means this is
 * termination-class evidence (feeds STOPPED/KILLED); `fatal: false` means real but recoverable
 * friction (a denied permission, a missing file) that does not by itself mean the agent died. Never
 * throws. */
export function recognizeError(input) {
  if (input && typeof input === "object" && input.isApiErrorMessage === true) {
    const code = typeof input.error === "string" ? input.error : "unknown";
    const status = input.apiErrorStatus;
    const text = textFromApiErrorLine(input);
    const category = /session limit|context limit/i.test(text) || code === "rate_limit" ? "session_limit" : "api_error";
    return {
      category,
      detail: text ? truncate(text) : `API error: ${code}${status ? ` (HTTP ${status})` : ""}`,
      fatal: true,
    };
  }

  const text = typeof input === "string" ? input : input && typeof input === "object" ? textFromApiErrorLine(input) : "";
  if (!text) return null;

  if (PROCESS_DEATH_RE.test(text)) {
    return { category: "process_death", detail: truncate(text), fatal: true };
  }
  if (SESSION_LIMIT_TEXT_RE.test(text)) {
    return { category: "session_limit", detail: truncate(text), fatal: true };
  }
  if (PERMISSION_DENIED_RE.test(text)) {
    return { category: "permission_denied", detail: truncate(text), fatal: false };
  }
  if (TOOL_ERROR_RE.test(text)) {
    return { category: "tool_error", detail: truncate(text), fatal: false };
  }
  return null;
}
