# Ops Dashboard v3.3 — Close-Out Evidence

Session: `build-dashboard7`, the owner-critique quality pass. Ran concurrently with another
session's ingest-security work (`build-dashboard5`/`build-dashboard6`, task #33) and a Docker
healthcheck fix (task #34) in the SAME shared working directory — both landed cleanly via this
project's atomic-commit hook; this close-out covers only what THIS session built, reviewed, and
independently verified. The real production instance (`127.0.0.1:4650`, PID unchanged all session,
watching `keralora`) was never touched, restarted, or reconfigured.

## What the owner actually said (verbatim, from the brief)

> "Kanban, test quality, and git sections are totally poorly built — don't show great details,
> realtime updated, with proper differentiation, highlighting and color coding well enough. The
> Control section is too poor."

## 1. Kanban — push-driven, dwell-tracked, full W-record

| Item | What changed | Evidence |
|---|---|---|
| Push-driven (not 5s poll) | `server.mjs`'s `pushBoardStateSoon()` — every local/hub feed event now triggers a debounced (400ms, coalesces bursts) full board recompute+broadcast, in ADDITION to the existing 5s `scheduleBoardPush()` backstop (kept for clock-only state changes, e.g. an agent crossing the possibly-stuck threshold with no new event) | `verify/screenshots-v3.3/*`, latency measurement below |
| Per-column dwell | New `lib/kanban-dwell.mjs` — stateful wrapper (in-memory, per-projectKey Map) tracking `{column, enteredAt, fromColumn}` per card id, wired into `board-state.mjs`. 7 unit tests | `test/kanban-dwell.test.mjs` (7/7) |
| W-record (who+model, current action, why) | `lib/kanban.mjs`'s `cardsFromPhaseTable` now attaches `ownerRecords` (name/models/evidence/state/quietMs) sourced from the SAME agent objects the Agents tab reads — never a second derivation | `test/kanban.test.mjs` (5/5), `verify/screenshots-v3.3/kanban-dark-1440.png` |
| Color states | `.kanban-card.live` (green border, not just dot — reads at a glance across a column), `.stalled` (red border), `.done-dim` (opacity 0.62, recedes) | screenshots, dark+light, 390+1440 |
| Column WIP counts | Kept + added a `N live` sub-badge per column | screenshots |
| Full interrogative drawer | who/what/where/when/how-long/how-much/whose/why/how/how-well/which/from→to/depends-on/what's-next/verified-by — fields with no real data source (how-much, depends-on, verified-by) render explicit `n/a`, never fabricated | `verify/screenshots-v3.3/kanban-drawer-dark-900.png` |

## 2. Tests & Quality

| Item | What changed |
|---|---|
| Latest-run hero | New `#testHero` card, first thing on the tab — verdict badge (PASS/FAIL/CAVEATED/PENDING), date, trigger, scope, full result text |
| Skip/caveat color | `statusClassFor()` gained a `warn` tier for ⚠️/UNVERIFIED/discrepancy rows that previously fell through silently to the generic "pending" default — real example from `keralora/reports/TEST-RUNS.md`: "⚠️ 0 run / 27 skipped — no TEST_DATABASE_URL, UNVERIFIED" now renders as its own hollow-ring trend dot + dashed amber badge, not indistinguishable from an in-progress run |

Verified against real seeded TEST-RUNS.md rows (pass/fail/warn/pass) — `verify/screenshots-v3.3/tests-dark-1440.png`.

## 3. Git

| Item | What changed |
|---|---|
| Unpushed-age amber | `ahead>0 && unpushedAmber` (>30min unpushed, `lib/git-status.mjs`'s existing flag) now renders `warn` (dashed amber) instead of `fail` (solid red) — "you forgot to push" is a caution, not the same severity as a broken build |

The work-disposition matrix, tags timeline, and cadence sparkline were already reasonably built
(existing `amber` status in the matrix maps to `pending`'s amber hue) — reviewed, no defects found,
left as-is rather than churned for its own sake.

## 4. Control — full redesign

Replaced the flat table with: a **Pending** section (actionable cards, one per request, a visible
`SUBMITTED → <project> → PENDING/HONORED` chain, amber-pulse while pending) and a separate
**Honored history** section. `control.mjs`'s documented contract (`README.md`) extended
**backward-compatibly**: an orchestrator MAY now stamp `honoredAt`/`honoredBy`/`honoredNote` when it
flips `honored: true`; the reader already passed extra fields through untouched, so this needed zero
backend schema change — only the UI rendering + a doc update. When those fields are absent (the
minimum contract), the card says so plainly rather than inventing detail. Verified with real seeded
pending + honored (with the new optional metadata) requests —
`verify/screenshots-v3.3/control-dark-1440.png`.

## 5. Global project-scope dropdown

Header `#globalScope` select — "All projects" (default, unchanged behavior) or one project. Wired
through ONE function (`scopedProjects()`/`scopedFeed()`) that every cross-project panel
(Overview/Lanes/Feed/Agents/footer) and every per-project selector's option list
(`populateProjectFilterOptions`) now derives from — picking a project narrows every tab
consistently, not a per-tab hand-sync. Persisted to `localStorage` (`opsDashScope`); falls back to
"All" if the scoped project is disabled/removed mid-session rather than silently showing zero data
with no explanation. Purely client-side array filtering — no network round-trip, well under the
100ms-perceived bar. Visible scope chip in the header when active.

## 6. A REAL P1 BUG found by live browser verification, fixed

**This is the headline finding of the session — exactly what the mandatory browser-validation rule
exists to catch.** Code review alone would never have found this; only driving a real browser
against a real server with a real token did.

With `dashToken` configured (the exact deployment shape this project's own README recommends for
the v3.2 remote hub, and what `docker-compose.hub.yml` REQUIRES), the dashboard **rendered
completely unstyled with `app.js` never executing at all** — `<link href="/styles.css">` and
`<script src="/app.js">` are the browser's OWN follow-up requests to those exact paths, and a
browser never propagates the original page navigation's `?token=` query string onto a sub-resource
request discovered while parsing the HTML. Both hit `authorized()` with no credential, got a real
401, and the ENTIRE UI was silently broken for anyone running a token-protected deployment. The live
`:4650` production instance never hit this (no `dashToken` set there), which is exactly why it went
unnoticed.

**Fix** (`server.mjs`): `/app.js` and `/styles.css` are exempted from the auth gate — same class as
`/healthz` (liveness/shell-loading must never require the same credential as data access); they
carry no sensitive data. `/api/*`, `/events`, `/ingest`, and `/` itself all stay fully gated —
confirmed by a new regression test (`test/static-assets-auth.test.mjs`, spawns a real
`server.mjs` process, asserts both the fix AND that nothing else got accidentally exempted) and by
a live Docker container run (§8 below).

## 7. Footer — watchMode + collector-offline surfacing

Closes CLOSE-OUT-v3.2.md's gap #4 (the data was live in `/api/state` since v3.2; no visual surface
existed). `#footerWatchMode` shows "native fs.watch (instant)" or "container mode: polling every
2s"; `#footerCollectorStatus` shows any project whose collector has gone offline, with the offline
duration. Verified live in both the native-run and the Docker-container run below.

## 8. Docker — upgraded from "reasoned about" to LIVE-VERIFIED (closes CLOSE-OUT-v3.2 gaps #1–#3)

Docker was unavailable in the prior two sessions. It was available this session — ran the full,
real thing, against an isolated copy on a throwaway port (`4799:4650`), never touching the real
`:4650` instance:

```
docker compose -f docker-compose.hub.yml up --build -d   → built + started clean
docker inspect .State.Health.Status                       → "healthy"
curl /healthz, /styles.css, /app.js (no token)             → 200, 200, 200
curl /api/state, POST /ingest (no token)                   → 401, 401  (data routes still gated)
POST /api/projects (with token) → config.json (host bind-mount) → project appears on disk
docker compose down && up (recreate, NOT -v)                → container recreated
  → /api/state after recreate                               → the added project SURVIVED
  → health status after recreate                             → "healthy" again
docker exec ... git --version                                → git version 2.54.0 (works in-container)
```

Every one of v3.2's four honest Docker gaps is now closed with live evidence, not static analysis.
Cleaned up: container/network/throwaway image all removed after the run.

## 9. Latency re-measurement — an honest, precisely-diagnosed gap (NOT closed)

Measured disk-write → `state` SSE-event-arrival for the two cases the brief named, against an
isolated instance (never the real `:4650`):

| Case | Measured | Gate |
|---|---|---|
| STATUS.md row edit → Kanban's `state` event carries it | **~1.5s** (1543–1566ms across repeated runs) | <1s |
| TEST-RUNS.md append → Tests tab's `state` event carries it | **~1.5s** (same order) | <1s |

**This does not meet the <1s bar the brief set. Root cause, precisely diagnosed (not guessed):**
traced the SSE event timeline (`feed` event vs `state` event arrival timestamps) and directly timed
`buildBoardState()` in isolation — it takes **685ms–1825ms per call**, dominated by
`lib/git-status.mjs`'s **9 sequential, synchronous `execFileSync("git", …)` subprocess spawns**
(status, remote, log for the 14-day cadence, tags, branch list, remote again, `branch --merged`,
per-worktree status, stash list) — each fork/exec has real OS overhead, and they run one after
another, not in parallel. Raw `fs.watch` latency was separately confirmed fast (52ms in isolation) —
**not** the bottleneck. My `pushBoardStateSoon()` debounce is exactly 400ms as designed and is
NOT the cause either.

This is a **pre-existing performance characteristic**, not a regression this session introduced —
it was previously masked because `buildBoardState()` only ran once per 5s
(`config.feed.refreshMs`), so its ~1s cost was invisible. The push-driven wiring this session added
is architecturally correct and now calls it far more often (once per debounced event burst instead
of once per 5s), which is exactly what exposes the cost.

**Why this wasn't fixed in this session, stated plainly:** the real fix — converting
`git-status.mjs`'s 9 sequential `execFileSync` calls to parallel async `execFile` + `Promise.all`
— is a genuine refactor of a module this session didn't otherwise touch, cascading through
`board-state.mjs` → `project-manager.mjs` → `server.mjs`'s `buildFullState` (currently synchronous
throughout). Attempting that under this session's remaining time budget, without dedicated test
coverage for the async conversion, was judged higher-risk than valuable — [[zero-rework-discipline]]
favors a well-scoped follow-up over a rushed change to a correctness-sensitive module. **Recommended
follow-up** (concrete, not vague): parallelize the 9 git subprocess calls in `git-status.mjs` via
`Promise.all(execFileAsync(...))`; expect this alone to bring `buildBoardState()` under ~300ms
(the slowest single call, not the sum of 9). The individual `feed` event (single tool-call push,
what the Live Feed tab shows) remains fast and unaffected — v3.2's proven ~150ms–1s numbers for that
specific path still hold; only the FULL board recompute (driving Kanban/Tests/Git) inherits the git
subprocess cost.

## Test evidence

**245/245 passing** (`npm test`), up from 227 at session start — 18 new tests this session:
7 `kanban-dwell` + 5 `kanban` + 1 `static-assets-auth` (the P1 fix's regression guard); the
remaining 5 (227→232 before this session's own additions) came from the concurrent ingest-security
session's own work, reviewed and kept, not duplicated.

## Files changed (this session)

New: `lib/kanban-dwell.mjs`, `test/kanban-dwell.test.mjs`, `test/kanban.test.mjs`,
`test/static-assets-auth.test.mjs`, `verify/screenshots-v3.3/*` (20 screenshots: 5 tabs × 2
viewports × 2 themes, plus a drawer detail shot), this file.

Modified: `server.mjs` (push-driven broadcast + the static-asset auth-gate fix), `public/app.js`
(Kanban W-record/drawer/colors, global scope, footer, Tests hero + warn tier, Control redesign, Git
amber fix), `public/index.html` (scope picker, footer, tests/control markup), `public/styles.css`
(all of the above), `README.md` (Control contract's optional honoring metadata), `lib/kanban.mjs`
and `lib/board-state.mjs` (dwell + ownerRecords wiring — landed via this session's own edits, picked
up by the project's atomic-commit hook mid-session).

## Real, honest gaps (surfaced, not glossed over)

1. **Latency §9 above — the single biggest open item.** Push-driven wiring is correct; the
   underlying `buildBoardState()` cost (git subprocess latency) is not, and needs the parallelization
   follow-up to actually hit <1s.
2. **`kanban-scoped-dark-1440.png` and the scoped drawer screenshot were not captured** — the
   verification script's `page.selectOption` hit a Playwright strict-mode conflict (2 elements
   matched a label selector) unrelated to product code; the scope dropdown itself IS confirmed
   working (manually exercised, screenshots show "1 PROJECT" chip and scoped narrative text in the
   drawer capture that WAS taken via a separate targeted script). Not re-chased further given
   the rest of this close-out's evidence already demonstrates the feature works.
3. **Axe/accessibility automated scan** was not run this session (time budget went to the
   functional/visual verification + the P1 bug chase) — the existing `verify/axe.mjs` harness from
   prior sessions should be re-run against these specific new elements (control cards, scope
   picker, footer) before calling accessibility fully re-verified for v3.3's new surfaces.
4. **Mobile Kanban card density**: at 390px, three W-record lines + dwell + meta row per card make
   columns tall — functional and readable (see `kanban-dark-390.png`), not visually broken, but a
   candidate for a follow-up polish pass if the owner finds it cramped on a real device.

## 10. Owner addendum: big/bright/dynamic LIVE indicators + live-first sorting everywhere

Two follow-up owner directives, folded into this same session/commit rather than a separate pass.

**Verbatim**: *"'live'/'active'/'run' type indications shown big, bright, properly color coded,
dynamic and clear"* + *"live/active items must also be PRIORITIZED — sorted to the TOP of every
list/board they appear in, always... the top of every view IS the live picture."*

**New shared component** (`STATE_CHIP_CONFIG` + `stateChipHtml()` in `public/app.js`): a 5-tier
loudness hierarchy —
- **live** (working/composing) — bright saturated `#22c55e`/`#052e16` chip (a NEW, deliberately
  more vivid pair than this app's existing muted `--pass` tokens; verified 6.54:1 contrast,
  computed not guessed), `working` PULSES (a real heartbeat, only while genuinely active),
  `composing` stays steady-bright (active but not mid-tool-call).
- **building/verifying** (paused/waiting) — reuses the existing audited `--pending`/`--verifying`
  tokens, steady.
- **stalled** (possibly_stuck/stopped/orphaned) — reuses `--fail`, **steady, no pulse** (a
  deliberate change from the prior design: `.dot.possibly-stuck` used to pulse; removed per the
  owner's explicit "steady-alarm" — a stalled agent isn't doing anything, so a heartbeat there
  would misrepresent it as active).
- **done/idle** — small, dim, no chip. The contrast IS the design.

Applied to: Agents table (replaces the old small dot), Kanban cards (compact/no-label variant so
the card face stays scannable), Project Lanes' "top agent" line, and a brand-new **Collector
Sources** panel (Settings tab — `/api/collectors` had zero UI before this; only appears once a
collector has registered).

**Live-first sorting** (an explicit, documented override of the PRIOR sort rationale — kept in a
code comment, not silently deleted, per this project's no-drift discipline):
- Agents table: `stateRank()` reordered from "needs-attention-first" to live-first
  (working/composing → waiting/paused → possibly_stuck/stopped/orphaned → done).
- Kanban: cards within each column now stable-sort active/stalled-owned cards to the top.
- Lanes: projects with a live agent sort before projects without one.
- Feed: unchanged (already newest-first, which the owner's own addendum said to keep).

**Dynamic reposition** — a small FLIP (First/Last/Invert/Play) helper (`flipCapture`/`flipPlay`)
captures each row/card/lane's position before a re-sort and animates the actual delta back to zero
after, so a state change that reorders the list SLIDES rather than jump-cuts. Wired into the Agents
table, Kanban board, and Lanes. Honors `prefers-reduced-motion` (skips the animation entirely — the
new, already-correct order just appears, no slide).

**Verified live** (`verify/screenshots-v3.3-liveness/`, zero console errors across every capture):
`agents-live-vs-idle-{dark,light}.png` (the requested "live rows visibly dominate" shot — WORKING/
LIVE/WAITING chips lead, STUCK? below them, 2 done agents collapsed behind a disclosure at the
bottom), `agents-reduced-motion.png` (chip renders fully solid/bright with zero animation, confirms
the reduced-motion fallback), `kanban-live-vs-idle-*.png`, `lanes-live-*.png`.

No dedicated unit tests added for this piece — client-side rendering/sort logic in `public/app.js`
has no existing unit-test harness anywhere in this codebase (every current test targets `lib/*.mjs`;
`app.js` is a plain browser script with no exports, verified via the screenshot harness instead,
same established pattern this session followed rather than introducing an inconsistent new one).

## Cutover

Nothing to cut over — the live `:4650` instance keeps running whatever version it was started with;
none of this session's changes require restarting it. The static-asset auth fix and the push-driven
broadcast only matter for a deployment that (a) sets `dashToken` and (b) is restarted to pick up this
code — the owner can restart the live instance whenever convenient to pick up v3.3 (out of scope for
this session per the deployment-release-discipline rule: production restarts are owner-attended).
