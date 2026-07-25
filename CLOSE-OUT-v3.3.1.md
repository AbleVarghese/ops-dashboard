# Ops Dashboard v3.3.1 — Close-Out Evidence

Session: `build-dashboard7` (continuation of v3.3). Scope: the ONE honest gap v3.3's close-out
flagged and did not fix — full-board-state latency (~1.5s, missing the owner's repeatedly-stated
"super low latency, maximum throughput" bar) — plus a genuine axe-core accessibility scan (v3.3's
close-out referenced "the existing verify/axe.mjs harness" from prior sessions; that reference was
imprecise — no such script actually exists anywhere in this repo, confirmed by search. This session
corrects that and IS the first real run). Production `:4650` was never touched.

## 1. Root cause (precisely diagnosed in v3.3, fixed here)

`lib/git-status.mjs`'s `getGitStatus()` ran **up to ~15 sequential, synchronous
`execFileSync("git", …)` subprocess spawns** per call (branch, remote list, per-remote
rev-parse+rev-list, status --porcelain, stash list, last-commit log, worktree list, tags,
14-day cadence log, branches list, `branch --merged`, and up to 2 more calls PER LOCAL BRANCH
for the work-disposition matrix) — each fork/exec has real OS overhead, and none of them ran
concurrently. Measured directly: **685–1825ms per call**, dominating the push-driven board
update v3.3 added.

## 2. Fix: parallelize, don't reduce work

Converted every git call from `execFileSync` to async `execFile` (`node:util.promisify`), then
restructured `getGitStatus()` into three stages so independent work runs via `Promise.all`
instead of one call waiting on the last:
- **Stage 1** (branch, remotes, local-branch list — nothing else depends on anything yet): 3
  calls concurrent.
- **Stage 2** (everything that only needs Stage 1's results, independent of each other):
  ahead/behind-per-remote, dirty-summary, stash-list, last-commit, worktrees, tags, 14-day
  cadence — 7 groups concurrent (ahead/behind itself now also parallelizes across multiple
  remotes internally).
- **Stage 3** (the work-disposition matrix, which needs Stage 1+2's branch/worktree data): still
  has to run after Stages 1–2, but its own per-branch work (dirty-check, rev-parse, rev-list) now
  fans out via `Promise.all` across branches instead of looping sequentially.

Cascaded the resulting `async` signature upward through every caller: `board-state.mjs`'s
`buildBoardState()` (kicks off `getGitStatus()` FIRST, does its own fs-based work — agents,
reports, kanban — concurrently, awaits git only when actually needed for the response),
`project-manager.mjs`'s `buildUnifiedState()` (now ALSO parallelizes across every armed project
via `Promise.all`, not just within one project — a bonus win the git-status fix alone wouldn't
have delivered), `collector.mjs`'s `sendSnapshot()`, and every one of `server.mjs`'s six call
sites of `buildFullState()` (the debounced push, the SSE initial frame, `/api/state`, and the
three project add/patch/delete handlers).

Also shrank `pushBoardStateSoon()`'s debounce from 400ms to 150ms (matching the underlying file
watcher's own `feed.debounceMs`) — 400ms was sized partly to limit how often the THEN-expensive
rebuild ran; that reason no longer applies once the rebuild itself is ~50ms.

## 3. Measured result

| Metric | v3.3 (before) | v3.3.1 (after) | Change |
|---|---|---|---|
| `getGitStatus()` single call, isolated | 685–1825ms | 40–70ms | **~15–30x faster** |
| disk-write (STATUS.md) → Kanban `state` event | ~1.55s | ~350ms (346–358ms, 3 repeated runs) | **~4.4x faster** |
| disk-write (TEST-RUNS.md) → Tests `state` event | ~1.54s | ~352ms | **~4.4x faster** |
| Local test suite wall-clock (`npm test`, 246 tests, many spin up real git repos) | ~18–30s | ~2.5s | **~8–12x faster** |

**Both bars clear**: the original brief's `<1s` gate and the owner's tightened `<500ms` ask (ideally
`<300ms`) — 346–358ms lands just above the ideal-300 but comfortably under the 500 target, with
margin, measured across 3 repeated runs (not a single lucky sample).

## 4. Test evidence

**246/246 passing** (`npm test`) — same count as v3.3's close, no regressions. Every test that
called the now-async `getGitStatus()`/`getGitStatus`-adjacent fault-injection paths was updated to
`async`/`await` (`test/git-status.test.mjs`, `test/fault-injection.test.mjs`) — same assertions,
same real-git-repo fixtures, zero mocking introduced. Added ONE new regression test
(`test/git-status.test.mjs`, "multiple remotes are resolved concurrently") proving the exact bug
class `Promise.all` + a shared-closure mistake could introduce (two remotes silently racing/
overwriting each other's result) does NOT happen — both remotes resolve correctly and
independently.

## 5. A genuine accessibility scan (not previously run — corrected from v3.3's imprecise note)

v3.3's close-out said "the existing `verify/axe.mjs` harness... should be re-run" — that was
**wrong**; no such file exists anywhere in this repo (confirmed: `find . -iname "*axe*"` finds only
prose *references* to axe-core as a methodology in README/spec docs, never an implemented script).
This session wrote one (using axe-core from a local `node_modules`, same zero-product-dependency
pattern as the Playwright screenshot scripts) and ran it — the actual FIRST real axe-core pass
against this dashboard's v3.3 surfaces, WCAG 2 A+AA rules, every changed tab, both themes.

**First run found 6 real violation groups, all `color-contrast`, all `serious` impact** — genuine
bugs, not false positives (verified against axe's own reported fg/bg/ratio data, cross-checked with
an independent relative-luminance calculation):

1. `.kanban-card.done-dim { opacity: 0.62 }` and `.control-card--honored { opacity: 0.85 }` —
   opacity dims TEXT along with everything else; this pushed several already-modest text colors
   (2.4–4.28:1 measured) below the 4.5:1 minimum in both themes. **Fixed**: de-emphasis now comes
   from color/border alone (the existing muted `--i1`/`--i2` ink tokens, already AA-audited on
   their own), never opacity on a container holding text.
2. `.control-chain-step.active { animation: pulse ... }` — the shared opacity-based pulse
   keyframe, captured mid-fade, measured 3.76:1. **Fixed**: removed the pulse (same reasoning as
   the v3.3 state-chip hierarchy's "stalled = steady, no pulse" — a PENDING control request isn't
   a live heartbeat, it's a static waiting state; pulsing both misrepresented it and caused the bug).
3. `--pending-text` / `--building-text` had **no light-mode override at all** — `public/app.js`'s
   `applyTheme()` set them directly from the raw hue with none of the suffix-based dark/light
   lookup every OTHER status color already used. The raw hue (#B08A3E) measures 2.51:1 against
   light-mode surfaces — genuinely failing, just never exercised by a small-text component in
   light mode until v3.3's Tests/Control tabs. **Fixed**: added `pendingTextLight`/
   `buildingTextLight` (#7a5f28, computed + verified: 4.71–5.62:1 against every surface tier it
   actually renders on) to `lib/config.mjs`, and fixed the two `applyTheme()` lines that were
   bypassing the lookup pattern. Also corrected a stale code comment that had (wrongly) claimed
   only `verifying` needed a light-mode override.

**Re-scanned after each fix — 0 violations, every tab, both themes**, confirmed twice
(`verify/screenshots-v3.3.1/` has before/after visual evidence for the two opacity fixes;
zero-violation JSON output captured in this session's transcript).

## 6. Rework — a11y-COMPLETE pass (Fable acceptance-gate rejection + prescription, same session)

Fable's independent re-run accepted the latency fix and the first 6 contrast fixes, but withheld
full acceptance: §5 above (and the original "honest gaps" list) admitted the axe scan skipped the
Settings tab, the Live-Feed tab, and the 390px mobile viewport entirely — incomplete a11y coverage
for the owner's daily-operations tool. Prescription: scan Settings+Live-Feed (both themes, 1440)
AND every tab at 390px, fix at the root, re-scan clean, save raw JSON per surface.

**Delivered the full matrix, not just the prescribed subset** — every one of the 9 tabs × 2 themes
(dark/light) × 2 viewports (1440/390) = **36 surfaces**, each with its own raw axe-core JSON saved
to `verify/screenshots-v3.3.1-a11y-complete/<tab>-<theme>-<viewport>.json` (plus `SUMMARY.json`),
so there's one complete, unambiguous evidence set instead of a partial re-scan bolted onto the
first. Also seeded a real post-boot file change into the fixture project so the Live Feed tab had
actual rows to scan (not just its empty state), and used a fixture with a genuinely active +
genuinely stalled agent (the first scan's simpler fixture never triggered certain conditional
styles at all).

**First run of the full matrix found 4 real violations** (found → fixed → re-scanned 0, per
surface):

| Surface(s) | Element | Root cause | Fix |
|---|---|---|---|
| `overview-light-1440`, `overview-light-390` | `.kpi-warn .kpi-label` | The "Needs Attention" KPI tile tints its background toward `--stalled` (red) when triggered — but only `.kpi-number` had a WCAG-safe text override; `.kpi-label` fell through to the default `--i2`, which measured 4.2:1 against the TINTED background (not the plain tile it was designed for). Never caught before because no earlier fixture had a genuinely stalled agent AND scanned Overview in light mode. | Reuse the *already-audited* `--stalled-text` token the number above it uses — same fix pattern as the pre-existing (correct) `.kpi-number` override right next to it. |
| `kanban-dark-1440`, `kanban-dark-390` | `.kanban-wip-live` (the "N live" column-header badge, added this v3.3 session) | Used `--live` (the raw, muted accent hue meant for dots/borders, where non-text contrast rules are looser) directly as small TEXT — measured 3.15:1. Never caught before because no earlier fixture had an active agent making a column's live-count badge actually render. | Switched to `--pass-text`, the existing WCAG-audited text-safe variant of the same hue (5.27:1 dark / 5.74:1 light, verified). |

Both fixes reuse existing, already-proven-safe tokens — no new colors invented, consistent with
every other fix in this remediation.

**Final re-scan: 0 violations across all 36 surfaces.** 246/246 tests still green. Production
`:4650` still untouched. `verify/screenshots-v3.3.1-a11y-complete/` contains 36 per-surface JSON
files + `SUMMARY.json` (every key → `0`) as the reproducible evidence for Fable's own re-run.

## 7. Files changed

Modified: `lib/git-status.mjs` (full async/parallel rewrite), `lib/board-state.mjs`,
`lib/project-manager.mjs`, `collector.mjs`, `server.mjs` (async cascade + debounce tuning),
`test/git-status.test.mjs`, `test/fault-injection.test.mjs` (async/await updates + 1 new test),
`lib/config.mjs` (pendingTextLight/buildingTextLight tokens + comment correction), `public/app.js`
(applyTheme's two suffix-lookup fixes), `public/styles.css` (5 total contrast fixes: 3 from the
first pass + 2 from the a11y-complete rework). New: `verify/screenshots-v3.3.1/`,
`verify/screenshots-v3.3.1-a11y-complete/` (37 files), this file.

## Real, honest gaps (surfaced, not glossed over)

1. **Only the git-status path was parallelized.** `lib/transcripts.mjs` (agent-file scanning) and
   `lib/reports.mjs` (markdown parsing) are pure fs/JS work, not subprocess-bound — they were not
   measured as a bottleneck this session and were left as-is (correctly cheap already, per the
   original root-cause trace: the ENTIRE 685–1825ms was accounted for by git subprocess calls).
   If a future project has an unusually large transcript volume, that path has its own existing
   cap (`MAX_AGENT_FILES`, from v3.1) but wasn't re-profiled here.
2. ~~The axe scan covered 7 tabs at one viewport, two themes~~ — **closed by §6 above**: now the
   full 9-tab × 2-theme × 2-viewport (36-surface) matrix, 0 violations, raw JSON evidence saved.
3. **The a11y matrix used ONE fixture shape per run** (a project with an active agent, a stalled
   agent, a done card, pending+honored control requests, and pass/fail/warn test-run rows) — this
   exercises every conditional style this session touched, but a fixture is still a fixture, not
   every possible real-world data shape (e.g. a project with 20+ branches in the git matrix, or a
   control ledger with 50+ requests, weren't specifically stress-tested for contrast at scale).

## Cutover

Same as v3.3 — nothing to cut over; the live `:4650` instance keeps running until the owner
restarts it, at which point it picks up both v3.3 and this v3.3.1 fix together.
