// v3.1 Stage 4 — red-flag auto-elevation. Per verify/V3.1-SPEC.md §3: "a failed test count, a
// build error, a death, an error streak surfaces itself into the attention band (Overview) +
// narrative, automatically — never buried at normal feed scroll depth." This module is the single
// rule for "is this event a red flag" — consumed by lib/feed.mjs (tags every emitted event) and
// lib/project-manager.mjs (aggregates the attention band) — one definition, not two independently
// maintained lists (SSOT, per this project's own no-drift discipline).
import { EVENT_KINDS } from "./event-kinds.mjs";

/** True when `event` should auto-elevate into the attention band. Two sources: (1) the event's
 * KIND is intrinsically a red flag (event-kinds.mjs's `redFlag: true` — death/error/a destructive
 * command), or (2) a `test_result` event that specifically reports failures (a passing test run is
 * NOT a red flag even though the kind exists for both outcomes — the flag depends on the DATA, not
 * just the kind, which is why this can't be fully expressed as a static per-kind table alone).
 * Never throws — a malformed event is not a flag (fails safe: absence of evidence is not itself
 * elevated, matching this project's own "never assert past what's known" discipline). */
export function isRedFlag(event) {
  if (!event || typeof event !== "object" || !event.kind) return false;
  const def = EVENT_KINDS[event.kind];
  if (def && def.redFlag) return true;
  if (event.kind === "test_result" && typeof event.failed === "number" && event.failed > 0) return true;
  return false;
}
