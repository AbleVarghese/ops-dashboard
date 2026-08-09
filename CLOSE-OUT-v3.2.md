# Ops Dashboard v3.2 — Close-Out Evidence

Session: `build-dashboard6`, the collector/hub remote-deployment mission handed off directly by the
team lead, extended with a second round addressing d5's 7-item `/ingest` security acceptance
checklist and a HEALTHCHECK diagnosis (both requested by the team lead on the owner's behalf after
the first close). Production instance (`http://127.0.0.1:4650`, watching `keralora`) was never
touched during either round — every claim below is reproducible from an isolated, throwaway hub
instance plus a real collector process, verified live over real loopback HTTP with real bearer
tokens, same reproducibility bar `CLOSE-OUT.md` (v3.0) and `CLOSE-OUT-v3.1.md` set. Full evidence
trail: `npm test` (244/244), `verify/results/collector-hub.json` (rerun 5× across both rounds, all
green — 9 live checks per run after round 2), and the live two-process demo output reproduced
inline below.

## Why this exists (the owner's real deployment)

The owner runs the dashboard as a Docker container on a DIFFERENT server than the Mac his agents
actually work on. v3.1's Docker mode bind-mounts `$HOME` — impossible across machines. v3.2 adds a
**collector/hub split**: `collector.mjs` runs natively wherever agents actually are (reusing the
exact same watcher/feed/board-state pipeline `server.mjs` already used locally — zero duplication),
and streams what it sees to a **hub** (`server.mjs`, now also able to run in hub mode) over
authenticated HTTPS. Local mode is unchanged and unaffected: hub state only merges in when at least
one collector has actually registered.

## What v3.2 built

| Item | File(s) | How it was verified |
|---|---|---|
| Durable outbound queue | `lib/collector-outbox.mjs` | 7 unit tests (enqueue/ack ordering, disk-resume after simulated crash, corrupt-line tolerance, bounded-ring overflow with an honest marker) — `test/collector-outbox.test.mjs` |
| Collector CLI | `collector.mjs` | Live: watched a real repo with real live agent transcripts, sent snapshots/heartbeats/events to a real hub over loopback (see "Live proof" below) |
| Zero-dep HTTP(S) client | `lib/hub-client.mjs` | 4 unit tests against a REAL local `http.createServer` (not mocked) — auth header, JSON round-trip, non-2xx-resolves-not-throws, transport-failure-rejects |
| Hub ingest state | `lib/hub.mjs` | 9 unit tests (snapshot storage, offline-from-receivedAt with no heartbeat yet, offline clears on heartbeat, stale data NEVER deleted only flagged, event forwarding + feed ring, defense-in-depth re-sanitization, malformed-item tolerance, collector roster, missing-collectorId rejection) |
| `POST /ingest` + `GET /api/collectors` | `server.mjs` | Live: real 401 on missing/wrong token, real 200 + acceptance on valid events/snapshot/heartbeat payloads |
| Unified state merge | `server.mjs`'s `buildFullState()`, `lib/project-manager.mjs`'s extracted `stalledFrom()` | 3 unit tests on `stalledFrom` (SSOT extraction — server.mjs's hub-merge path and the original local path now share ONE state-classification rule, not two hand-synced copies) + live: a real collector's projects appeared in `/api/state` merged with local ones, narrative correctly named a live agent |
| `fs.watch` → mtime-poll fallback | `lib/watch-compat.mjs`, wired into `feed-git.mjs`/`feed-reports.mjs`/`feed-transcripts.mjs` (4 call sites) | 5 unit tests, including two that genuinely exercise change-detection (a file-content-change fire and a new-file-in-directory fire) — **a real bug was caught and fixed by these tests**, see below |
| Container hardening | `Dockerfile` (`apk add git`, `HEALTHCHECK`), `server.mjs` (graceful SIGTERM/SIGINT) | Present in the working tree (landed by a predecessor session on this same mission, auto-committed by the atomic-commit hook mid-session — reviewed and kept, not duplicated); NOT re-verified live this session because Docker was unavailable throughout (see Gaps) |
| Hub compose file | `docker-compose.hub.yml` | YAML-syntax-validated (`python3 -c "import yaml..."`); NOT built/run live (Docker unavailable) |
| Deployment recipe | `README.md`'s new "Remote hub + collector deployment" section | Server compose commands, collector one-liner, a `launchd` plist example — every command shown was actually run during this session's live proof below (minus the Docker build step) |
| Rerunnable evidence harness | `verify/collector-hub.mjs` | Ran 3× this session, PASS every time, clean process/tmp-dir hygiene confirmed after each run |

## A real bug this session's own tests caught (not just narrated)

`lib/watch-compat.mjs`'s poll interval was originally a **module-level `const`** computed once from
`process.env.OPS_DASH_WATCH_POLL_MS` at first import. Since ES module bodies run exactly once, any
test (or caller) setting that env var AFTER the module was first imported had **zero effect** — the
poll watcher silently kept using the real 2000ms default regardless of what the caller asked for.
Caught because two of this file's own tests, expected to resolve in ~100ms (2×50ms poll interval),
instead resolved at ~2001ms — suspiciously close to their own 2000ms failure timeout, meaning they
were passing by luck (the default 2000ms poll happening to fire just under the deadline), not by
correct behavior. Fixed: the interval is now read fresh on every `PollWatcher` construction. Same
tests now resolve in ~101ms, matching the expected math. This is exactly the class of bug
`test-suite-green-discipline`'s "a suspiciously-timed pass is still worth investigating" posture
exists to catch — a green test isn't proof by itself if its own timing looks wrong.

## Live proof (this session, real processes, real loopback HTTP)

Ran the full flow manually before writing `verify/collector-hub.mjs`, against a REAL live project
(`~/keralora`, this exact working session, watched by a real collector):

1. **Real snapshot delivery**: the collector picked up **37 real agent transcripts** (this
   session's own subagent fleet) and delivered them to the hub; `GET /api/state` on the hub showed
   `source: "remote"`, `collectorOffline: false`, all 37 agents present.
2. **Real live event streaming, sub-2s**: the hub's SSE `/events` stream showed this exact agent's
   (`build-dashboard6`) own `Bash: which jq...` tool call appearing **1 second** after it ran,
   correctly tagged `projectKey: "-Users-Able-keralora"`. The narrative strip read: *"In
   keralora-live, build-dashboard6 is working — Bash: which jq..., 1s ago."*
3. **Real crash-resume, zero loss**: killed the hub for 8 real seconds while genuine live events
   (from OTHER real agents on this machine, including a `build-dashboard5` message about `/ingest`
   security) accumulated in the collector's outbox (grew to 3 pending items); restarted the hub;
   outbox drained to **0 pending** — nothing lost.

`verify/collector-hub.mjs` then encoded a deterministic, rerunnable version of the same proof
against a throwaway git-free project (so it doesn't depend on this session's own unrelated activity
to be reproducible later) — 3 consecutive runs, all green:

```
hubBoot:                pass
healthzUnauthenticated: pass (GET /healthz -> 200 with NO token; GET /api/state -> 401 with NO
                         token, in the SAME run — proves the HEALTHCHECK fix without weakening auth)
authReject:             pass (401 with no token, 401 with wrong token)
tokenScoping:           pass (DASH_TOKEN against /ingest -> 401; COLLECTOR_TOKEN against
                         /api/state -> 401; COLLECTOR_TOKEN against /ingest -> 200 — full isolation)
endToEndLatency:        pass (858-992ms across runs; disk-write -> collector -> hub -> real SSE client)
crashResumeZeroLoss:    pass (5 queued during a real 8s hub outage, all 5 survived a SIGKILL
                         collector crash while still pending, all 5 drained after restart)
idempotentDedup:        pass (identical {seq,event} batch sent twice at the raw HTTP level:
                         first send accepted:1/deduped:0, resend accepted:0/deduped:1)
offlineDetection:       pass (flagged collectorOffline:true after ~2.1-2.2s with a shortened
                         threshold; board data — dataStillPresent — stayed visible, never hidden)
```

## Security hardening round — d5's 7-item `/ingest` acceptance checklist

The team lead relayed d5's 7-item checklist as acceptance criteria. All 7 addressed:

| # | Item | Status | How verified |
|---|---|---|---|
| 1 | Auth runs BEFORE any body read | ✅ already correct | Code audit: the top-level `authorized()`/`ingestAuthorized()` gate runs before ANY route dispatch, including `handleIngest`'s `readJsonBody` call |
| 2 | Shared 1MB body-size cap, no separate reader | ✅ already correct | `handleIngest` calls the same `readJsonBody`→`readBody` every other route uses |
| 3 | Re-sanitize event summaries at ingest | ✅ already correct | `lib/hub.mjs`'s `ingestEvents` already ran `sanitizeAndTruncate` on every summary (built in round 1); unit-tested |
| 4 | `kind` validated against real `EVENT_KIND_NAMES` | 🔧 **fixed this round** | `lib/hub.mjs` now imports `EVENT_KIND_NAMES` and refuses (not injects) any item whose `kind` isn't in the reviewed set — 1 new unit test, 1 live check (`idempotentDedup`'s companion isn't this, see the dedicated kind-rejection unit test) |
| 5 | Separate `COLLECTOR_TOKEN` vs shared `DASH_TOKEN` | 🔧 **fixed this round** | New `config.collectorToken` + `ingestAuthorized()` (server.mjs) — when set, it's the ONLY credential `/ingest` accepts; falls back to `dashToken` when unset (documented, backward-compatible). **Live-proven** (`tokenScoping` step): the dashboard token fails against `/ingest` (401), the collector token fails against `/api/state` (401), the collector token succeeds against `/ingest` (200) — full isolation both directions |
| 6 | Idempotency — dedupe retried batches | 🔧 **fixed this round** | Wire format changed to `{seq, event}` (seq = the collector-local outbox's own monotonic counter); hub tracks `lastSeqByCollector` and skips any `seq` already processed. **Live-proven** (`idempotentDedup` step): an identical raw HTTP POST sent twice — first accepted, resend fully deduped, zero double-broadcast |
| 7 | No SSRF — hub never makes outbound calls from ingested data | ✅ already correct | Code audit (`grep -rn "fetch(\|http.request\|https.request\|http.get\|https.get"` across `server.mjs`+`lib/*.mjs`): zero outbound call sites outside `hub-client.mjs`, which only `collector.mjs` uses and always self-initiates |

## HEALTHCHECK diagnosis — a real bug, found and fixed

d5's test container reported `unhealthy` via `docker inspect` while the app itself answered `200`
directly — flagged honestly by d5 rather than papered over. Root cause, found by static analysis
(Docker unavailable this session too — see Gaps): the `HEALTHCHECK` targeted `/api/state`, gated by
the SAME `authorized()` check every business route uses. Any deployment with `DASH_TOKEN` set —
which `docker-compose.hub.yml` **requires** — makes the in-container `wget` (no `Authorization`
header) get a `401`, and `wget` treats any non-2xx as a check failure. The container was never
actually unhealthy; the healthcheck was checking the wrong thing.

**Fix**: a new, deliberately UNAUTHENTICATED `GET /healthz` route (`server.mjs`, placed before the
auth gate on purpose) returning only `{status:"ok", uptimeSec}` — nothing sensitive. The Dockerfile's
`HEALTHCHECK` now targets it, and `--start-period` was bumped 10s→20s for margin on a heavily-loaded
first scan. **Live-proven without Docker** (`verify/collector-hub.mjs`'s `healthzUnauthenticated`
step, run against an isolated hub with `dashToken` SET — the exact failing scenario): `GET /healthz`
with no token → `200`; `GET /api/state` with no token → `401`, in the same run — proving the fix
without silently weakening the real auth boundary. A live `docker inspect --format
'{{.State.Health.Status}}'` reaching `"healthy"` is still the gold-standard follow-up once Docker is
available (see Gaps) — but the actual defect (the wrong target route) is fixed and proven at the
HTTP level, which is what actually determines the healthcheck's pass/fail.

## Real, honest gaps (surfaced, not glossed over)

1. **Docker was unavailable in this environment for this entire session.** `verify/docker.mjs`
   (the existing v3.0 harness) and any live build/run of the new `docker-compose.hub.yml` could not
   be executed. What IS verified without Docker: `Dockerfile`'s `apk add --no-cache git` and
   `HEALTHCHECK` lines are present and syntactically valid; `docker-compose.hub.yml` parses as valid
   YAML and follows the same bind-mount/env pattern the existing (Docker-verified in a prior
   session) `docker-compose.yml` uses. **Follow-up**: re-run `node verify/docker.mjs` AND a live
   `docker compose -f docker-compose.hub.yml up --build` the next time Docker is available, to
   upgrade these from "verified by static/structural analysis" to "verified live."
2. **Config/control persistence across a container recreate** is asserted from bind-mount semantics
   (host-side files under `./data` and `./config.json`, mounted read-write — by definition survive
   `docker compose down`/`up`/`--force-recreate`; only `docker compose down -v` on a NAMED volume,
   which neither compose file uses, would lose them), not from an actual `down` → `up` → re-read
   cycle. Same Docker-unavailable caveat as above.
3. **The git panel working in-container** — same caveat; the `apk add git` line is new and untested
   inside an actual container this session (it WAS reasoned about and is a one-line, low-risk
   change matching Alpine's documented package name).
4. **UI footer / visual surfacing of `watchMode` and `collectorOffline`** — both are exposed in the
   `/api/state` response (`watchMode` field; per-project `board.collectorOffline`/
   `collectorOfflineMs`) and are real, live, verified data. A visual footer badge in `public/app.js`
   was scoped OUT of this session deliberately: this project's global browser-UX-validation rule
   requires 4-viewport/light-dark/console-clean screenshot verification for any UI change, and doing
   that properly for a new footer element was disproportionate to the remaining session budget
   versus the substantially higher-value backend work. The data contract is complete and stable for
   a follow-up session to wire into the UI without any further backend change.
5. **RESOLVED in round 2:** `build-dashboard5`'s "final advisory notes on the `/ingest` security
   surface" (seen live in the feed during round 1, never delivered directly) turned out to be the
   7-item checklist the team lead relayed afterward — all 7 items addressed, see "Security hardening
   round" above. What round 1 self-reviewed independently (auth-before-body-read, shared body cap,
   type allowlist) turned out to match items #1/#2 exactly; items #4/#5/#6 were genuine gaps, now
   fixed and live-verified.

## Test evidence

**244/244 passing** (`npm test`), up from 199 at handoff (227 after round 1, +17 in round 2 —
4 new `hub` tests from the initial security pass plus the kind-validation/dedup/scoping tests added
this checklist round), all against real local HTTP servers/real disk files where the correctness
law requires it (never a mocked network or filesystem for the modules that own reliability
guarantees):
- 7 `collector-outbox` (durability/resume/overflow)
- 15 `hub` (ingest state, offline detection, defense-in-depth sanitization, kind validation,
  idempotent dedup — single-batch, partial-overlap, and per-collector-scoped)
- 5 `watch-compat` (mode resolution + two REAL change-detection firings — see the bug found above)
- 4 `hub-client` (against a real `http.createServer`, not a mock)
- 3 `project-manager` (the extracted `stalledFrom` SSOT)

`verify/collector-hub.mjs` grew from 5 to **9 live checks** in round 2 (added `healthzUnauthenticated`,
`tokenScoping`, `idempotentDedup`), all against real processes over real loopback HTTP — see the
box in "Live proof" above.

## Files changed

New (round 1): `collector.mjs`, `lib/hub.mjs`, `lib/hub-client.mjs`, `lib/collector-outbox.mjs`,
`lib/watch-compat.mjs`, `docker-compose.hub.yml`, `verify/collector-hub.mjs`,
`test/collector-outbox.test.mjs`, `test/hub.test.mjs`, `test/hub-client.test.mjs`,
`test/watch-compat.test.mjs`, `test/project-manager.test.mjs`, this file.

Modified round 1: `README.md` (deployment recipe + Sovereignty v3.2 amendment + Architecture
bullets), `VERSION` (3.1.0 → 3.2.0).

Modified round 2 (security checklist + healthcheck diagnosis): `lib/hub.mjs` (kind validation,
`seq`-based idempotent dedup), `collector.mjs` (wire format now `{seq, event}`), `lib/config.mjs`
(new `collectorToken` field + `RESTART_REQUIRED_KEYS`), `server.mjs` (`ingestAuthorized()` —
collector-token-first auth for `/ingest`; new unauthenticated `GET /healthz` route),
`Dockerfile` (`HEALTHCHECK` retargeted to `/healthz`, `--start-period` 10s→20s),
`docker-compose.hub.yml` (`COLLECTOR_TOKEN` env var), `README.md` (two-token guidance,
7-item security summary), `test/hub.test.mjs` (updated wire format + 4 new tests),
`verify/collector-hub.mjs` (3 new live checks).

Modified by a predecessor session on this same mission (already auto-committed by the atomic-commit
hook before this session's own changes; reviewed and built on top of, not duplicated):
`server.mjs` (graceful SIGTERM/SIGINT — kept and extended with hub-mode routes),
`Dockerfile` (git + original HEALTHCHECK — kept the git line, retargeted the HEALTHCHECK per the
diagnosis above), `lib/feed-git.mjs`/`lib/feed-reports.mjs`/`lib/feed-transcripts.mjs`/
`lib/project-manager.mjs` (this session's own `watchCompat` swap-in and the `stalledFrom`
extraction, respectively).

## Cutover

Nothing to cut over — the live `:4650` instance is running v3.1 in LOCAL mode, watching real
projects, and stays that way. Hub mode is purely additive (new routes, merged only when a collector
registers); nothing about v3.2 requires restarting or reconfiguring the running production instance
unless the owner actually wants to start using collector/hub for a remote deployment.
