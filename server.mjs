#!/usr/bin/env node
// Ops Dashboard v3 — project-agnostic live SDLC/agent-activity monitor. Node ≥22 built-ins only,
// zero npm deps, no build step. Binds config.bind (default 127.0.0.1) only.
//
// v3: watches MULTIPLE projects simultaneously (config.projects[], see project-manager.mjs) —
// there is no longer a single "active" project to switch between; every enabled project is
// watched at once and the client sees a unified, project-tagged feed + per-project lanes.
//
// Usage: node server.mjs [repoPath]   (repoPath, if given and not already configured, is added
//                                      and enabled on boot — convenience for `node server.mjs .`)
//
// Routes:
//   GET  /                        the dashboard UI
//   GET  /api/state                unified snapshot: every configured project's board + narrative
//   GET  /api/projects              configured projects + auto-discovered suggestions
//   POST /api/projects              add a project { repoPath, name? } -> armed live, no restart
//   PATCH /api/projects/:key         { enabled?, name? } -> live enable/disable/rename
//   DELETE /api/projects/:key        remove a project -> watcher torn down live
//   GET  /api/settings               current config (dashToken masked)
//   PATCH /api/settings              partial config update; applies live where possible, flags
//                                    restartRequired for port/bind/dashToken
//   GET  /events                     SSE: `state`, `feed` (project-tagged), `feed_batch`, `config`
//   POST /api/control/:key           append a control REQUEST for one project (see lib/control.mjs)
//   POST /ingest                     v3.2 hub mode: collector.mjs posts events/snapshots/heartbeats
//   GET  /api/collectors             v3.2 hub mode: registered collectors + offline status
//   GET  /api/git-metrics            v3.3.2: git subprocess governor counters (see lib/git-runner.mjs)
//   GET  /healthz                    v3.2 unauthenticated liveness probe (Docker HEALTHCHECK target)
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { loadConfig, saveConfig, validatePatch, restartRequiredFor, RESTART_REQUIRED_KEYS } from "./lib/config.mjs";
import { setExtraPatterns, sanitizeAndTruncate } from "./lib/sanitize.mjs";
import { appendControlRequest } from "./lib/control.mjs";
import { createProjectManager, entryFromRepoPath, stalledFrom } from "./lib/project-manager.mjs";
import { suggestProjects } from "./lib/project-discovery.mjs";
import { eventKindsPayload } from "./lib/event-kinds.mjs";
import { createHub } from "./lib/hub.mjs";
import { buildNarrative } from "./lib/narrative.mjs";
import { watchMode } from "./lib/watch-compat.mjs";
import { getGitRunnerCounters, getGitRunnerSettings } from "./lib/git-runner.mjs";
import { getGitStatusCacheSize, getGitStatusCacheCounters } from "./lib/git-status.mjs";

const PUBLIC_DIR = path.join(import.meta.dirname, "public");
const cliRepoPath = process.argv[2] || null;

let { config, warning: configWarning } = loadConfig();
// DASH_TOKEN/BIND env vars (Docker/production deployments) override config.json — lets a
// container be given auth + a container-reachable bind address without writing into the mounted
// config file. config.json still wins when these are unset, so local/dev use is unaffected.
if (process.env.DASH_TOKEN) config.dashToken = process.env.DASH_TOKEN;
if (process.env.COLLECTOR_TOKEN) config.collectorToken = process.env.COLLECTOR_TOKEN;
if (process.env.BIND) config.bind = process.env.BIND;
setExtraPatterns(config.secretStripPatterns);

const sseClients = new Set();
function broadcast(eventName, payload) {
  if (sseClients.size === 0) return;
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

const projectManager = createProjectManager((taggedEvent) => {
  broadcast("feed", taggedEvent);
  pushBoardStateSoon(); // v3.3 — see pushBoardStateSoon()'s doc comment below
});

// v3.2 hub mode — accepts events/snapshots/heartbeats POSTed by remote collector.mjs processes
// (see collector.mjs's header for the why). Local watching (projectManager above) is completely
// unchanged and unaware this exists; hub state is merged in ONLY at the read side (buildFullState
// below), so a deployment with zero collectors registered behaves byte-identically to pure-local
// v3.1 — auto mode selection, no separate "hub mode" flag to set.
// OPS_DASH_COLLECTOR_OFFLINE_MS lets a verification harness shrink the offline-detection window
// (default 45s — three missed 15s heartbeats) so a test doesn't need to sleep 45+ seconds to prove
// the mechanism works, same env-override pattern DASH_TOKEN/BIND already use above.
const hubOpts = {
  onFeedEvent: (taggedEvent) => {
    broadcast("feed", taggedEvent);
    pushBoardStateSoon();
  },
};
if (process.env.OPS_DASH_COLLECTOR_OFFLINE_MS) hubOpts.offlineThresholdMs = Number(process.env.OPS_DASH_COLLECTOR_OFFLINE_MS);
const hub = createHub(hubOpts);

/** The unified snapshot the client actually receives: local (projectManager) projects PLUS
 * whatever remote projects collectors have registered, narrative/stalled recomputed over the
 * combined set so a remote agent needing attention shows up in the SAME strip a local one would.
 * Falls back to the cheap local-only path (no merge work) when no collector has ever registered —
 * the common case for a pure-local deployment. v3.3.1 — ASYNC (cascades from
 * project-manager.mjs's buildUnifiedState, itself cascading from git-status.mjs's
 * parallelization — see that file's header for the full why/measurement). */
// The most recent full snapshot, kept so a CONNECTING CLIENT GETS PIXELS IMMEDIATELY instead of
// staring at "Loading live state…" while five repositories are walked. Found by rendering the real
// page in a real browser after the idle-skip landed: with nothing recomputing in the background, a
// fresh tab paid the whole cold scan (~6s on this deployment) before its first frame. The fix is
// not to go back to burning CPU while nobody is watching — it is to serve last-known-good at once
// and let the refresh it triggers push the fresh frame a moment later.
let lastFullState = null;

async function buildFullState() {
  const state = await buildFullStateUncached();
  lastFullState = state;
  return state;
}

async function buildFullStateUncached() {
  const local = await projectManager.buildUnifiedState(config);
  const remote = hub.getRemoteProjectsState();
  if (remote.length === 0) return { ...local, watchMode: watchMode() };
  const projects = [...local.projects, ...remote];
  const enabledWithBoard = projects.filter((p) => p.enabled && p.board);
  return {
    generatedAt: new Date().toISOString(),
    projects,
    narrative: buildNarrative(enabledWithBoard),
    stalled: stalledFrom(enabledWithBoard),
    watchMode: watchMode(),
  };
}

// CLI convenience: `node server.mjs /some/repo` adds+enables it if not already configured.
if (cliRepoPath && fs.existsSync(cliRepoPath)) {
  const entry = entryFromRepoPath(cliRepoPath);
  if (!config.projects.some((p) => p.key === entry.key)) {
    config = { ...config, projects: [...config.projects, entry] };
    saveConfig(config);
  }
}
projectManager.reconcile(config);

// v3.3.2 — REFRESH COALESCING (the storm fix's server half; lib/git-runner.mjs's header has the
// full incident). The 150ms debounce below only guarded the WINDOW BEFORE a push starts: once the
// timer fired, pushBoardStateNow() ran un-awaited, so the very next feed event could schedule
// another push 150ms later while the first was still walking four repositories. Under a normal
// agent-activity burst that stacked N overlapping full-state rebuilds, each fanning out to every
// project and every branch — the multiplier that turned a handful of git calls into a permanent
// 20-46 process storm. Now at most ONE rebuild is ever in flight; anything that arrives during it
// sets a single trailing flag and is served by exactly one follow-up rebuild afterwards, so no
// event is ever dropped and no event ever adds a parallel scan.
let boardPushInFlight = false;
let boardPushRequestedDuringFlight = false;

async function pushBoardStateNow() {
  // NOBODY IS LISTENING -> DO NOT DO THE WORK. broadcast() already no-ops with zero SSE clients,
  // but that check came AFTER buildFullState() had walked every repository, so an idle dashboard
  // with no browser open still paid the full cost every 5s forever. Measured on the live
  // deployment before this line existed: 663 git subprocesses per MINUTE and 28.5% CPU on a
  // machine nobody was looking at. The state is never stale as a result — /api/state computes on
  // demand, and /events sends a fresh full snapshot the instant a client connects.
  if (sseClients.size === 0) return;
  if (boardPushInFlight) {
    boardPushRequestedDuringFlight = true;
    return;
  }
  boardPushInFlight = true;
  try {
    broadcast("state", await buildFullState());
  } catch (err) {
    broadcast("state", { error: String(err && err.message ? err.message : err) });
  } finally {
    boardPushInFlight = false;
    if (boardPushRequestedDuringFlight) {
      boardPushRequestedDuringFlight = false;
      pushBoardStateSoon(); // trailing edge — one more rebuild, debounced, never a parallel one
    }
  }
}

// v3.3 owner critique ("Kanban... push-driven updates, cards change the moment state changes, not
// 5s poll"): before this, EVERY state change — a card's owner going active, a column reassignment,
// a test-run row landing — waited for the next scheduleBoardPush() tick (config.feed.refreshMs,
// default 5000ms) to reach the browser, even though the underlying watcher already knew about it
// the instant it happened (that's exactly what broadcast("feed", ...) above already pushes
// sub-second). This closes that gap: any feed event (from a local watcher OR a hub-ingested
// collector) now also triggers a full board-state recompute+push, DEBOUNCED so a burst of several
// events in the same second (e.g. 5 tool calls in a row) coalesces into ONE push rather than
// flooding every connected browser tab with 5 near-identical state frames. scheduleBoardPush()
// below keeps running as a BACKSTOP — it's still needed for state that changes on the CLOCK alone
// with no discrete event to hang a push off of (an agent crossing the possibly_stuck quietMs
// threshold while genuinely idle, a control-request's honored-status flip, an unpushed-commit's
// age crossing the amber line) — but it's no longer the PRIMARY path for the common case.
// v3.3.1 — shrunk from 400ms to 150ms now that buildFullState() itself is cheap (~40-70ms,
// parallelized — was 685-1825ms). 400ms was originally sized partly to limit how often the THEN-
// expensive rebuild ran; that reason no longer applies. 150ms matches feed.debounceMs (the
// underlying file-watcher's own coalescing window), so this doesn't introduce burstiness beyond
// what the watcher itself already produces — still coalesces a real burst (several tool calls in
// the same fraction of a second) into one push, just with a tighter window.
let pendingBoardPush = null;
const BOARD_PUSH_DEBOUNCE_MS = 150;
function pushBoardStateSoon() {
  if (pendingBoardPush) return;
  pendingBoardPush = setTimeout(() => {
    pendingBoardPush = null;
    pushBoardStateNow();
  }, BOARD_PUSH_DEBOUNCE_MS);
}

// One warm-up scan a couple of seconds after boot, so the first browser to connect also gets an
// instant frame. Deliberately ONE scan, deferred and unref'd — it does not make an idle server
// busy, it just means the remembered snapshot is never empty.
setTimeout(() => {
  buildFullState().catch(() => {});
}, 2000).unref();

function scheduleBoardPush() {
  setTimeout(() => {
    pushBoardStateNow();
    scheduleBoardPush(); // re-reads config.feed.refreshMs each tick — live-adjustable
  }, config.feed.refreshMs);
}
scheduleBoardPush();

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function maskedConfig() {
  return { ...config, dashToken: config.dashToken ? "********" : null, collectorToken: config.collectorToken ? "********" : null };
}

function authorized(req, url) {
  if (!config.dashToken) return true;
  const header = req.headers.authorization;
  if (header === `Bearer ${config.dashToken}`) return true;
  return url.searchParams.get("token") === config.dashToken; // EventSource can't set headers
}

// v3.2 — /ingest's OWN auth check, deliberately separate from authorized() above (security
// acceptance item #5). When config.collectorToken is set, it is the ONLY credential /ingest
// accepts — config.dashToken (browser/control auth) no longer works there, so a leaked collector
// config (which only ever needs the collector token) can't be replayed against the dashboard's
// read/control routes, and a leaked dashToken can't be replayed against /ingest. When
// collectorToken is unset (default — a v3.1-style single-token setup that hasn't opted into the
// split), /ingest falls back to sharing dashToken, same as every other route — a documented,
// weaker default, not a silent gap. No query-param fallback here (unlike authorized()'s
// EventSource accommodation) — collector.mjs always sets a real Authorization header.
function ingestAuthorized(req) {
  const token = config.collectorToken || config.dashToken;
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

async function readJsonBody(req, res) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return undefined;
  }
}

async function handleAddProject(req, res) {
  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  if (!body.repoPath || typeof body.repoPath !== "string") return sendJson(res, 400, { error: "repoPath is required" });
  if (!fs.existsSync(body.repoPath)) return sendJson(res, 400, { error: `repoPath does not exist: ${body.repoPath}` });
  const entry = entryFromRepoPath(body.repoPath, body.name);
  const existingIdx = config.projects.findIndex((p) => p.key === entry.key);
  const projects = [...config.projects];
  if (existingIdx >= 0) projects[existingIdx] = { ...projects[existingIdx], enabled: true, name: body.name || projects[existingIdx].name };
  else projects.push(entry);
  config = { ...config, projects };
  saveConfig(config);
  projectManager.reconcile(config);
  broadcast("config", maskedConfig());
  sendJson(res, 201, { project: existingIdx >= 0 ? projects[existingIdx] : entry, state: await buildFullState() });
}

async function handlePatchProject(req, res, key) {
  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  const idx = config.projects.findIndex((p) => p.key === key);
  if (idx < 0) return sendJson(res, 404, { error: `no configured project with key "${key}"` });
  const projects = [...config.projects];
  const patch = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  projects[idx] = { ...projects[idx], ...patch };
  config = { ...config, projects };
  saveConfig(config);
  projectManager.reconcile(config);
  broadcast("config", maskedConfig());
  sendJson(res, 200, { project: projects[idx], state: await buildFullState() });
}

async function handleDeleteProject(res, key) {
  const idx = config.projects.findIndex((p) => p.key === key);
  if (idx < 0) return sendJson(res, 404, { error: `no configured project with key "${key}"` });
  const projects = config.projects.filter((p) => p.key !== key);
  config = { ...config, projects };
  saveConfig(config);
  projectManager.reconcile(config);
  broadcast("config", maskedConfig());
  sendJson(res, 200, { removed: key, state: await buildFullState() });
}

async function handleSettingsPatch(req, res) {
  const patch = await readJsonBody(req, res);
  if (patch === undefined) return;
  const { ok, errors } = validatePatch(patch);
  if (!ok) return sendJson(res, 400, { error: "invalid settings", details: errors });
  const restart = restartRequiredFor(patch);
  const prevConfig = config;
  config = { ...config, ...patch };
  for (const k of Object.keys(patch)) {
    if (typeof config[k] === "object" && config[k] !== null && !Array.isArray(config[k])) {
      config[k] = { ...prevConfig[k], ...patch[k] }; // shallow-merge nested objects (theme, feed, kanban)
    }
  }
  saveConfig(config);
  setExtraPatterns(config.secretStripPatterns);
  if (restart.length === 0) {
    if ("projects" in patch) projectManager.reconcile(config);
    else projectManager.restartAllWatchers(config); // debounce/watched-files/thresholds changed
    broadcast("config", maskedConfig());
  }
  sendJson(res, 200, { config: maskedConfig(), restartRequired: restart, restartRequiredKeys: RESTART_REQUIRED_KEYS });
}

const INGEST_TYPES = new Set(["events", "snapshot", "heartbeat"]);

/** POST /ingest — the collector/hub wire protocol. Body: `{ type: "events"|"snapshot"|"heartbeat",
 * collectorId, ts, ... }`, see lib/hub.mjs's per-type doc comments for the full shape of each.
 * Deliberately a single endpoint + `type` discriminator rather than three routes — matches
 * collector.mjs's own single hub-client.postJson(hub, "/ingest", ...) call shape, one thing to
 * point a firewall/reverse-proxy rule at. */
async function handleIngest(req, res) {
  const body = await readJsonBody(req, res);
  if (body === undefined) return;
  if (!INGEST_TYPES.has(body.type)) return sendJson(res, 400, { error: `type must be one of ${[...INGEST_TYPES].join(", ")}` });
  try {
    let result;
    if (body.type === "heartbeat") result = hub.ingestHeartbeat(body);
    else if (body.type === "snapshot") result = hub.ingestSnapshot(body);
    else result = hub.ingestEvents(body);
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 400, { error: String(err && err.message ? err.message : err) });
  }
}

function serveIndex(res) {
  fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err, buf) => {
    if (err) return sendJson(res, 500, { error: "index.html missing" });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(buf);
  });
}

const STATIC_TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

// Native ES modules (no bundler) — app.js is the entry, everything under public/js/*.js is
// imported via relative `import` paths straight in the browser. Path is confined to PUBLIC_DIR.
function serveStatic(res, pathname) {
  const resolved = path.join(PUBLIC_DIR, pathname);
  const type = STATIC_TYPES[path.extname(resolved)];
  if (!type || !resolved.startsWith(PUBLIC_DIR)) return sendJson(res, 404, { error: "not found" });
  fs.readFile(resolved, (err, buf) => {
    if (err) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": type });
    res.end(buf);
  });
}

async function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 1500\n\n`); // client also does its own backoff reconnect on top of this (see app.js)
  try {
    // Instant first paint from the remembered snapshot when we have one; a real build only on the
    // very first connection after boot. Either way pushBoardStateSoon() below sends a fresh frame.
    res.write(`event: state\ndata: ${JSON.stringify(lastFullState || (await buildFullState()))}\n\n`);
  } catch (err) {
    res.write(`event: state\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
  }
  res.write(`event: config\ndata: ${JSON.stringify(maskedConfig())}\n\n`);
  if (configWarning) res.write(`event: warning\ndata: ${JSON.stringify({ message: configWarning })}\n\n`);
  // Merge local + hub-ingested replay history for a freshly-opened tab, oldest-first by ts —
  // identical ordering contract project-manager.getRecentFeed() already documents for local-only.
  const mergedFeed = [...projectManager.getRecentFeed(200), ...hub.getRecentFeed(200)].sort((a, b) => (a.ts || "").localeCompare(b.ts || "")).slice(-200);
  res.write(`event: feed_batch\ndata: ${JSON.stringify(mergedFeed)}\n\n`);
  sseClients.add(res);
  // Now that a client exists, pushBoardStateSoon() will actually do work (it no-ops with zero
  // clients) — this is what replaces the possibly-stale frame just sent with a current one.
  pushBoardStateSoon();
  req.on("close", () => sseClients.delete(res));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","projects","-Users-x-y"]
  try {
    // v3.2 container-hardening follow-up — a diagnosed real bug: the Dockerfile's HEALTHCHECK hit
    // /api/state, which is gated by authorized() same as every business route. Any deployment with
    // DASH_TOKEN set (which docker-compose.hub.yml REQUIRES) made an unauthenticated in-container
    // `wget` get a 401 — and wget treats a non-2xx as a failure, so `docker inspect` reported
    // "unhealthy" even though the server was perfectly alive and answering. Liveness must never
    // require the same credential as data access (the standard Kubernetes /healthz pattern) — this
    // route is deliberately BEFORE the auth gate below, on purpose, and returns nothing sensitive.
    if (req.method === "GET" && url.pathname === "/healthz") return sendJson(res, 200, { status: "ok", uptimeSec: Math.round(process.uptime()) });

    // v3.3 — REAL BUG found via live Playwright browser verification, not just code review (this
    // project's own browser-UX-validation rule earning its keep again): with dashToken set, the
    // page loaded (GET / carries ?token=... from the URL, checked by authorized() below) but
    // rendered COMPLETELY UNSTYLED with app.js never executing — <link href="/styles.css"> and
    // <script src="/app.js"> are the BROWSER's own follow-up requests to those exact relative
    // paths, and a browser never propagates the ORIGINAL navigation's query string onto a
    // sub-resource request it discovers in the parsed HTML. Both requests hit authorized() with no
    // Bearer header and no ?token=, got a real 401, and the dashboard was silently, completely
    // broken for ANY deployment with DASH_TOKEN set — exactly the deployment shape this project's
    // own README recommends for the v3.2 remote hub. Fix: these two static assets carry no
    // sensitive data (no live state, no secrets — that's /api/*, /events, /ingest, gated below,
    // same as ever) so they're exempted from the auth gate, the same class as /healthz just above
    // (liveness/shell-loading must never require the same credential as data access).
    if (req.method === "GET" && (url.pathname === "/app.js" || url.pathname === "/styles.css")) return serveStatic(res, url.pathname.slice(1));

    // /ingest uses its OWN auth check (ingestAuthorized — collectorToken-first, see its doc
    // comment) instead of the browser/control authorized() check. Still runs FIRST, before any
    // route dispatch or body read (security acceptance item #1 — an unauthenticated POST must not
    // burn CPU parsing a payload before being rejected).
    const isIngestPost = req.method === "POST" && url.pathname === "/ingest";
    if (isIngestPost ? !ingestAuthorized(req) : !authorized(req, url)) return sendJson(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/") return serveIndex(res);
    // (app.js/styles.css are handled above, BEFORE the auth gate — see that block's comment)

    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, await buildFullState());

    // v3.2 hub mode — collector.mjs (running natively on a machine with real filesystem access,
    // possibly a different machine than this hub) POSTs here. Auth already ran above via
    // ingestAuthorized() — COLLECTOR_TOKEN if configured (recommended: keep it separate from
    // DASH_TOKEN so a leaked collector config can't reach the dashboard's read/control routes),
    // else falls back to sharing DASH_TOKEN.
    if (req.method === "POST" && url.pathname === "/ingest") return await handleIngest(req, res);
    if (req.method === "GET" && url.pathname === "/api/collectors") return sendJson(res, 200, { collectors: hub.listCollectors() });

    if (req.method === "GET" && url.pathname === "/api/projects") {
      const configuredKeys = new Set(config.projects.map((p) => p.key));
      return sendJson(res, 200, {
        configured: config.projects,
        suggestions: suggestProjects(configuredKeys, config.suggestLimit),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/projects") return await handleAddProject(req, res);
    if (req.method === "PATCH" && parts[0] === "api" && parts[1] === "projects" && parts[2]) return await handlePatchProject(req, res, decodeURIComponent(parts[2]));
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "projects" && parts[2]) return await handleDeleteProject(res, decodeURIComponent(parts[2]));

    if (req.method === "GET" && url.pathname === "/api/settings") return sendJson(res, 200, maskedConfig());
    if (req.method === "PATCH" && url.pathname === "/api/settings") return await handleSettingsPatch(req, res);

    if (req.method === "GET" && url.pathname === "/events") return await handleSse(req, res);

    // v3.1 Stage 4 — the event-vocabulary SSOT served to the client (icon/color/label/redFlag per
    // kind), so app.js never hand-duplicates a second copy of what lib/event-kinds.mjs already
    // defines (this project's own no-drift/SSOT discipline). Static, not per-request-computed —
    // safe for the client to fetch once at startup rather than on every /api/state poll.
    if (req.method === "GET" && url.pathname === "/api/event-kinds") return sendJson(res, 200, eventKindsPayload());

    // v3.3.2 — git subprocess governor metrics (lib/git-runner.mjs). Pull-only and dirt cheap (a
    // shallow copy of ~10 integers); this is the observability that was missing when the process
    // storm went unnoticed. `peakActive` is the one number that matters: it must never exceed
    // `settings.concurrency`, and if it does, the semaphore is broken and the storm can return.
    if (req.method === "GET" && url.pathname === "/api/git-metrics") {
      return sendJson(res, 200, { counters: getGitRunnerCounters(), cache: getGitStatusCacheCounters(), settings: getGitRunnerSettings(), snapshotCacheEntries: getGitStatusCacheSize() });
    }

    if (req.method === "POST" && parts[0] === "api" && parts[1] === "control" && parts[2]) {
      if (!config.controlContractEnabled) return sendJson(res, 403, { error: "control contract disabled in settings" });
      const key = decodeURIComponent(parts[2]);
      if (!config.projects.some((p) => p.key === key)) return sendJson(res, 404, { error: `no configured project with key "${key}"` });
      const body = await readJsonBody(req, res);
      if (body === undefined) return;
      try {
        const entry = appendControlRequest(key, body);
        // v3.1 Stage 4 — a control request is now a first-class feed event (kind "control"), per
        // verify/V3.1-SPEC.md §3's expanded vocabulary; previously control.json requests were only
        // ever visible via polling (board.control), invisible in the live feed entirely. Routed
        // through injectFeedEvent so it gets the SAME red-flag/link/ring treatment as every
        // watcher-sourced event (SSOT in lib/feed.mjs, not a second ad hoc broadcast shape here).
        projectManager.injectFeedEvent(key, {
          ts: entry.ts,
          agent: entry.agent || "control",
          model: null,
          kind: "control",
          summary: sanitizeAndTruncate(`${entry.action}${entry.note ? `: ${entry.note}` : ""}`),
        });
        return sendJson(res, 201, entry);
      } catch (err) {
        return sendJson(res, 400, { error: String(err && err.message ? err.message : err) });
      }
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(config.port, config.bind, () => {
  const names = config.projects.filter((p) => p.enabled).map((p) => p.name).join(", ") || "(none configured — add one in Settings)";
  console.log(`Ops Dashboard v3 — http://${config.bind}:${config.port} — watching: ${names}`);
});

// v3.1 container-hardening — graceful shutdown. Docker sends SIGTERM on `docker stop`/`compose
// down` (and on a restart) with a default 10s grace period before SIGKILL; a bare `http.Server`
// with open SSE connections (the "keep-alive, never closes" streams every browser tab holds open)
// never emits its own 'close' event on its own — server.close() alone would hang until Docker's
// grace period expires and SIGKILLs the process, or the connections happen to already be dead.
// Explicit here: end every open SSE response first (lets the client's own reconnect logic notice
// and back off cleanly rather than seeing a hard socket reset), THEN stop every project watcher
// (project-manager.stopAll() — closes every fs.watch handle so the process can actually exit
// instead of being held open by them), THEN close the HTTP server itself. No pending async
// writes to flush: every control.json / config.json write in this codebase already uses
// fs.writeFileSync (control.mjs, config.mjs) — synchronous by construction, never a dangling
// promise a shutdown could race.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return; // a second SIGTERM/SIGINT while already shutting down is a no-op, not a crash
  shuttingDown = true;
  console.log(`${signal} received — shutting down gracefully`);
  for (const res of sseClients) {
    try {
      res.end();
    } catch {
      // client socket may already be half-closed — nothing to do
    }
  }
  sseClients.clear();
  projectManager.stopAll();
  server.close(() => {
    console.log("shutdown complete");
    process.exit(0);
  });
  // Belt-and-suspenders: if server.close()'s callback never fires (a stuck socket Node's own
  // keep-alive didn't release), force exit rather than hang past Docker's SIGKILL grace period —
  // a forced exit here is strictly better than being SIGKILLed mid-write.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
