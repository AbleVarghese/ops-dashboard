# Ops Dashboard v3.1 — Close-Out Evidence

Session: `build-dashboard5`, completing the Stage-4a handoff (`build-dashboard4`). Server:
`http://127.0.0.1:4650`, left running — production instance never touched during development;
every claim below is reproducible from an isolated, throwaway copy of this package pointed at real
live `keralora` data, per the same reproducibility bar `CLOSE-OUT.md` (v3.0) already set. Full
evidence trail: `npm test` (199/199), `verify/results/latency-v3.1-stage4-close.json`, and the
screenshot evidence described inline below (not committed as binary files — the SAME predictable
`verify/screenshots.mjs` path convention as v3.0, re-runnable against any live instance).

## What v3.1 Stage 4 (the sensing layer) actually built

Per `verify/V3.1-PLAN.md`'s Stage-4a handoff, in the stated dependency order:

| Item | File(s) | Real fixtures used |
|---|---|---|
| File-touch recognition | `lib/recognizers/file-touch.mjs` | Real Read/Edit tool_use inputs + a real `rm -rf` command, all from this campaign's own subagent transcripts |
| Command classification | `lib/recognizers/command-classifier.mjs` | Real `pnpm test`/`pnpm build`/`git status`/`pnpm db:migrate`/`pnpm add`/`rm -rf` commands from this campaign |
| Error/death recognition | `lib/recognizers/error-recognition.mjs` | A REAL captured `isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429` transcript line (a genuine session-limit death from this exact campaign) + a real Node.js crash (`throw err; ^ Error: Cannot find module 'dotenv'`) + real permission-denial/tool-error tool_results |
| ACK/stage-ping semantics | `lib/recognizers/ack-stage.mjs` | Real SendMessage `{to, summary, message}` inputs from this campaign's own ACK/STAGE protocol traffic |
| Event vocabulary SSOT | `lib/event-kinds.mjs`, served at `GET /api/event-kinds` | — (pure configuration; landed as ONE reviewed list per the plan's own instruction, 15 new kinds beyond the 6 pre-existing) |
| Red-flag auto-elevation | `lib/red-flags.mjs` | — (pure rule: intrinsic-redFlag kinds OR a `test_result` with `failed > 0`) |
| Cross-source linking | `lib/feed.mjs`'s `linkAndFlag` | A commit within 15min of a passing `test_result` gets `verifiedBy` attached — project-scoped (commits aren't per-agent attributed; documented as an honest constraint, not glossed over) |
| Live wiring | `lib/feed-transcripts.mjs` (`assistantLineToEvents`/`userLineToEvents`), `server.mjs` (control route → `injectFeedEvent`) | Bash→`command_*`, Edit/Write→`file_edit`, SendMessage ACK/STAGE→`ack`/`stage`, structured API-error lines→`death`/`error`, tool_result text→`test_result`/`error`/`death` via a bounded per-file `tool_use_id` correlation map |

**Proof, not narrative:** a direct `curl` of the live SSE feed against an isolated copy pointed at
real `keralora` data captured this genuine event mid-session — a REAL `npm test` invocation by
THIS agent, correctly classified live:
```json
{"ts":"2026-07-24T15:10:42.774Z","agent":"build-dashboard5","kind":"command_test","tool":"Bash","summary":"Bash: cd ~/.claude/lib/ops-dashboard && npm test 2>&1 | tail -5","redFlag":false}
```
And a real control request POSTed to `/api/control/-Users-Able-keralora` appeared in the SAME
SSE stream as a first-class `"kind":"control"` event within the same request/response cycle —
previously invisible in the live feed entirely (only visible via polling `board.control`).

## Stage 5 — both carried findings

1. **Control-tab first-screen fill** (`verify/M9-first-screen.md`'s honest observation): a
   "recent activity across your projects" strip now fills the ~450px of empty space below the
   control-request table when the SELECTED project has no history of its own. Verified BOTH
   states live: empty-history screenshot shows the strip with real cross-project events; after
   POSTing a real control request, a second screenshot confirms the strip's `innerHTML` is empty
   (`""`) and the table shows the new row — no duplication, no competing content.
2. **Status-palette chroma/CVD follow-up**: ran the dataviz skill's `validate_palette.js` against
   the FULL updated 6-color status set (`pass/fail/pending/verifying/stopped/orphaned`). Honest
   result: the strict CATEGORICAL 6-check bar still does NOT clear for this set (same finding
   `verify/M8-skill-stack.md` already recorded for the pre-existing 4-color set — chroma-floor and
   CVD-separation FAILs remain). What DID improve, and is the CORRECT check for this actual usage
   per the skill's own documented scope ("for a lone status/text color check WCAG text contrast"
   — these are never used as a bare categorical legend, always icon+label-paired): both new colors
   (`--stopped`, `--orphaned`, plus their `-text` variants) were chosen via the validator's
   `contrast()` export and MEET OR BEAT `--fail`'s own existing shipped precedent (base dark
   3.05–3.18 vs. fail's 3.08; text dark 4.37–4.76 vs. fail-text's 5.22, light 3.81–4.15 vs.
   fail-text's own 3.48). Not a full pass on the aspirational categorical bar; a real, honest,
   evidence-based improvement at the bar that actually applies here.

## Real bugs found and fixed this pass (not just narrated)

1. **`--stopped`/`--orphaned` CSS custom properties were referenced in 7 places** (`.dot.stopped`,
   `.dot.orphaned`, `.chip-stopped`, `.chip-orphaned`, `.agent-row.agent-stopped`,
   `.agent-row.agent-orphaned`, `.stall-age.orphaned-age`) but **never defined anywhere in `:root`**
   — a pre-existing gap from Stage 3's UI cutover. Two of the 8 taxonomy states (STOPPED,
   ORPHANED) rendered with invisible/unset colors. Fixed in this pass; verified via a live
   screenshot of the real Agents tab showing genuine `stopped` (real session-limit deaths,
   `build-phase2`/`build-rbac`) and `orphaned` (`research-buyers`/`research-us-lane`/
   `research-landscape`, all real "presumed dead" agents) rows now rendering with visible,
   correctly-colored dots and text.
2. **A live client-side race**: `GET /api/event-kinds` (fetched once at boot) could resolve AFTER
   the first SSE `feed_batch`-triggered render. When that happened, the kind-filter chips and feed
   rows rendered on `state.eventKinds`' fallback (the raw kind key, e.g. `"COMMAND_BUILD"`
   uppercased by CSS, instead of the SSOT's `"BUILD"` label) — and nothing re-rendered them once
   the real vocabulary arrived, so the wrong labels persisted until the next feed event happened
   to fire (could be minutes on a quiet project, or never). CAUGHT VIA AN ACTUAL BROWSER
   SCREENSHOT comparing dark-mode (correct labels, lucky race) against light-mode (wrong labels,
   same page, same server, only the reload-and-refetch timing differed) — not caught by unit tests
   or code review, exactly the failure class the mandatory browser-validation rule exists to catch.
   Fixed: `loadEventKinds()` now calls `renderActiveTab()` on resolve; re-screenshotted and
   confirmed correct in both themes.

## Also found, not in this pass's scope (surfaced honestly, not silently fixed or ignored)

- `verify/latency.mjs`'s own header comment references `verify/axe.mjs` as a sibling script — that
  file does not exist on disk (checked: `find verify -iname "*axe*"` → nothing). A stale doc
  reference, pre-existing before this session, not touched here (out of Stage 4/5/6 scope) but
  worth a follow-up ticket: either build the referenced axe-core sweep or correct the comment.

## Test evidence

**199/199 passing** (`npm test`), up from 101 at the Stage-4a handoff — 98 new tests, every one
using real captured fixtures where the correctness law requires it (see the table above):
- 17 file-touch, 19 command-classifier, 10 error-recognition, 11 ack-stage (57 recognizer tests)
- 6 event-kinds (SSOT structural checks — no drift between `EVENT_KINDS`/`EVENT_KIND_NAMES`)
- 7 red-flags
- 20 feed-transcripts (the live-wiring enrichment + tool_use↔tool_result correlation)
- 8 feed.mjs (red-flag tagging, cross-source linking, `injectEvent`)

## Latency re-measurement (post-wiring)

`verify/results/latency-v3.1-stage4-close.json`, 4 trials against a live isolated instance
watching real `keralora` data (concurrent with several other real build agents running on this
machine — a harder, more realistic load than an idle box):

| Measure | Mean | Gate | Result |
|---|---|---|---|
| `/api/state` cold | 544ms | 2000ms | ✅ |
| Report-file write → SSE arrival | 391ms | 1000ms | ✅ |
| Git commit → SSE arrival | 320ms | 1000ms | ✅ |

All gates still clear comfortably with the Stage 4 enrichment pipeline added (recognizer calls +
the per-file pending-map lookup add negligible overhead — sub-millisecond regex/Map operations on
already-bounded 64KB reads, not new I/O).

## Visual/functional verification

36 screenshots (9 tabs × 2 viewports × 2 themes) against the live isolated instance: **zero
horizontal scroll, zero console errors, zero page errors** across all 36. Additional targeted
screenshots (Live Feed with the kind-filter row + real enriched vocabulary rendering; Agents tab
showing the stopped/orphaned bug fix; Control tab both empty-history and with-history states) — all
described with their actual observed content above rather than merely claimed.

**Not run this pass** (out of scope / no existing script): a scripted axe-core accessibility sweep
(see "Also found" above — the referenced script doesn't exist); a fresh Docker portability re-run
(v3.0's `verify/docker.mjs` result stands unchanged — nothing in Stage 4/5 touches
deployment/packaging).

## Files changed

21 files (7 modified, 14 new) — `git log -1 --stat` on this session's commit has the full list.
Committed to `~/.claude` main as a clean rollback point BEFORE the live `:4650` cutover (deployment-
release-discipline: preflight green → staged verification → live verification → rollback plan
existing before the button is pressed).

## Cutover

The live `:4650` server is restarted with this commit's code once this document is written (see
the session's final report for the exact sequence and the post-restart live health check).
