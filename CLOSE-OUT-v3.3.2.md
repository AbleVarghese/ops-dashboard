# Ops Dashboard v3.3.2 — Close-Out Evidence

Scope: the **git subprocess process storm** — production was proven by intervention to be the source
of **20–46 permanently-live `git status --porcelain=v2` processes** on an otherwise idle laptop.
This release bounds git subprocess usage, and — because the fix was activated and then *measured on
the real deployment* — it also removes four further defects that no test had been able to see.

This is the direct sequel to v3.3.1, and it corrects that release. v3.3.1's latency work was right
about latency and wrong about resource control.

---

## 1. Root cause

`v3.3.1` converted every git call in `lib/git-status.mjs` from the synchronous `execFileSync` to the
asynchronous `execFile`, and grouped independent calls under `Promise.all`.

**`execFileSync` had been acting as an accidental global mutex.** A single-threaded Node process
running a *synchronous* subprocess cannot, by construction, have two children alive at once — and it
cannot begin a second board refresh while the first is still running, because the first is occupying
the event loop. Removing `Sync` removed that mutex. Nothing was put in its place: no single-flight,
no semaphore, no cache, no refresh coalescing.

The fan-out then multiplied against the fan-in:

```
FAN-IN (every one ungated)                    FAN-OUT (per refresh)
  5s backstop tick                              Promise.all over N projects
  feed events, 150ms debounce (leading edge)      -> Promise.all over R remotes
  every GET /api/state                            -> Promise.all over B branches
  every SSE connect                               -> 1 status scan per worktree
  every project add/patch/delete
```

Worse, the same commit **shrank the debounce 400ms → 150ms** on the reasoning that the rebuild was
now cheap — raising the trigger rate at the exact moment the serialization was removed.

### Upper bound, before

```
per project refresh   = 10 + 2R + 2B + W git subprocesses
CONCURRENT_status     = I x SUM(W_p)      where I = overlapping refreshes ~ ceil(T_refresh / 150ms)
```

4 projects, W≈2–3 each, refresh 300–700ms against a 150ms cadence → **16–48 concurrent status
processes predicted. 20–46 observed.** The formula and the observation agree.

---

## 2. The fix — five mechanisms

All git children now pass through `lib/git-runner.mjs`, and nowhere else.

| Mechanism | Guarantee |
|---|---|
| Per-repository single-flight | Never two concurrent snapshots of one repo |
| Per-command dedup + per-snapshot memo | Identical argv+**canonical** cwd share one subprocess; a worktree is scanned at most once per snapshot |
| Global semaphore (default **2**) | At most N git children exist at any instant, process-wide |
| Stale-while-revalidate cache | After the first scan a caller never blocks on git; degraded snapshots are never treated as fresh |
| Timeout + process-group hard kill | No hung git can hold a concurrency slot forever |

Plus, in `server.mjs`: at most one full-state rebuild in flight (trailing-edge coalesced), **no work
at all when zero SSE clients are connected**, and last-known-good served instantly on connect.

---

## 3. What activation found that the tests could not

The storm fix passed 258 tests before any of the following was known. Each was found by running the
real thing and measuring it, and each now has its own regression guard.

| # | Found by | Defect | Fix |
|---|---|---|---|
| 1 | The worktree test | Dedup key did not canonicalize paths — macOS `/var`→`/private/var` made the main working tree scan **twice per snapshot**, on exactly the storm command | realpath in the key |
| 2 | 40-request live burst | TTL (2s) was **shorter than the scan it cached**, so it never helped: the burst took **99s**, `peakQueued` 241 | stale-while-revalidate + event-driven invalidation |
| 3 | Per-repo timing | **Licentric has 229 local branches**; the matrix cost 2 subprocesses *per branch* → ~471 per refresh (`exitFailures: 466` was one rev-parse miss per unpushed branch) | one bulk `for-each-ref`; output byte-identical |
| 4 | 60s idle measurement | Idle server with **no browser open** burned **663 subprocesses/min at 28.5% CPU** — `broadcast()` no-opped *after* the work was already done | skip the rebuild when zero clients |
| 5 | Real browser render | The idle-skip then caused **"0 PROJECTS / Loading live state…"** for ~6s on a fresh tab | serve remembered snapshot on connect + one boot warm-up |

Defect 4 is the one that would never have been found from a test suite: the storm was already fixed,
and the machine was still spawning 663 git processes a minute for an empty room.

---

## 4. Evidence

### Benchmark (`node verify/git-storm-bench.mjs`)
4 projects x (6 branches, 2 extra worktrees), 20 overlapping refreshes:

| | Before (ungoverned) | After |
|---|---|---|
| git subprocesses | 1040 | **84** (−91.9%) |
| Peak simultaneous | **554** | **2** |
| Wall clock | 29244ms | **1735ms** |

### Live deployment (5 real projects, one with 229 branches)

| Metric | Before | After |
|---|---|---|
| Peak simultaneous git processes | 20–46 | **2** (OS-sampled, not self-reported) |
| 40 concurrent `/api/state` | 99s | **10.7s** |
| Idle, no browser connected | 663 procs/min, 28.5% CPU | **0 procs, ~0% CPU** |
| Licentric per refresh | ~471 subprocesses | ~15 |
| First state frame on connect | ~6s ("Loading live state…") | **<1.5s** (guarded) |

### Tests — **263 passing, 0 failing**
17 new, including:
- 100 simultaneous requests to one repo → **exactly 1** working-tree scan
- global bound holds at limits 1, 2 and 4; no slot ever leaked
- a hung git (leaking its pipe to a grandchild) is killed and the slot released
- the request immediately after a timeout succeeds
- 121 branches must cost <40 subprocesses
- an idle server spawns **0** git processes across 3 backstop ticks, and still wakes correctly
- **negative control:** the pre-fix code path reproduces the storm (peak ≥10, measured 550) — the
  instrument is proven able to see the fault it is asserting the absence of

### Browser
Rendered at 390/768/1440/1920 x light+dark: **0 console errors, 0 failed requests, 0 horizontal
overflow**, 5 projects live.

> **Tooling note:** `~/.claude/lib/ux-verify.sh` reports a **false failure** on this app. It waits for
> `networkidle`, which never occurs for a page holding a permanent SSE stream, so all 8 navigations
> time out at 30s. Verified with `domcontentloaded` instead. This affects any streaming/SSE app, not
> just this one.

---

## 5. Activation

Activated 2026-08-15 as the `com.opsdash.server` LaunchAgent, watching 5 projects.

**Two real traps, both hit and both documented so the next person does not:**

1. The service had been `launchctl disable`d, not merely booted out. `bootstrap` alone fails with
   `Input/output error (5)`. `launchctl enable gui/$(id -u)/com.opsdash.server` must come first.
2. The persistent disabled flag **survived the first enable** and launchd later tore the running
   service down with a graceful SIGTERM. Verify with
   `launchctl print-disabled gui/$(id -u) | grep opsdash` — it must read **enabled**, not just
   "the process is running right now". A service that is running but still flagged disabled will not
   come back after a reboot.

Verified after activation: loaded, persistently `enabled`, `healthz 200`, and KeepAlive proven by
`kill -9` → respawn → `healthz 200`.

### Rollback

```bash
launchctl bootout gui/$(id -u)/com.opsdash.server
cd ~/ops-dashboard && git revert --no-edit b5a22f4 fb7ca0f 8697000 c232395 fea4827
```

---

## 6. Honest gaps

- **`.claude` is watched (5 projects, not the prior 4).** Auto-seeded from `projectRepoMap` on boot;
  it was not in the pre-incident set. Harmless, but it is a change from the previous production
  state. Remove with `curl -X DELETE localhost:4650/api/projects/-Users-Able-.claude`.
- **`package.json` says `3.0.0-final` while `VERSION` says `3.3.2`.** Pre-existing inconsistency,
  not introduced here; `VERSION` is the file the repo treats as the version of record.
- **Concurrency 2 is a dial, not a law.** It is the safety bound; if the board ever feels slow on a
  cold cache, raise `OPS_DASH_GIT_CONCURRENCY` rather than reverting. The property that must never
  regress is that the bound *exists*.
- **`git status` writes `.git/index`.** This is why invalidation fires only on semantic HEAD/tag
  movement and never on raw `.git` filesystem churn — the latter would make the scan retrigger
  itself, which is the same shape as the bug this release removes. Do not "improve" it.
