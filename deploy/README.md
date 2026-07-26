# Deploy — persistent auto-start (macOS launchd)

The dashboard runs as a launchd user-agent so it survives reboots, logout, and sleep,
and auto-restarts if it ever crashes (`KeepAlive`).

**Canonical source of truth:** `deploy/com.opsdash.server.plist` (tracked in this repo).
macOS requires launchd agents to live in `~/Library/LaunchAgents/`, so installing = copying
this file there. The repo copy is authoritative; re-copy after any edit.

## Install / update
```bash
cp deploy/com.opsdash.server.plist ~/Library/LaunchAgents/com.opsdash.server.plist
launchctl bootout   gui/$(id -u)/com.opsdash.server 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.opsdash.server.plist
```
Then open http://127.0.0.1:4650.

## Stop / uninstall
```bash
launchctl bootout gui/$(id -u)/com.opsdash.server
rm ~/Library/LaunchAgents/com.opsdash.server.plist
```

## Which projects it watches
Edit from the dashboard **Settings** tab (persists to `config.json`, gitignored runtime state).
Keep the enabled set light — watching several very large repos at once can block the initial
render. `config.example.json` is the tracked seed a fresh clone starts from.

## Notes
- `ProcessType=Interactive` (NOT Background — Background throttles I/O and makes the HTTP server unresponsive).
- Everything the dashboard writes stays inside this repo (`data/`, `server.log`, `config.json` — all gitignored).
