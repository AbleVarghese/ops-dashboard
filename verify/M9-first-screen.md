# M9 First-Screen — per-tab placement rationale

Per QUALITY-GATES.md M9: "per-tab documented first-screen plan (what/why/where above the fold;
placement logic top-left=attention, strip=narrative)." Overview and Git already had this treatment
in the codebase's own comments; this covers the remaining 7. Every claim below is checked against
the real screenshots at `verify/screenshots/<tab>-1440-dark.png` and `-390-dark.png` — measured,
not assumed (0 h-scroll / 0 axe violations confirmed for all of them via `verify/screenshots.mjs`).

## ① Overview (front tab — the whole story)

**What's above the fold at 1440:** the DONE/DOING/PENDING triptych (top, full-width, the single
highest-attention element — real task titles + real "who"), then the 5-tile KPI band (active
agents, stalled count, unpushed commits, last test result, pending control — every number precise,
per M0), then a 2-up activity chart + recent-activity strip. **Why this order:** the triptych
answers "what's the state of the world" (M0's exact question) before any secondary metric; the KPI
band is the fast-scan confirmation row; the chart/recent-activity pair is the "what just happened"
follow-up, correctly below the fold-critical content. Measured 0px vertical overflow at 1440×900.

## ② Projects (lanes)

**Above the fold:** one card per watched project, each showing active-agent count + the top
agent's current action + last git milestone — the same three facts Overview's triptych/KPI band
answer for the AGGREGATE, here scoped per-project. **Why this placement:** this tab exists
specifically for "which project, specifically" drill-down, so lane cards ARE the first screen (no
secondary chrome above them) — a novice landing here from the Overview's "N projects" badge should
see the per-project breakdown immediately, not a summary-of-a-summary.

## ③ Live Feed

**Above the fold:** the project filter (top-right, so "just this project" is one click before
scrolling any events) + the scrollable event list starting immediately below. **Why no KPI band
here:** this tab's entire job is the raw stream itself — anything above it would push real events
below the fold, working against the tab's purpose. The "paused (hovering)" tag appears inline in
the subhead, not as a separate banner, so pausing-to-read doesn't shift layout.

## ④ Agents

**Above the fold:** the live fleet table (sorted worst-first: possibly-stalled leads, then
live/active, idle collapsed behind a disclosure) — this is the single most information-dense table
in the app by design, matching the tab's job ("who is doing what," M0's own phrase). The
Requested-vs-Actual routing table is BELOW it deliberately: it's a secondary, less time-critical
cross-check (did the right model run), not the primary "what's happening" answer.

## ⑤ Kanban

**Above the fold:** the 4-column board (Queued/In Progress/Verifying/Done) fills the first screen
at 1440 for any project with a normal card count; the project selector sits top-right like every
other per-project tab, for placement consistency (a returning user shouldn't have to relearn where
"pick a project" lives per tab). Cards carry a live-state dot + owner, so this tab's board and the
Overview triptych never disagree about who owns what (same underlying data, per Kanban's own module
doc: "ONE function decides the state everywhere it's shown").

## ⑥ Tests & Quality

**Above the fold:** the result trend (oldest→newest, left-to-right reading order matches how a
person mentally scans "is this getting better or worse") sits above the raw run table — the trend
answers the question faster than scanning rows would. **Why the raw table still exists below:**
the trend is a glance-level summary; the table is the drill-down for "which run, exactly."

## ⑦ Git (already documented in CLOSE-OUT.md's M0 walkthrough — repeated here for completeness)

**Above the fold:** the one-sentence rollup ("On `main`. 16 ahead / 0 behind origin. 20
uncommitted file(s)...") sits at the very top of the tab, above even the branch/remote cards —
this is the M2-novice-test answer for git state specifically, and it's plain English by
construction (built server-side, not a raw `git status` dump). Branch/remotes and working-tree
summary sit side-by-side below it (2-up grid, same visual weight — neither is more urgent than
the other). The work-disposition matrix and tags timeline are correctly BELOW the fold — they're
the "click to dig deeper" layer, matching M9's "only dig-deeper detail below."

## ⑧ Control

**Above the fold:** the request history table, THEN the submission form below it. **Why history
first:** a returning user's most common question is "did my last request get picked up," not "let
me submit a new one" — reading the existing state before offering a new action matches how the
tab is actually used. The form itself is deliberately plain (no card-within-card nesting) with the
project selector as its first field, consistent with every other per-project tab.

## ⑨ Settings

**Above the fold:** Projects management (add/remove/enable, the highest-frequency Settings action
by far — this is how M4's live multi-project story actually gets used) comes BEFORE the general
Settings form, which is comparatively rare to touch (most values apply live and rarely change).
**Why this order over alphabetical or config-key order:** frequency-of-use, not schema order — the
thing people actually come to this tab to do sits first.

## Honest observation: unused first-screen real estate on Control (not a gate failure, worth noting)

Checked `verify/screenshots/control-1440-dark.png` against this doc's own claims (both above
verified accurate against the real screenshot). One thing the screenshot shows that this doc
hadn't called out: when a project has no control-request history yet (the common case for a
freshly-added project), the Control tab's first screen has substantial unused space below the
form (~450px of the 900px viewport height, empty). This satisfies M9's letter (zero scroll, no
defect) but not fully its spirit (every pixel earning its place) — a reasonable follow-up would be
a compact "recent activity across all your projects" strip filling that space when the SELECTED
project has no history of its own, rather than leaving it blank. Noted as a real, screenshot-
verified observation rather than silently left out of this document.

## Cross-tab placement consistency (the pattern, stated once)

Every per-project tab (Kanban/Tests/Git/Control) puts its project selector in the same visual
slot (top-right of the first card, next to the H2) — a deliberate, repeated convention so a user
who's learned it once on any tab doesn't have to relearn it on the next. This is the "placement
logic" M9 asks to be documented, stated as the single rule it actually is rather than repeated
per-tab boilerplate.
