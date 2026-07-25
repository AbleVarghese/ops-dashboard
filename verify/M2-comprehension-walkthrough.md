# M2 Novice Test — comprehension walkthrough

Per QUALITY-GATES.md M2: "A first-time viewer answers in <30s: which projects are active · who
(which agents/models) is working · what is each doing RIGHT NOW · what just happened · is
anything broken/stalled." Walked through against the actual screenshot
`verify/screenshots/overview-1440-dark.png` (reproduced below inline for reference), reading it
the way someone who has never seen this dashboard before would, honestly noting where an answer
takes a beat of interpretation rather than being instantly obvious.

## The screen being read

Top to bottom: header ("OPS DASHBOARD", "2 PROJECTS") → narrative strip ("2 projects watched. In
keralora, build-dashboard4 (live) — Bash: cd ~/.claude/lib/ops-dashboard && node --check
verify/screenshots.mjs..., 7s ago. Last milestone: tag rbac-a5 in keralora. 1 agent possibly
stalled: build-dashboard3 (keralora, 16m quiet).") → 9-tab nav → the DONE/DOING/PENDING triptych
→ 5-tile KPI band → activity chart + recent-activity card.

## The 5 questions, answered as a first-time viewer would

**1. Which projects are active?** Read the header badge ("2 PROJECTS") and the narrative's first
clause ("2 projects watched"). **Time: ~2s.** Instant — no interpretation needed. A viewer who
wants names, not just a count, reads "In keralora..." in the same sentence; the second project's
name isn't in this one sentence (it only names the currently-loudest project) — they'd click the
Projects tab for the full list. **Honest gap:** the narrative strip answers "how many" instantly
but not "name both" without one more click. Minor, not a failure of the 30s budget.

**2. Who (which agents/models) is working?** The narrative names one: "build-dashboard4 (live)".
**Time: ~3s.** The word "live" is doing real work here (color-coded green in the actual render,
paired with a pulsing dot in the header) but a first-time viewer without the glossary wouldn't
know it maps to a specific liveness state vs. just meaning "currently visible." The triptych's
DOING column adds "unassigned" for its one task — which reads as a mild contradiction at first
glance (the narrative names an active agent; the DOING card says "unassigned") until you realize
they're two different things: the narrative's agent is doing UNTRACKED work (a Bash command), the
DOING card is a KANBAN TASK with no agent claimed against it specifically. **Honest gap:** this
is the single most likely point of confusion for a true first-time viewer — worth a glossary term
or a one-line clarification ("unassigned" could read "no agent claimed this task yet" instead).
**Model name is NOT shown on this screen** — that's on the Agents tab, not Overview; the M2 gate
says "which agents/models," and Overview only answers "which agents." A true first-time viewer
gets model info one click away, not on the first screen.

**3. What is each doing right now?** The narrative's dash-clause: "Bash: cd
~/.claude/lib/ops-dashboard && node --check verify/screenshots.mjs...". **Time: ~5s** (it's a
technical string — a non-technical viewer reads "running a command" even without parsing the
exact command). The DOING triptych column adds the higher-level framing: "Design sweep/a11y/
browser-validation (tasks 5-8)" — this is the more novice-friendly of the two ("doing a design/
accessibility review task") and sits more prominently (bigger, top-of-page) than the narrative's
raw command string. **This works well** — the triptych is genuinely the better answer to this
question than the narrative strip is, which is correct per M0's own design intent.

**4. What just happened?** "Last milestone: tag rbac-a5 in keralora." **Time: ~3s.** Reads
cleanly as "something called rbac-a5 was finished/tagged" even without knowing what a git tag is
— though "tag" itself is exactly the kind of term the glossary covers (`GLOSSARY.tag` = "A git
bookmark marking one commit as a milestone"), confirming the glossary is doing its intended job
for exactly this sentence.

**5. Is anything broken/stalled?** "1 agent possibly stalled: build-dashboard3 (keralora, 16m
quiet)." **Time: ~3s.** This is the clearest of the five — plain language, a name, a project, a
duration, phrased as a direct answer to exactly this question. The narrative strip also gets a
red bottom border when this is non-empty (`.narrative-strip.has-stall`), so the "something's
wrong" signal is ALSO visible at a glance before reading a single word, which is the right
redundant channel for the highest-urgency information on the page.

## Total: ~16s of reading for a confident answer to 4 of 5 questions; the 5th (model names)
requires one click to the Agents tab.

That's under the 30s budget with room to spare, but "confident" isn't the same as "zero
interpretation needed" — the "unassigned" vs. "an agent is live" apparent-contradiction (question
2) is the one real friction point a genuinely first-time viewer would stumble on. Recorded as a
finding, not smoothed over: worth a follow-up copy tweak (e.g., "unassigned" → "no agent claimed
yet" or a shared tooltip explaining the distinction between narrative-level "an agent is active in
this project" and triptych-level "this specific task has no agent's name on it").

## Glossary coverage check

Terms actually used on this screen that a novice might not know: "tag" (covered — `GLOSSARY.tag`),
"agent" (covered — `GLOSSARY.agent`), "live"/"possibly stalled" as STATE WORDS (not separately
glossed as jargon, but self-explanatory in context — "possibly stalled" reads as plain English
without a definition). "Kanban" is covered (`GLOSSARY.kanban`) but doesn't appear on THIS screen
(it's the tab-5 heading) — correctly scoped, not over-glossed on a screen that doesn't use the
word. No ungloseed jargon found on the Overview first screen.
