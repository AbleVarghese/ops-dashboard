# Ops Dashboard v3

A live, **project-agnostic**, **multi-project** SDLC / agent-activity monitor for Claude Code repos.
Zero npm dependencies, no build step, Node ≥22 built-ins only. Watches N projects' `~/.claude/projects/*`
transcripts, `reports/*.md` ledgers, and git state **simultaneously**, and pushes every change to the
browser over Server-Sent Events (typically <1s from disk write to UI).

> Built by [Able Varghese](https://github.com/AbleVarghese) as part of the agentic engineering system
> behind a [10-platform portfolio](https://github.com/AbleVarghese). Free and open source (MIT).
> **If it saves you time, a ⭐ helps other agent-fleet operators find it.**

v3's headline change from v2: there is no longer a single "active" project you switch between —
every enabled project is watched at once, with a unified project-tagged feed, per-project lanes, a
plain-English narrative strip summarizing all of them, and live stall detection.

---

## Repository index

| Repo | Purpose |
|---|---|
| **[ops-dashboard](https://github.com/AbleVarghese/ops-dashboard)** | This project — a live SDLC / agent-activity monitor for Claude Code repos (open source, MIT) |
| claude-config | The author's global Claude Code config it grew out of (private) |

Relocated 2026-07-24 from `~/.claude/lib/ops-dashboard` to its own standalone project so the config
backup stays pure config.

---

## Install

Nothing to install — it's a self-contained folder. Just have Node ≥22.

```bash
node --version   # must be >=22
```

## Run

```bash
cd ~/ops-dashboard
node server.mjs [repoPath]      # optional: adds + enables this repo on first boot if not already configured
```

Then open **http://127.0.0.1:4650**. Add, rename, enable/disable, or remove projects any time from
the **Settings** tab — every change applies live, no restart, no CLI re-run. "Suggested" projects
under Settings are auto-discovered from recently-active `~/.claude/projects/*` sessions (matched by
the `cwd` field inside their own transcripts — never a guessed/reconstructed path).

First run creates `config.json` (all settings including the project list, editable from the Settings
tab or by hand) and `data/<projectKey>/control.json` (the per-project control ledger) next to
`server.mjs`. A v2 `config.json` (single `projectRepoMap`) is migrated automatically on first v3 boot.

## Integrating with a project — local & remote

The dashboard is **project-agnostic and read-only against the project**: point it at any repo, no code
edits, no per-project install. It never writes into a watched repo — all control state lives under this
package's own `data/`.

### What it reads FROM a project (the integration surface)

| Source in the project | Feeds which tab | Required? |
|---|---|---|
| `.git` (branch, remotes, ahead/behind, tags, commit cadence) | Git, Overview | recommended |
| `~/.claude/projects/<hyphenated-abs-path>/*` transcripts | Agents, Live Feed | auto (Claude Code writes these) |
| `reports/*.md` ledgers | Live Feed | optional |
| `STATUS.md` (phase board) | Kanban | optional |
| `tasks.json` | Kanban | optional |
| `TEST-RUNS.md` | Tests & Quality | optional |

A project with none of the optional files still renders cleanly — those tabs just stay empty until the
files exist. **To enrich the dashboard for a project, have it maintain `reports/*.md`, `STATUS.md`,
`TEST-RUNS.md`, and/or `tasks.json`** (nothing else needed).

### A) Local integration (same machine as the projects)

Run natively, pointed at one project (adds + enables it on first boot); add more live from **Settings**:

```bash
cd ~/ops-dashboard
node server.mjs ~/keralora     # watch keralora
# open http://127.0.0.1:4650  → Settings tab to add solvemax-app, LawyerServed, … (all live, no restart)
```

Or containerized (mounts `$HOME` read-only at the same absolute path so transcript-dir names resolve):

```bash
REPO_PATH=~/keralora docker compose up --build   # http://127.0.0.1:4650
```

Local mode is bound to `127.0.0.1` — not reachable from other machines. Auth (`dashToken`) is optional here.

### B) Remote integration (hub + collectors, across machines)

For watching agents running on **other** machines, run a **hub** on a server and a **collector** on each
agent machine. The hub never touches any agent machine's filesystem — collectors push over authenticated
`POST /ingest`.

```bash
# On the hub server:
openssl rand -hex 32                       # generate DASH_TOKEN once
echo "DASH_TOKEN=<paste>" > .env
touch config.json                          # first run only
docker compose -f docker-compose.hub.yml up -d --build    # binds 0.0.0.0:4650

# On each machine that runs agents:
node collector.mjs --hub https://your-hub:4650 --token <paste> --project /path/to/project
```

- **Auth**: every route requires `Authorization: Bearer <DASH_TOKEN>` (or `?token=` for the SSE stream).
  Set a separate `COLLECTOR_TOKEN` so a leaked collector config can't be replayed against the dashboard's
  read/control routes.
- **TLS**: `DASH_TOKEN` is bearer-auth over plain HTTP — put a reverse proxy / TLS terminator in front of
  the hub for anything leaving your LAN.

## Uninstall

```bash
rm -rf ~/ops-dashboard
```

Nothing else on the machine references this folder — it's not a system service, it doesn't touch
any project's own files (control state lives under this package's own `data/`, not inside a watched
repo), and it isn't wired into any shell profile or launchd agent.

## The 9 tabs

| # | Tab | What it shows |
|---|---|---|
| 1 | Overview | KPI band aggregated across every enabled project (active agents, possibly-stalled count, kanban progress, last test result, pending control) + a 30-minute activity sparkline combining all projects |
| 2 | Projects (lanes) | One card per enabled project: live/building/verifying/stalled/idle agent counts, the top active agent's "currently doing" line, and its last git milestone |
| 3 | Live Feed | Every tool call, commit, tag, and ledger-row append from every watched project, pushed the instant it hits disk — project-tagged, filterable |
| 4 | Agents | Every agent across every project, sorted worst-first (possibly-stalled agents lead, sorted by longest-quiet; then live/active; idle collapsed behind a "+N idle" disclosure) — each row shows model/turns/tokens AND a live "currently doing" line parsed from its last tool call |
| 5 | Kanban | Cards from the selected project's `STATUS.md` phase board (+ optional `tasks.json`); a card whose owning agent is stalled is flagged red |
| 6 | Tests & Quality | The selected project's `TEST-RUNS.md` parsed into a pass/fail trend + full table |
| 7 | Git | The selected project's full git status: branch/remotes/ahead-behind, working-tree dirty summary, a 14-day commit-cadence sparkline, a committed→pushed→merged work-disposition matrix per branch, and a tags timeline |
| 8 | Control | Submit a request (ping/stand_down/respawn/pause_campaign/resume_campaign) targeting ONE project's control ledger, for that project's orchestrator watchdog to pick up |
| 9 | Settings | Project management (add/rename/enable-disable/remove, live, plus auto-discovered suggestions) + every other knob (ports, theme colors, feed timing, liveness thresholds, watched files, kanban columns, secret-redaction patterns) — persists to `config.json` |

A project with no `reports/` dir, no `.git`, or no Claude Code transcripts yet still renders a clean
dashboard with each panel's own empty state — nothing crashes on a fresh/unrecognized repo. A project
with `enabled: false` stays listed in Settings (re-enable any time) but its watcher is torn down.

## The narrative strip

Below the header, a plain-English sentence auto-generated from live state answers, in one glance:
how many projects are watched, which agent is doing what right now (with its actual last tool call),
when the last git milestone landed, and whether anything is stalled — e.g. *"2 projects watched. In
keralora, build-phase9c (live) — Read: .../competing-bids.tsx, 3s ago. Last milestone: tag rbac-a5 in
keralora. 1 agent possibly stalled: build-phase9b (keralora, 13m quiet)."* Jargon (agent, orchestrator,
tag, gate, SSE, transcript, kanban) has inline glossary tooltips (click the term); every panel has a
"?" button explaining what it shows and why it matters.

## Agent liveness — 6 states

Computed once (`lib/agent-status.mjs`) and used consistently everywhere (dots, chips, kanban
cards, the narrative) so nothing can disagree about whether an agent is stalled — or, just as
important, disagree about whether it's actually FINISHED rather than stuck:

| State | Meaning | Color |
|---|---|---|
| live | quiet < 60s (configurable) | green pulse |
| building | active, last tool edited/wrote/ran something | amber |
| verifying | active, last tool looked like a test/gate run | blue |
| **done** | the agent's own last TEXT message reads as a genuine sign-off (stand-down, "nothing further", a completion statement) — checked BEFORE the stall/idle timers, so a deliberately-finished agent never reads as stuck | dim, calm — deliberately NOT the alarming stalled-red |
| stalled | quiet 5+ min with NO sign-off — genuinely, nominally still in-progress | red, flagged, sorted to the top |
| idle | quiet 30+ min, no sign-off | dim, collapsed behind a disclosure |

`done` exists because a pure quiet-timer read can't tell "finished on purpose" from "stuck" — a
real false alarm the owner caught live (a stood-down agent reading as "possibly stalled") got
fixed by reading the agent's own words first. This is intentionally the SCOPED version of a much
larger agent-status taxonomy directive (8 states, multi-source cross-checking, a full "sensing
layer") — see `CLOSE-OUT.md`'s open items for what shipped here vs. what's proposed as a
follow-up pass.

## Control contract

The dashboard cannot reach into a running orchestrator session directly — there's no IPC channel
into another Claude Code process. Instead, submitting an action on the Control tab **appends a
request** to `data/<projectKey>/control.json` for the SELECTED project. An orchestrator that wants to
be controllable reads that file on its own cycle and marks entries `honored: true` once acted on.
This is a request/ack ledger, not a live command channel — treat it accordingly.

```json
{ "requests": [
  { "id": "...", "action": "ping", "agent": null, "note": "...", "ts": "...", "honored": false }
]}
```

**v3.3 — optional honoring metadata.** `honored: true` is the only REQUIRED field to mark a request
acted on. An orchestrator MAY additionally stamp `honoredAt` (ISO timestamp), `honoredBy` (who/what
honored it), and `honoredNote` (why/how) when it flips the flag — the dashboard's reader passes any
extra fields straight through untouched, and the Control tab renders them when present ("Honored
2026-07-24T… by build-orchestrator — stood down cleanly"). When they're absent (the minimum
contract above), the tab says so plainly ("Honored — n/a" for when/by/why) rather than inventing a
detail that was never recorded. This is additive and backward-compatible — nothing in the minimum
contract changed.

## Secret redaction

Every feed summary is sanitized (key/token/password/secret/`whsec_`/`sk_`/`Bearer` patterns
redacted) **before** it's truncated — so a secret can never be cut in half and partially leaked. Add
project-specific patterns (regex source strings) under Settings -> "Extra secret-strip regex patterns".

## Settings that need a restart

Everything in the Settings tab applies live — INCLUDING the project list (add/remove/enable/disable) —
**except** port, bind address, and the dash token, which require stopping and re-running
`node server.mjs` (the HTTP listener and auth middleware are bound at process start). The UI shows a
"restart required" chip when you save one of these.

## Docker

This section is LOCAL mode: the container runs on the same machine as your agents and bind-mounts
`$HOME` to watch them directly. Running the container on a DIFFERENT server instead? See "Remote
hub + collector deployment" below — same image, `docker-compose.hub.yml` instead, plus a small
native `collector.mjs` process on each machine that actually has agents.

```bash
touch config.json                                # first run only — see docker-compose.yml comment
REPO_PATH=~/keralora docker compose up --build
```

v3 mounts the whole of `$HOME` read-only (not a single `$REPO_PATH`) — since every project you'd
point the dashboard at is, in practice, under `$HOME`, this one broad mount lets you add/enable ANY
project live from Settings without editing the compose file or restarting the container. `REPO_PATH`
is still used to seed the first project on boot. Binds to `127.0.0.1:4650` on the host (not reachable
off-machine). See `docker-compose.yml`'s header comment for why the mount uses the real host absolute
path (required for the transcript-directory name derivation to match). Set `DASH_TOKEN=<random>` to
require bearer auth.

## Remote hub + collector deployment (v3.2)

The Docker section above ("local mode") bind-mounts `$HOME`, which only works when the container
runs on the SAME machine as your agents. If you want to run the dashboard as a container ON A
DIFFERENT SERVER — a VPS, a home server, anywhere that isn't the Mac your agents actually work on —
bind-mounting that Mac's data from a remote server is impossible. v3.2's collector/hub split solves
this: a lightweight, dependency-free **collector** runs natively on each machine that has agents,
and pushes what it sees over HTTPS to a **hub** (the same `server.mjs`, in hub mode) running
wherever you like.

```
┌─────────────────────────┐        HTTPS POST /ingest        ┌──────────────────────────┐
│  Your Mac (has agents)  │  events + snapshots + heartbeats │   Remote server (Docker)  │
│  node collector.mjs ────┼──────────────────────────────────▶  docker-compose.hub.yml   │
│  (watches local repos)  │        Bearer DASH_TOKEN          │   server.mjs, hub mode    │
└─────────────────────────┘                                   └──────────┬───────────────┘
                                                                            │ SSE
                                                                     your browser
```

**1. Stand up the hub** (on the remote server, once):

```bash
openssl rand -hex 32                              # DASH_TOKEN — browser dashboard + control auth
openssl rand -hex 32                              # COLLECTOR_TOKEN — recommended, SEPARATE from DASH_TOKEN
cat > .env <<EOF
DASH_TOKEN=<paste the first token here>
COLLECTOR_TOKEN=<paste the second token here>
EOF
touch config.json                                  # first run only, same reason as the local compose file
docker compose -f docker-compose.hub.yml up -d --build
```

**Why two tokens, not one:** `COLLECTOR_TOKEN` is the ONLY credential `/ingest` accepts once it's
set — `DASH_TOKEN` no longer works there. A laptop's collector config leaking (e.g. a stolen Mac,
a committed `.env`) then only ever grants "post feed events," never dashboard read+control access,
and vice versa. Leave `COLLECTOR_TOKEN` unset if you'd rather keep one shared token (backward
compatible with a single-token v3.1-style setup) — `/ingest` falls back to `DASH_TOKEN` in that case.

**2. Run a collector** (on every Mac/machine that has agents — a one-liner):

```bash
node ~/ops-dashboard/collector.mjs \
  --hub https://your-server.example.com:4650 \
  --token <the COLLECTOR_TOKEN, or DASH_TOKEN if you didn't set one> \
  --project keralora:~/keralora \
  --project dotclaude:~/.claude
```

Add as many `--project name:repoPath` flags as you have repos to watch, or use `--config
collector.config.json` for a longer list (see `collector.mjs`'s own header comment for the file
shape). The collector reuses the EXACT SAME watcher/feed/board-state pipeline `server.mjs` uses
locally — nothing about what it detects differs from local mode, only where the result is sent.

**3. Keep the collector running** (macOS `launchd`, survives reboots/logout):

```xml
<!-- ~/Library/LaunchAgents/com.opsdash.collector.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.opsdash.collector</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>~/ops-dashboard/collector.mjs</string>
    <string>--hub</string><string>https://your-server.example.com:4650</string>
    <string>--token</string><string>YOUR_COLLECTOR_TOKEN</string>
    <string>--project</string><string>keralora:~/keralora</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/opsdash-collector.log</string>
  <key>StandardErrorPath</key><string>/tmp/opsdash-collector.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.opsdash.collector.plist   # start now + on every login
launchctl unload ~/Library/LaunchAgents/com.opsdash.collector.plist # stop
```

**Reliability guarantees, precisely scoped:**
- **A network blip loses zero events already read from disk.** Every event the collector's file
  watchers pick up is durably queued to disk (`data/collector-outbox-<id>.ndjson`) BEFORE any
  network attempt; if the hub is briefly unreachable, items stay queued and are resent — including
  surviving the collector process itself being killed and restarted while items are still pending
  (verified live, `verify/collector-hub.mjs`). The one honest boundary: an event whose SOURCE FILE
  changed while the collector process was ENTIRELY DOWN (not just network-cut) with an already-empty
  outbox is not backfilled — this dashboard live-tails, it does not replay history from before a
  watcher started (the same characteristic local mode has always had; not new to hub mode).
- **A collector going offline is shown honestly, never as stale-data-as-fresh.** Every project's
  last-known board stays visible with `collectorOffline: true` and an age (`collectorOfflineMs`)
  once its owning collector misses ~3 heartbeats (45s default; `OPS_DASH_COLLECTOR_OFFLINE_MS` env
  var shortens this for testing).
- **`/ingest` has its own auth surface, security-reviewed against 7 acceptance items:** (1) auth
  runs BEFORE any request body is read or parsed — an unauthenticated POST can't burn CPU on a
  large payload; (2) the body-size cap is the SAME shared 1MB-capped reader every route uses, no
  separate uncapped path; (3) event summaries are re-sanitized at the ingest boundary (defense in
  depth — never trust network input as pre-cleaned, even from our own collector); (4) `event.kind`
  is validated against the real, reviewed `EVENT_KIND_NAMES` set before it can enter red-flag
  classification — an arbitrary string is refused, not injected; (5) `COLLECTOR_TOKEN` (recommended,
  separate from `DASH_TOKEN`) means a leaked collector config can't reach the dashboard's
  read/control routes, and vice versa; (6) a retried batch (the collector resends whenever a 2xx
  response is lost, even if the hub actually processed it) is deduped by the collector-local
  monotonic `seq` per collector — never double-counted or double-broadcast; (7) the hub never makes
  an outbound network call derived from collector-supplied data (confirmed by code audit — the only
  outbound HTTP anywhere in this package is `collector.mjs`'s own `hub-client.mjs`, and it always
  originates FROM the collector, never triggered by ingested content).
- **Local mode is completely unaffected.** A deployment with zero collectors registered runs the
  identical code path v3.1 always did — hub state only gets merged in when at least one collector
  has actually registered a project.

## Architecture (why it's structured this way)

- **`lib/paths.mjs`** — the only place that knows how a repo path maps to its Claude Code
  transcript directory name. Never scans `~/.claude/projects/*` wholesale (a literal glob over
  every project on a busy machine can be gigabytes and will hang a server — a real v1 incident).
- **`lib/project-manager.mjs`** — v3's core addition: owns one resolved `project` + one `feed`
  instance per ENABLED entry in `config.projects[]`, reconciled live on every add/remove/enable/
  disable — arms and disarms watchers without a process restart.
- **`lib/project-discovery.mjs`** — auto-suggests unconfigured, recently-active projects by reading
  the `cwd` field out of their own session transcripts (ground truth, never a lossy dirname-reversal
  guess).
- **`lib/feed.mjs`** (instantiable, `createProjectFeed()`) + **`feed-transcripts.mjs`/`feed-git.mjs`/
  `feed-reports.mjs`** — the three live sources per project, each returning a `stop()`.
- **`lib/offset-tracker.mjs`** — byte-offset tailing shared by every watcher across every project
  (paths are globally unique, so this stays safely module-level even with N projects armed at once).
- **`lib/agent-status.mjs`** — the single liveness classifier (5 states, above) used by
  `transcripts.mjs`, `board-state.mjs`, `kanban.mjs`, and the client — one source of truth.
- **`lib/git-status.mjs`** — comprehensive read-only git status per project: ahead/behind per remote,
  dirty-file summary, stash, tag timeline, 14-day commit cadence, and a committed→pushed→merged
  work-disposition matrix per branch/worktree.
- **`lib/narrative.mjs`** — composes the plain-English narrative strip server-side from the unified
  multi-project state.
- **`lib/sanitize.mjs`** — redact-then-truncate, applied at the single point every feed summary
  passes through, so no code path can skip it.
- **`lib/board-state.mjs`** — assembles one project's full snapshot; `project-manager.mjs` calls it
  once per enabled project and assembles the unified multi-project payload the client receives.
- **`lib/hub.mjs`** (v3.2) — the hub's entire model of what collectors have told it: per-project
  latest snapshot, a bounded feed ring, and heartbeat-based offline detection. Pure ingest state,
  no filesystem access of its own — everything it knows arrived over `/ingest`.
- **`lib/collector-outbox.mjs`** (v3.2) — `collector.mjs`'s disk-backed, bounded, ack-based send
  queue; the mechanism behind "a network blip loses zero events" (durable-before-send, resumes from
  disk after a crash, drops oldest-not-newest on a sustained outage with an honest overflow marker).
- **`lib/hub-client.mjs`** (v3.2) — the zero-dep HTTP(S) POST helper `collector.mjs` uses to talk
  to a hub.
- **`lib/watch-compat.mjs`** (v3.2) — `fs.watch` drop-in that falls back to mtime-polling (~2s) when
  native filesystem events are unreliable (some Docker bind-mount backends never deliver them across
  the mount boundary) — auto-detected via `/.dockerenv`, forced via `OPS_DASH_WATCH_MODE`.
- **`public/app.js`** — no framework, no bundler: native DOM + `EventSource` with a manual
  backoff-reconnect wrapper (native `EventSource` retry is fixed-interval only). Every renderer
  degrades to an empty-state message rather than throwing when a project doesn't have the file/data
  a panel wants. Theme MODE applies synchronously from `localStorage` before any network round-trip
  (a CSS `[data-theme="light"]` fallback block mirrors the server defaults so there's no dark-colors
  flash under a light attribute while config loads).

## Design

Default theme is "Ledger House" (see `public/styles.css`): a layered surface + ink ladder (never
opacity-faked hierarchy), one disciplined accent, hairline borders + a lit top edge (and explicit
hairline COLUMN rules between every table cell, not just row rules), no drop shadows, no gradients,
tabular numerals for all data. Status/liveness colors have separate WCAG-AA text-safe variants
(`--pass-text`, `--fail-text`, `--verifying-text`, etc.) from their dot/border hues — the saturated
hues read fine as small non-text accents but measured 2.5-3.5:1 as actual text, below the 4.5:1
minimum; axe-core found this during verification and it's now 0 violations. Fully themeable from the
Settings tab — every color persists to `config.theme.*` in `config.json`. The theme toggle in the
header flips light/dark at runtime (stored in the browser's `localStorage`, independent of the
server-side `defaultMode` setting).

## What this dashboard asserts vs. infers — and why you can trust each

This is a standing product promise (v3.1's "correctness law"), not an implementation detail: every
agent state shown carries a `confidence` field, and the UI copy itself says which kind of claim it
is — never blurs the two.

- **Asserted as FACT** — backed by direct, observable evidence, stated plainly:
  - **WORKING** / **COMPOSING** — the transcript's own last-write timestamp is recent (a real
    mtime, not a guess about what the agent is doing).
  - **WAITING** — the agent's own words name what it's waiting on ("waiting on the build to
    finish...").
  - **DONE** — a genuine sign-off in the agent's own words (a real "standing down" / "task
    complete", never inferred from silence).
  - **STOPPED** — session-ending language in the agent's own tail, OR the harness's own structured
    `isApiErrorMessage`/`apiErrorStatus` field (the v3.1 sensing layer's error-recognition
    recognizer) — a typed signal the harness itself set, stronger evidence than any text pattern.
  - **PAUSED** — a control.json request exists AND was honored (a real ledger entry, not assumed).
- **Labeled as INFERENCE** — absence of evidence, never asserted as fact, and the UI copy says so:
  - **POSSIBLY STUCK** — quiet beyond the stall threshold with no completion signal. The dashboard
    genuinely cannot distinguish "stuck" from "still silently working" without deeper tooling — a
    SILENT kill (the process dies mid-tool_use with no explanatory text) falls through to this
    state rather than STOPPED, which is the honest answer, not a false-precision guess.
  - **ORPHANED / PRESUMED DEAD** — long-quiet + no completion signal + (session-level only — see
    below) no matching process. Copy says "presumed dead," never "dead."
- **No numeric confidence scores, anywhere** — an uncalibrated percentage is worse than a clear
  fact/inference label (a deliberate, explicit product decision, not an oversight).
- **Source-conflict handling**: when two real evidence sources disagree (e.g. a control.json pause
  request exists but the transcript tail shows fresh activity), the conflict is SURFACED in the
  evidence string (`sourceConflict: true`), never silently arbitrated in either direction.
- **A documented, audited boundary, not glossed over**: `meta.json` is spawn-time CONTEXT ONLY (an
  audit of 8,208 real files on this machine found zero status-shaped fields, ever — see
  `verify/META-JSON-AUDIT.md`), and the "process table" cross-check is SESSION-level, not
  per-subagent (subagents share one OS process — no individual PID exists to check on this
  machine's real data). Both corrections are stated here exactly as found, not smoothed over.
- **The sensing layer (v3.1 Stage 4) extends the evidence, not the honesty boundary**: recognizers
  add richer STRUCTURE to what's already observable (which file was touched, what a Bash command
  actually was, parsed pass/fail counts, a structured API-error field) — they do not let the
  dashboard claim to know something it can't. A `test_result` event reports the counts a tool
  actually printed; it is never upgraded to "verified correct" beyond what the counts themselves say.

## Sovereignty — what this dashboard depends on, and what it doesn't

Every capability this dashboard has is its own. Certified by code audit (grep every I/O call site
below), not just asserted — a three-tier contract:

**1. Self-owned core (unconditional — zero runtime deps, air-gapped-capable):**
- `package.json` `dependencies`/`devDependencies` are both `{}` — Node ≥22 built-ins only, always.
- The only I/O the running server/browser ever perform: **`node:fs`** (reading `~/.claude/projects/*`
  transcripts, `reports/*.md`, `.git/`, `config.json`, writing `config.json`/`data/*` and this
  package's own control ledgers), **`node:child_process` → `git`** (local subprocess, read-only
  flags only — `git status`/`log`/`branch`/`tag`/`worktree`/`for-each-ref`, never `push`/`fetch`/
  `pull`, never a remote URL touched), and **`node:http`** serving `127.0.0.1`-bound HTTP/SSE to
  the local browser (no outbound requests — `server.mjs`'s only `http://` string literals are its
  own request-URL parsing and its own startup log line). No CDN scripts, no external fonts (the
  three declared families — Fraunces/Inter/IBM Plex Mono — fall back to system stacks when not
  locally installed; nothing is fetched to render them), no analytics, no telemetry, no cloud calls.
  **Guarantee: this half of the contract runs fully air-gapped** — verified by the code-audit above
  (every `fetch`/`https://`/`WebSocket`/external-`require` call site was searched for and found
  absent; the only `http://` literals are local-URL parsing and a log line, listed above).
- Docker (optional, for containerized runs): the image is `node:22-alpine` + this package's own
  files (`git` added via `apk`, see the Dockerfile), nothing else installed at build time.
- **v3.2 amendment, stated plainly (not glossed over):** `collector.mjs` is a SEPARATE, OPT-IN
  process from `server.mjs` — it exists specifically to make outbound `node:http`/`node:https`
  requests to a hub you configure via `--hub`/`--token`. This is a deliberate exception to the
  "no outbound requests" guarantee above, scoped exactly to this one script: `server.mjs` itself
  (local mode OR hub mode) never initiates an outbound request — hub mode only RECEIVES `/ingest`
  POSTs, it doesn't reach out anywhere. If you never run `collector.mjs`, the zero-outbound-traffic
  guarantee holds exactly as documented; running it is an explicit choice to send your own feed
  data to a hub URL you specify, nothing more.

**2. External VALIDATORS — blessed, never a dependency:** Playwright, axe-core, and Lighthouse-class
tooling are used to VALIDATE this dashboard (screenshots, accessibility scans, latency measurement)
via `verify/*.mjs`, loaded from an external checkout's `node_modules` at verification time
(`PLAYWRIGHT_REQUIRE_PATH`, see `verify/README.md`) — never `import`ed by `server.mjs` or anything
under `lib/`/`public/`, never installed into this package, never required for the dashboard to run.
The boundary is structural, not just documented: nothing in the shipped product can reach these
packages even if they happen to be present on the machine.

**3. Optional COMPOUNDING readers (not yet built, allowed when they arrive):** read-only,
config-gated, degrade-gracefully enhancers that read a project's own on-disk artifacts if present
(e.g. a CI/Sentry export already written to disk by another tool) MAY be added later to enrich
recognition — never as a required dependency, never as an outbound network call, never breaking
core function when absent. None exist yet; this tier is a standing design constraint for future
recognizers, not a current capability.

## Tests

```bash
npm test   # equivalent to: node --test test/*.test.mjs test/recognizers/*.test.mjs
```

Unit coverage for the liveness classifier, git-status parsing, and narrative composition. Full
reproducible gate-evidence harness (latency, burst, fault-injection, soak, Docker, screenshots):
see `verify/README.md` and `../CLOSE-OUT.md`.

## Gates run before this was called done

`node --check` on every `.mjs` file · `node --test` (unit suite, green) · server started + every route
curled (including live project add/enable/disable/remove) · SSE first-frame receipt + manual
reconnect-with-backoff verified · `/api/control/:key` POST round-trip · Playwright screenshots at
390/768/1440/1920, light and dark, zero console errors, zero failed requests, zero horizontal scroll ·
axe-core accessibility scan, 0 violations · functional exercises (glossary popover, idle-agent
disclosure, kanban-card drawer, project add/enable/disable, theme toggle) · Docker build + run
verified with the broad `$HOME` mount, live project add confirmed inside the container · multi-project
concurrent-watch demo (2 real projects armed simultaneously, independent stall detection per project).
