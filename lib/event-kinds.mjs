// v3.1 Stage 4 — the event vocabulary SSOT. Per verify/V3.1-PLAN.md's Stage 4 instruction ("land
// this as a single reviewed list before wiring, so the feed schema doesn't grow ad hoc per
// recognizer") and verify/V3.1-SPEC.md §3's suggested set (test-run, build, commit, tag, error,
// death, spawn, ack, stage, control, file-edit, gate-pass/gate-fail).
//
// Reconciling that suggested set against what actually exists and what the built recognizers
// actually produce (documented here since the two source docs used different naming conventions —
// SPEC's hyphenated nouns vs. PLAN's snake_case verbs — and this is the single, deliberate,
// reviewed resolution):
//   - commit / tag / agent_spawned already exist (feed-git.mjs, feed-transcripts.mjs, shipped in
//     v3.0) — NOT re-added as "new," kept exactly as-is (SSOT: one definition, not a rename churn).
//   - "file-edit" (spec) covers Edit AND Write (both mutate a file) — Read stays under the
//     existing generic `tool_use` kind (a new feed row per Read would flood the feed at normal
//     agent cadence; Edit/Write are the meaningfully rarer, more narratively-important actions).
//   - "test-run" (spec) is this module's `test_result` (PLAN's naming) — a parsed pass/fail/skip
//     count, not merely "a test command ran" (that's `command_test` below).
//   - "gate-pass/gate-fail" (spec) is folded into `test_result`'s own pass/fail state (its `failed`
//     count) rather than a separate kind — a duplicate concept would violate this project's own
//     single-source-of-truth discipline; the SAME event that carries the counts also carries
//     whether it passed.
//   - `control` is new: control.json pause/resume/stand_down requests, not previously fed into the
//     live feed at all (server.mjs's control route now emits one on append).
// This yields 15 NEW kinds this stage (beyond the 6 that already shipped):
//   file_edit, command_test, command_build, command_lint, command_git, command_db,
//   command_install, command_deploy, command_destructive, test_result, error, death, ack, stage,
//   control
// The PLAN's Stage-4 row estimated "12 new kinds" ("named but not yet enumerated," its own words) —
// pending this concrete landing. The actual count is 15, not 12: command_* intentionally expands
// past a single generic "command_run" kind, because the whole point of command classification
// (SPEC §3) is that the FEED shows what KIND of command ran, not just that Bash was invoked —
// collapsing them back into one kind would throw away the classification this stage was built to
// add. Documented honestly against the real landed list rather than force-fit to a stale estimate.
// classifyCommand's "other" category (most Bash calls — ls/cat/cd/grep, the read-only majority) is
// deliberately NOT its own feed kind — same reasoning as Read below: a feed row for every `ls`
// would flood the feed with the least narratively-useful events. "other"-classified commands (and
// Read) stay under the pre-existing generic `tool_use` kind.
//
// `redFlag: true` marks a kind that auto-elevates into the attention band (M0/Overview + narrative)
// without a human needing to notice it in normal feed scroll — see lib/red-flags.mjs, which reads
// this flag rather than hardcoding a second kind list (SSOT).
export const EVENT_KINDS = {
  // --- pre-existing (v3.0 / earlier v3.1 stages) — unchanged, included for one complete client-side map
  tool_use: { label: "tool call", color: "var(--accent)", redFlag: false },
  text: { label: "text", color: "var(--i3)", redFlag: false },
  agent_spawned: { label: "spawned", color: "var(--live)", redFlag: false },
  commit: { label: "commit", color: "var(--pending)", redFlag: false },
  tag: { label: "tag", color: "var(--pending)", redFlag: false },
  ledger: { label: "ledger", color: "var(--i2)", redFlag: false },

  // --- new this stage (Stage 4, the sensing layer)
  file_edit: { label: "file edit", color: "var(--verifying)", redFlag: false },
  command_test: { label: "test run", color: "var(--verifying)", redFlag: false },
  command_build: { label: "build", color: "var(--building)", redFlag: false },
  command_lint: { label: "lint", color: "var(--building)", redFlag: false },
  command_git: { label: "git", color: "var(--pending)", redFlag: false },
  command_db: { label: "db", color: "var(--building)", redFlag: false },
  command_install: { label: "install", color: "var(--building)", redFlag: false },
  command_deploy: { label: "deploy", color: "var(--pending)", redFlag: false },
  command_destructive: { label: "destructive command", color: "var(--fail)", redFlag: true },
  test_result: { label: "test result", color: "var(--pass)", redFlag: false }, // redFlag decided per-event (failed>0) — see red-flags.mjs
  error: { label: "error", color: "var(--fail)", redFlag: true },
  death: { label: "death", color: "var(--fail)", redFlag: true },
  ack: { label: "ack", color: "var(--live)", redFlag: false },
  stage: { label: "stage ping", color: "var(--live)", redFlag: false },
  control: { label: "control", color: "var(--pending)", redFlag: false },
};

/** Every kind name, for validation / iteration (Settings kind-filter row, verify scripts). */
export const EVENT_KIND_NAMES = Object.keys(EVENT_KINDS);

/** A plain-data snapshot safe to `JSON.stringify` straight into an HTTP response — same shape as
 * EVENT_KINDS (it already is plain data), exported separately so callers reaching for "the API
 * payload" don't have to know that fact holds. */
export function eventKindsPayload() {
  return EVENT_KINDS;
}
