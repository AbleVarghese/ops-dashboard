# verify/ — reproducible gate evidence

Every script here runs against a REAL, LIVE dashboard server (default `http://127.0.0.1:4650`,
override with `DASH_URL`) and produces a JSON result in `verify/results/`. None of them mock
anything — they exercise the actual API/SSE/filesystem-watching behavior, the same way a real
deployment would be exercised.

## Scripts

| Script | Gate | What it does | Deps |
|---|---|---|---|
| `latency.mjs` | M1 | Disk-write → SSE-arrival latency for two source types (report file, git commit) + cold `/api/state` timing | none (Node built-ins) |
| `burst.mjs` | M1 | Fires N (default 500) rapid writes, measures distinct-event arrival, frame timing, sustained rate | none |
| `fault-injection.mjs` | M5 | Breaks 4 real things against the LIVE server (malformed settings, vanished project dir, rotated report file, bare project) and checks the server survives | none |
| `soak-snapshot.mjs` | M5 | Samples the server process's RSS over a window, checks bounded (not unbounded) growth | none |
| `screenshots.mjs` | M3, M9 | Screenshots every tab × viewport × theme to a predictable path, checks h-scroll + console errors | **Playwright** (see below) |

## Why `screenshots.mjs` needs Playwright (and the other 4 don't)

This project's own hard rule is zero npm dependencies for the PRODUCT (`server.mjs`, everything
under `lib/`, everything served to the browser) — that rule is intact; nothing under `verify/`
ships to a user or gets imported by the running dashboard.

Taking an actual pixel screenshot and running axe-core against a real rendered DOM requires a
real browser engine — there's no way to do that with Node built-ins, the same way a project's
own CI test suite needs a test runner without that runner becoming a product dependency. The
other 4 scripts only need HTTP + filesystem + git, which Node ships natively, so they stay at
true zero-deps.

**To run `screenshots.mjs`:** point `PLAYWRIGHT_REQUIRE_PATH` at any local directory whose
`node_modules` already has `playwright` installed (this repo doesn't vendor one on purpose):

```bash
PLAYWRIGHT_REQUIRE_PATH=/path/to/some/other/project/with/playwright node verify/screenshots.mjs
```

If you don't have one handy: `npm install --no-save playwright && npx playwright install chromium`
in a scratch directory, then point there. This is verification tooling, evaluated the same way a
CI runner or a linter is — never a runtime dependency of the shipped dashboard.

## Running everything

```bash
cd /Users/Able/ops-dashboard
npm test                                    # 40 unit/integration tests
node verify/latency.mjs
node verify/burst.mjs
node verify/fault-injection.mjs
node verify/soak-snapshot.mjs --duration 600000   # full 10min; omit for a fast 90s smoke check
PLAYWRIGHT_REQUIRE_PATH=<path> node verify/screenshots.mjs
```

Each prints a PASS/FAIL line and exits 0/1 accordingly — safe to chain with `&&` or wire into a
CI step.

## Gate-evidence table

The full M0–M9 table with every cell linked to its script/artifact lives in `../CLOSE-OUT.md`.
Per-skill (`typography-verification`/`dataviz`/`impeccable`) findings live in `M8-skill-stack.md`.
