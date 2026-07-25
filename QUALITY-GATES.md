# Ops Dashboard — v3 Success Metrics (owner-set, 2026-07-24 — STRICT; no gate, no ship)

## M0 — THE NORTH STAR (owner's own words, the real most important goal)
"I should be able to look at the dashboard and know EVERYTHING that is happening — highly visually,
concisely, well represented in simple, easy-to-understand, industry golden-standard language, with
PRECISE NUMBERS — who is doing what, what is done, what is pending, what is being done —
INSTEAD OF looking at the ever-scrolling Claude Code CLI."
Every gate below serves M0. The acceptance question for the whole build: could the owner close the
CLI entirely and still run the operation from this screen? Evidence: a written CLI-replacement
walkthrough — for each thing the CLI shows (agent actions, gates, commits, stalls, phase progress),
where the dashboard shows it better.

| # | Gate | Measure (evidence required, not claims) |
|---|---|---|
| M1 REALTIME | Every agent/SDLC action visible <1s from disk write; SSE auto-reconnect <3s; zero manual refresh; events from ALL watched projects interleave live | timestamped disk→DOM measurement per source type; kill-server/reconnect demo |
| M2 NOVICE TEST | A first-time viewer answers in <30s: which projects are active · who (which agents/models) is working · what is each doing RIGHT NOW · what just happened · is anything broken/stalled — via a plain-English "narrative strip" + glossary tooltips on every jargon term | comprehension walkthrough written against final screenshots; every panel has a "?" explainer |
| M3 VISUAL CLARITY | Explicit column separations (hairline rules between all table/board columns); DYNAMIC semantic color coding everywhere state exists (live=green pulse · building=amber · verifying=blue · stalled/red · idle=dim); ACTIVE items elevated + highlighted, inactive auto-collapsed behind disclosure ("show N idle"); zero page-level horizontal scroll at 390/768/1440/1920; axe-core 0 violations; anti-AI-tell critique pass | 4-viewport × 2-theme screenshots + DOM measurements + written critique |
| M4 MULTI-PROJECT | N projects watched SIMULTANEOUSLY (per-project lanes + unified project-tagged feed); add/remove/configure projects LIVE from Settings (no restart); per-project control channels isolated | demo watching ≥2 real projects at once; live add/remove evidence |
| M5 ROBUSTNESS | Graceful degradation per missing source (no reports/? no git? still works); corrupt config → defaults + banner; feed ring-buffer bounded (no leak); watchers re-arm on file rotation + survive project dirs appearing/vanishing | fault-injection evidence per case |
| M6 PORTABILITY | Zero npm deps; Docker build+run verified; points at ANY repo with no code edits; no hardcoded paths | fresh-repo demo + docker evidence |
| M7 USEFULNESS | Kanban mirrors live agent/phase states; STALL DETECTION surfaced (agent quiet >5min = flagged red with age); per-agent drill-down (model transcript-verified, turns, last actions); test/gate results + git milestones visible with pass/fail colors | screenshots of each, with live data |
| M8 SKILL STACK | Designed with impeccable (product register) + dataviz (charts/status color law) + ui-ux-pro-max (density/dashboard patterns) + design-system (token mechanics) + typography-verification (DOM-measured type) COMBINED — each skill's application named in the close report | per-skill application notes |
| M9 FIRST-SCREEN (owner, super-important) | The first visible page of EVERY tab is planned real estate: per-tab documented first-screen plan (what/why/where above the fold; placement logic top-left=attention, strip=narrative); front Dashboard first screen tells the whole project story with zero scroll at 1440 and stays usable at 390; only dig-deeper detail below the fold/in drawers; M2 novice questions answerable from the front tab's first screen ALONE | per-tab first-screen-only screenshots at 1440+390, annotated with placement rationale |
