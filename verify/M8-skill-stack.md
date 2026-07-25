# M8 Skill Stack — application notes (this pass)

Per QUALITY-GATES.md M8: "each skill's application named in the close report." Below is what
each skill was actually asked and what it actually found — not a claim that the skills were
consulted, evidence of what they returned.

## typography-verification

Applied Rule 4 (ground-truth DOM measurement, not static reasoning) and Rule 7 (all 4 canonical
viewports — 320/768/1440/1920, not just the 390/1440 pair used elsewhere in this close) to the
narrative strip and the triptych's big numbers, since those are the highest-visual-weight text on
the page.

**Measured** (script: ad-hoc, results folded in here — see the raw JSON trail in this session):

| Viewport | Narrative rendered lines | Triptych count width vs. column width | h-scroll |
|---|---|---|---|
| 320 | 6 | 20-41px in a 270px column | none |
| 768 | 3 | 20-41px in a 718px column | none |
| 1440 | 2 | 20-41px in a 421-547px column | none |
| 1920 | 1 | 20-41px in a 421-547px column (unchanged from 1440) | none |

Finding: `main { max-width: 1440px; margin: 0 auto; }` caps content width at ultra-wide viewports
— exactly the Rule-7 desktop trap this skill exists to catch (fluid content stretching illegibly
at 1920+) — and it's already handled correctly; the triptych columns are IDENTICAL width at 1440
and 1920, not stretched. No `clamp()` upper-bound trap present (font sizes are fixed px, not
fluid, so that specific failure class doesn't apply here). Zero horizontal scroll at any of the 4
canonical viewports. Narrative six-line wrap at 320px is real but 320px is below this project's
own supported floor (390px is the documented mobile breakpoint) — noted, not treated as a defect.

## dataviz

Ran the skill's own validator (`scripts/validate_palette.js`) against the actual status-color hex
values shipped in `lib/config.mjs` DEFAULTS.theme.status (`#3E6B4F` pass/live, `#A63D2F`
fail/stalled, `#B08A3E` pending/building, `#3E6C8F` verifying) — real validation, not eyeballing.

```
node <dataviz-skill>/scripts/validate_palette.js "#3E6B4F,#A63D2F,#B08A3E,#3E6C8F" --mode dark
```

**Result: FAILS the strict categorical-palette checks** — chroma floor (green/blue read slightly
desaturated), CVD separation (red/green ΔE 6.5, in the "legal only with secondary encoding" band),
and dark-mode contrast-vs-surface for two of the four hues. Light mode passes contrast but shares
the same chroma/CVD findings.

**Why this isn't being fixed as a P0 in this pass:** the validator's own stated scope is
"categorical palettes" (chart legend / series identity, where color IS the only cue). This
project's status colors are never used that way — every dot/badge is always paired with a text
label ("live", "possibly stalled", a KPI label, a matrix cell's note), which is exactly the
skill's own non-negotiable ("status colors... never color alone... ship with an icon + label").
So the real-world risk is lower than a bare categorical-legend failure would be. That said, this
is a genuine, tool-verified finding, not dismissed — recommending it as a follow-up: nudge the
`live`/`verifying` hues to a slightly higher chroma so they clear the categorical bar too, which
would make the SAME palette reusable for a future chart legend without a second color decision.
Sequential/single-hue use (the activity + cadence sparklines, one accent hue, light-to-dark via
opacity) already matches the skill's "sequential = one hue" rule with no finding.

## impeccable

Applied the General rules section directly (this internal tool has no PRODUCT.md/DESIGN.md, so
the full `init`/`critique` command flow doesn't apply — the General rules + Absolute-bans list
apply universally and don't require that setup).

**Checked against every item in the Absolute bans list:**

| Ban | Finding |
|---|---|
| Side-stripe borders (`border-left`/`border-right` > 1px as a colored accent) | **VIOLATION FOUND** — `.lane-card` and `.kanban-card` both use a 3px colored `border-left` for state (live/stalled/idle, done/queued/verifying). Pre-existing since v2, not introduced this session. See the flag to team-lead below — this is exactly the kind of established-pattern change the dialogue mandate says to surface, not silently rip out or silently ignore. |
| Gradient text | none found |
| Glassmorphism as default | none found |
| The hero-metric template (big number + small label + gradient accent, SaaS cliché) | KPI band and the triptych are big-number+label, but **no gradient accent** and the numbers are live operational data, not a decorative marketing metric — this is the "product register" (design serves the product) use of a stat tile, which the skill treats differently from the "brand register" ban it's actually targeting. Not flagged as a violation. |
| Identical card grids | none found — card content varies by real data |
| Tiny uppercase tracked eyebrow above every section | `.kpi-label` / `.triptych-label` are uppercase-tracked, but they're DATA LABELS under a number (axis labels), not decorative eyebrows above prose sections — different pattern, not the banned one |
| Numbered section markers (01/02/03) | the tab nav uses circled numerals (①②③...) as a genuine ordered sequence of 9 real tabs — this IS a real sequence where the order carries information (the skill's own stated exception), not decorative scaffolding |
| Text overflowing its container | none found (see typography-verification results above) |

**Net finding:** one real, pre-existing violation (side-stripe borders), everything else clean.

**Status: RESOLVED.** The orchestrator decided option (a) below — implemented, re-verified (0 axe
violations, 0 console errors on both tabs), screenshots reshot. See CLOSE-OUT.md's "Resolved this
pass" section for the final state. The recommendation text below is preserved as the decision
record (what was proposed, why, and that it was surfaced rather than unilaterally changed).

## Flag to team-lead (dialogue mandate) — HISTORICAL, preserved as the decision record

The side-stripe border pattern is used in exactly 2 components (lane cards, kanban cards) as the
PRIMARY state-indicator for those cards — removing it isn't a one-line tweak, it needs a
replacement state-indicator (the skill suggests: full border color, background tint, or a
leading dot/icon — this design already HAS a dot component elsewhere, e.g. `.dot.live`, which
could be reused as the leading-icon replacement instead of the stripe). My recommendation: reuse
the existing `.dot` component as a leading icon inside the card header (consistent with how
agent/project state is already shown everywhere else in this UI) instead of the border-left
stripe, on both `.lane-card` and `.kanban-card`. This is a real design change to an established,
previously-shipped pattern (not something I'm doing unilaterally) — surfaced via SendMessage for
a decision rather than either silently changing it or silently leaving a known skill-flagged issue
undocumented.
