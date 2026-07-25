// Ops Dashboard v3 — client. No build step, no framework: native DOM + SSE. Renders whatever
// server.mjs's /api/state (and the `state`/`feed`/`config`/`warning` SSE events) send. Every
// renderer degrades to an `.empty` placeholder rather than throwing on missing/partial data.
//
// v3 shape change: the server has NO single "active project" any more — /api/state and the SSE
// `state` event carry `{ projects: [{key,name,repoPath,enabled,board}], narrative, stalled }` for
// EVERY configured project at once. Per-project panels (Kanban/Tests/Git/Control) keep a local
// "which project" selection; cross-project panels (Overview/Lanes/Feed/Agents) render all of them.

const TOKEN = new URLSearchParams(location.search).get("token") || "";
const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

// Apply dark/light MODE synchronously, before any network round-trip — measured 954ms to appear
// when this waited on the SSE `config` event (loadProjectsAndSuggestions() -> connect() ->
// EventSource handshake -> first config push, all serialized). The mode itself is already known
// from localStorage (or the dark default) with zero I/O; only CUSTOM color overrides genuinely
// need server config, and applyTheme(state.config) re-applies those on top once it arrives (same
// mode, so no flash/flicker — just the accent/status hues refining a moment later).
document.documentElement.setAttribute("data-theme", localStorage.getItem("opsDashTheme") || "dark");

const state = {
  tab: "overview",
  unified: { projects: [], narrative: "", stalled: [] },
  config: null,
  feed: [], // oldest -> newest, tagged {projectKey, projectName}, capped client-side to config.feed.bufferMax
  feedPaused: false,
  feedKindFilter: null, // null = show all kinds; Set<string> = show only these (v3.1 Stage 4 kind-filter row)
  eventKinds: {}, // v3.1 Stage 4: the event-vocabulary SSOT, fetched once from /api/event-kinds (lib/event-kinds.mjs)
  selected: { routing: null, kanban: null, tests: null, git: null, control: null },
  suggestions: [],
  // v3.3 — global project-scope (owner ask: "pick a project -> EVERY tab tailors to it"). "" = All
  // projects (default, the pre-v3.3 behavior, unchanged). Persisted so a reload keeps the owner's
  // last choice instead of silently resetting to "All" underneath them.
  scope: localStorage.getItem("opsDashScope") || "",
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- FLIP reorder transition (v3.3 owner directive: "an agent going live reorders
// immediately, with a smooth, meaning-encoding reposition transition, reduced-motion honored") ----------
// Classic FIRST/LAST/INVERT/PLAY: capture each element's position BEFORE a re-sort/re-render,
// then after the new (already-sorted) DOM lands, compute how far each element actually moved and
// animate FROM there back to zero — cheaper and simpler than a virtual-DOM diff/keyed-list library
// for this app's zero-dependency constraint, and the standard technique for "list reordered, make
// it visibly slide" without a framework.
const REDUCED_MOTION = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function flipCapture(container, selector, keyAttr = "flipKey") {
  const map = new Map();
  if (!container) return map;
  $$(selector, container).forEach((el) => {
    const key = el.dataset[keyAttr];
    if (key) map.set(key, el.getBoundingClientRect());
  });
  return map;
}
function flipPlay(container, selector, beforeRects, keyAttr = "flipKey") {
  if (!container || REDUCED_MOTION() || beforeRects.size === 0) return; // reduced-motion: new order is already correct, just no slide
  $$(selector, container).forEach((el) => {
    const key = el.dataset[keyAttr];
    const before = key && beforeRects.get(key);
    if (!before) return; // a newly-appeared row has nothing to animate FROM — it just appears, correctly
    const after = el.getBoundingClientRect();
    // Both axes — a <tr>/single-column list only ever moves vertically, but a grid (lanes-board is
    // multi-column) can reorder diagonally; computing both costs nothing when the other is 0.
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = "transform 320ms cubic-bezier(0.2,0,0,1)";
      el.style.transform = "";
    });
  });
}

function humanAge(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// ---------- Theme ----------
function applyTheme(config) {
  if (!config || !config.theme) return;
  const t = config.theme;
  const stored = localStorage.getItem("opsDashTheme");
  const mode = stored || t.defaultMode || "dark";
  const surface = mode === "light" ? t.surfaceLight : t.surfaceDark;
  const ink = mode === "light" ? t.inkLight : t.inkDark;
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);
  if (surface) for (const k of ["s0", "s1", "s2", "s3"]) if (surface[k]) root.style.setProperty(`--${k}`, surface[k]);
  if (ink) for (const k of ["i0", "i1", "i2", "i3"]) if (ink[k]) root.style.setProperty(`--${k}`, ink[k]);
  if (t.accent) root.style.setProperty("--accent", t.accent);
  if (t.accentHover) root.style.setProperty("--accent-hover", t.accentHover);
  if (t.accentPressed) root.style.setProperty("--accent-pressed", t.accentPressed);
  if (t.status) {
    for (const k of ["pass", "fail", "pending", "building", "verifying", "stalled", "stopped", "orphaned"]) {
      if (t.status[k]) root.style.setProperty(`--${k}`, t.status[k]);
    }
    // Text-safe variants (WCAG AA 4.5:1) — mode-aware; see config.mjs DEFAULTS.theme.status comment.
    const suffix = mode === "light" ? "Light" : "Dark";
    root.style.setProperty("--pass-text", t.status[`passText${suffix}`] || t.status.pass);
    root.style.setProperty("--fail-text", t.status[`failText${suffix}`] || t.status.fail);
    root.style.setProperty("--stalled-text", t.status[`failText${suffix}`] || t.status.fail);
    root.style.setProperty("--verifying-text", t.status[`verifyingText${suffix}`] || t.status.verifying);
    // v3.3.1 FIX (real axe-core finding, not guessed): these two used to set the raw hue
    // directly with NO suffix-based light/dark lookup at all — the fallback pattern every OTHER
    // status color already uses. `pending`'s raw hue (#B08A3E, shared by `building`) measures
    // 2.51:1 against light-mode surfaces — a genuine WCAG AA failure that had simply never been
    // exercised by a small-text component in light mode until v3.3's Tests/Control tabs.
    root.style.setProperty("--building-text", t.status[`buildingText${suffix}`] || t.status.building);
    root.style.setProperty("--pending-text", t.status[`pendingText${suffix}`] || t.status.pending);
    root.style.setProperty("--stopped-text", t.status[`stoppedText${suffix}`] || t.status.stopped);
    root.style.setProperty("--orphaned-text", t.status[`orphanedText${suffix}`] || t.status.orphaned);
  }
  $("#themeToggle").textContent = mode === "light" ? "◑" : "◐";
}

$("#themeToggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "light" ? "dark" : "light";
  localStorage.setItem("opsDashTheme", next);
  applyTheme(state.config);
});

// ---------- Tabs ----------
function switchTab(name) {
  state.tab = name;
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${name}`));
  renderActiveTab();
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

// ---------- Clock ----------
setInterval(() => {
  $("#clock").textContent = new Date().toLocaleTimeString([], { hour12: false });
}, 1000);

// ---------- Glossary + panel-explainer popover (one shared mechanism) ----------
const GLOSSARY = {
  agent: "An AI worker spawned to do one job (e.g. “build-phase9c”). Several can run at once, each with its own transcript file.",
  orchestrator: "The main AI session that plans work and spawns agents to carry it out — the “manager”.",
  tag: "A git bookmark marking one commit as a milestone (e.g. a finished phase).",
  gate: "An automated check — build, tests, lint — that must pass before work counts as done.",
  sse: "Server-Sent Events — a live one-way connection that pushes updates to this page the instant something happens, no refresh needed.",
  transcript: "The full, timestamped log of everything an agent said and did. This whole dashboard is read straight from these files — nothing is self-reported.",
  kanban: "A board that sorts work into columns (Queued, In Progress, …) so progress is visible at a glance.",
};

const popover = $("#infoPopover");
let popoverOwner = null;
function showPopover(anchor, text) {
  popover.textContent = text;
  popover.classList.add("show");
  const r = anchor.getBoundingClientRect();
  const top = r.bottom + window.scrollY + 6;
  let left = r.left + window.scrollX;
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
  // Keep it on-screen: clamp after layout so its measured width is known.
  requestAnimationFrame(() => {
    const pw = popover.offsetWidth;
    if (left + pw > window.scrollX + document.documentElement.clientWidth - 12) {
      left = window.scrollX + document.documentElement.clientWidth - pw - 12;
      popover.style.left = `${Math.max(8, left)}px`;
    }
  });
  popoverOwner = anchor;
}
function hidePopover() {
  popover.classList.remove("show");
  popoverOwner = null;
}
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".info-dot, .glossary-term");
  if (btn) {
    ev.stopPropagation();
    if (popoverOwner === btn) return hidePopover();
    const text = btn.dataset.info || GLOSSARY[btn.dataset.term] || "";
    showPopover(btn, text);
    return;
  }
  if (!ev.target.closest("#infoPopover")) hidePopover();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") hidePopover();
});

// ---------- Generic markdown-table renderer ({heading, headers, rows}) ----------
function renderTable(table, { compact = false, emptyText = "No data yet." } = {}) {
  if (!table || !table.rows || table.rows.length === 0) return `<p class="empty">${esc(emptyText)}</p>`;
  const thead = `<tr>${table.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const tbody = table.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderCell(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table-scroll${compact ? " table-scroll--compact" : ""}" tabindex="0" aria-label="${esc(table.heading || "Data table")}, scrollable"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
}

function renderCell(cell) {
  const text = String(cell ?? "");
  return esc(text).replace(/`([^`]+)`/g, '<span class="mono">$1</span>');
}

function statusClassFor(text) {
  // Preserves the original pass-before-fail priority (a row mentioning "failed" inside otherwise-
  // passing prose still reads as pass) and ADDS a distinct WARN tier for ⚠️/UNVERIFIED/discrepancy
  // rows that previously fell through silently to the generic "pending" default — indistinguishable
  // from an in-progress run. Real example this fixes: "⚠️ 0 run / 27 skipped — no
  // TEST_DATABASE_URL, UNVERIFIED" now renders as its own amber-warn chip, not a plain pending dot.
  if (/✅|pass|done|green/i.test(text)) return "pass";
  if (/🔴|fail|red|error/i.test(text)) return "fail";
  if (/⚠️|unverified|discrepancy/i.test(text)) return "warn";
  if (/🟡|pending|progress|blocked|⏸️/i.test(text)) return "pending";
  return "";
}

// ---------- Cross-project helpers ----------
function activeProjects() {
  return (state.unified.projects || []).filter((p) => p.board);
}
// v3.3 global project-scope: the SAME "which projects are in view" question every cross-project
// panel (Overview/Lanes/Feed/Agents) needs answered, in ONE place — never a second hand-filtered
// copy per panel (structural-prevention.md Law 1). Per-project panels (Kanban/Tests/Git/Control)
// keep their own dropdown but that dropdown's OPTIONS and DEFAULT are also driven by scope (see
// populateProjectFilterOptions below), so picking a global scope tailors every tab consistently.
function scopedProjects() {
  const all = activeProjects();
  return state.scope ? all.filter((p) => p.key === state.scope) : all;
}
function scopedFeed() {
  return state.scope ? state.feed.filter((e) => e.projectKey === state.scope) : state.feed;
}
function allAgentsTagged() {
  const out = [];
  for (const p of scopedProjects()) {
    for (const a of p.board.agents || []) out.push({ ...a, projectKey: p.key, projectName: p.name });
  }
  return out;
}
function taggedCards() {
  const out = [];
  for (const p of scopedProjects()) {
    for (const c of (p.board.kanban && p.board.kanban.cards) || []) out.push({ ...c, projectName: p.name });
  }
  return out;
}
// v3.3 owner directive (verbatim: "live/active items must also be PRIORITIZED — sorted to the TOP
// of every list/board... the top of every view IS the live picture"): sort order changed from the
// original v3.1 "needs-attention-first" rationale (possibly_stuck/stopped led) to LIVE-FIRST —
// working/composing (genuinely active right now) lead every list, THEN the deliberate/expected
// non-live states (waiting on something, or paused by request), THEN the needs-attention tier
// (still grouped together, still visually loud/red — just no longer sorted ahead of live work),
// THEN done last. This is an explicit, repeated owner override of the prior design decision (kept
// documented here, not silently deleted, per this project's no-drift discipline) — the OLD
// rationale ("a stalled agent needs eyes first") is still true as a COLOR/URGENCY signal (stalled
// stays loud red), it's just no longer the SORT key.
function stateRank(s) {
  return { working: 0, composing: 0, waiting: 1, paused: 1, possibly_stuck: 2, stopped: 2, orphaned: 2, done: 3 }[s] ?? 1;
}
const STATE_DOT_CLASS = {
  working: "working", composing: "composing", waiting: "waiting", done: "done",
  stopped: "stopped", paused: "paused", possibly_stuck: "possibly-stuck", orphaned: "orphaned",
};
const STATE_LABEL = {
  working: "working", composing: "composing", waiting: "waiting", done: "done",
  stopped: "stopped", paused: "paused", possibly_stuck: "possibly stuck", orphaned: "presumed dead",
};
const NEEDS_ATTENTION_STATES = new Set(["possibly_stuck", "stopped", "orphaned"]);
const RESOLVED_STATES = new Set(["done", "paused"]); // collapse-eligible, like v3.0's "idle" bucket
const LIVE_STATES = new Set(["working", "composing"]);

// ---------- v3.3 owner directive: BIG, BRIGHT, DYNAMIC state chips ----------
// Verbatim: "'live'/'active'/'run' type indications shown big, bright, properly color coded,
// dynamic and clear." A shared component so every surface (agents table, kanban cards, lanes,
// collector sources) renders the SAME loudness hierarchy instead of N hand-tuned copies:
//   live (working/composing)  -> bright saturated green chip, PULSING (a real heartbeat — only
//                                 while genuinely active; working pulses harder, composing steady)
//   building/verifying (waiting/paused) -> amber/blue chip, steady (no pulse — not "happening
//                                 right now", just a normal non-urgent state)
//   stalled (possibly_stuck/stopped/orphaned) -> red chip, STEADY alarm (deliberately NOT pulsing
//                                 — a stalled agent isn't doing anything; a heartbeat there would
//                                 misleadingly suggest activity. Loud color, not motion, is the signal.)
//   done/idle -> small, dim, no chip at all (the CONTRAST is the design — inflating idle to match
//                                 live would make nothing read as loud)
// #22c55e/#052e16 is a NEW, deliberately more saturated pair than this app's existing muted
// --pass/--pass-text tokens (which read as a restrained hairline accent, not "unmissable") —
// verified 6.54:1 contrast (WCAG AA text needs 4.5:1). Every other tier reuses this app's existing,
// already-audited theme tokens (--pending/--verifying/--fail) rather than inventing new hues for
// them — one new, purposeful exception (LIVE), not a second accent system.
const STATE_CHIP_CONFIG = {
  working: { tier: "live", label: "WORKING", pulse: true },
  composing: { tier: "live", label: "LIVE", pulse: false },
  waiting: { tier: "verifying", label: "WAITING", pulse: false },
  paused: { tier: "building", label: "PAUSED", pulse: false },
  possibly_stuck: { tier: "stalled", label: "STUCK?", pulse: false },
  stopped: { tier: "stalled", label: "STOPPED", pulse: false },
  orphaned: { tier: "stalled", label: "DEAD?", pulse: false },
  done: { tier: "done", label: "done", pulse: false },
};
/** Renders the shared big/bright state chip. `compact` drops the label text (kanban card face,
 * where space is tight) but KEEPS the tier's color/size — the chip must still read loud even
 * without the word, per "properly color coded... clear." */
function stateChipHtml(state, { compact = false } = {}) {
  const cfg = STATE_CHIP_CONFIG[state] || { tier: "done", label: state || "unknown", pulse: false };
  const pulseClass = cfg.pulse ? " chip-pulse" : "";
  const label = compact ? "" : `<span class="state-chip-label">${esc(cfg.label)}</span>`;
  return `<span class="state-chip state-chip--${cfg.tier}${pulseClass}" title="${esc(cfg.label)}"><span class="state-chip-dot${pulseClass}"></span>${label}</span>`;
}

// ---------- Narrative strip ----------
function renderNarrative() {
  $("#narrativeText").textContent = state.unified.narrative || "Loading live state…";
  const strip = $("#narrativeStrip");
  strip.classList.toggle("has-stall", (state.unified.stalled || []).length > 0);
  const shown = scopedProjects();
  $("#projectCount").textContent = state.scope
    ? `1 of ${activeProjects().length} projects (scoped)`
    : `${shown.length} project${shown.length === 1 ? "" : "s"}`;
  // Tab badges must stay accurate regardless of which tab is active — they used to only update
  // inside renderLanesTab()/renderFeedTab(), so a tab never visited kept showing 0 even with real
  // activity (caught during screenshot review: "Live Feed 0" while agents were actively running).
  $("#lanesTabBadge").textContent = String(shown.length);
  $("#feedTabBadge").textContent = String(scopedFeed().length);
  renderFooter();
  renderGlobalScope();
}

// ---------- Global project-scope dropdown (v3.3) ----------
function renderGlobalScope() {
  const sel = $("#globalScope");
  const all = activeProjects();
  // If the previously-scoped project got disabled/removed mid-session, fall back to "All" rather
  // than silently filtering every tab down to zero projects with no visible explanation.
  if (state.scope && !all.some((p) => p.key === state.scope)) {
    state.scope = "";
    localStorage.setItem("opsDashScope", "");
  }
  const opts = all.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join("");
  sel.innerHTML = `<option value="">All projects</option>${opts}`;
  sel.value = state.scope;
  const chip = $("#scopeChip");
  if (state.scope) {
    const proj = all.find((p) => p.key === state.scope);
    chip.textContent = `scoped: ${proj ? proj.name : state.scope}`;
    chip.hidden = false;
  } else {
    chip.hidden = true;
  }
}
$("#globalScope").addEventListener("change", (e) => {
  state.scope = e.target.value;
  localStorage.setItem("opsDashScope", state.scope);
  // Every per-tab selector re-derives its own default from scopedProjects() the next time it
  // renders — clearing the remembered per-tab selection here (rather than leaving a stale key from
  // OUTSIDE the new scope) is what makes "every tab tailors to it" true immediately, not just on
  // the next manual tab switch.
  for (const k of Object.keys(state.selected)) state.selected[k] = state.scope || null;
  renderActiveTab();
});

// ---------- Footer: watchMode + collector-offline surfacing (v3.3 — this data has been live in
// /api/state since v3.2 but had no visual surface, per CLOSE-OUT-v3.2.md's gap #4) ----------
function renderFooter() {
  const wm = state.unified.watchMode;
  const wmEl = $("#footerWatchMode");
  if (wm) {
    const label = wm === "poll" ? "container mode: polling every 2s" : wm === "native" ? "native fs.watch (instant)" : String(wm);
    wmEl.textContent = label;
    wmEl.title = wm === "poll" ? "fs.watch isn't reliable in this container runtime — falling back to a 2s poll (still <3s end-to-end, just not sub-second)." : "";
    wmEl.hidden = false;
  } else {
    wmEl.hidden = true;
  }

  const offlineParts = [];
  for (const p of activeProjects()) {
    if (p.board && p.board.collectorOffline) {
      offlineParts.push(`${p.name} (collector offline ${humanAge(p.board.collectorOfflineMs)})`);
    }
  }
  const colEl = $("#footerCollectorStatus");
  if (offlineParts.length) {
    colEl.textContent = `⚠ ${offlineParts.join(" · ")}`;
    colEl.hidden = false;
  } else {
    colEl.hidden = true;
  }
}

// ---------- M0 north star: the DONE / DOING / PENDING triptych ----------
// Owner's own words: "who is doing what, what is done, what is pending, what is being done —
// INSTEAD OF looking at the ever-scrolling CLI." This is the single most important element on the
// page — it must be the FIRST thing rendered in the Overview panel, above the KPI band.
function renderTriptych() {
  const cards = taggedCards();
  const done = cards.filter((c) => c.column === "Done");
  const pending = cards.filter((c) => c.column === "Queued");
  const doing = cards.filter((c) => c.column !== "Done" && c.column !== "Queued");

  const row = (c, showWho) => {
    // "no agent claimed yet" (not "unassigned") — a real M2 comprehension-walkthrough finding
    // (verify/M2-comprehension-walkthrough.md): a first-time viewer reads the narrative strip
    // naming a live agent, then reads this card's "unassigned" and momentarily reads it as a
    // contradiction. This card is about ONE TASK having no agent's name on it, not about whether
    // any agent is active anywhere — the reworded copy says that directly instead of overloading
    // a word ("unassigned") that sounds like it's talking about the whole project.
    const who = showWho ? (c.activeAgents && c.activeAgents.length ? esc(c.activeAgents.join(", ")) : "no agent claimed yet") : "";
    const stalledFlag = c.stalled ? ` <span class="badge fail">stalled</span>` : "";
    const meta = showWho ? `${who} &middot; ${esc(c.projectName)}${stalledFlag}` : esc(c.projectName);
    return `<div class="triptych-row"><span class="triptych-title">${esc(c.title)}</span><span class="triptych-meta mono">${meta}</span></div>`;
  };

  const doingRows = doing.slice(0, 5).map((c) => row(c, true)).join("");
  const doneRows = done.slice(-4).reverse().map((c) => row(c, false)).join("");
  const pendingRows = pending.slice(0, 4).map((c) => row(c, false)).join("");
  const moreDoing = doing.length > 5 ? `<p class="triptych-more">+${doing.length - 5} more — see Kanban</p>` : "";
  const morePending = pending.length > 4 ? `<p class="triptych-more">+${pending.length - 4} more — see Kanban</p>` : "";
  const moreDone = done.length > 4 ? `<p class="triptych-more">+${done.length - 4} more — see Kanban</p>` : "";

  $("#triptych").innerHTML = `
    <div class="triptych-col triptych-pending">
      <div class="triptych-head"><span class="triptych-count">${pending.length}</span><span class="triptych-label">PENDING</span></div>
      <div class="triptych-body" tabindex="0" aria-label="Pending work, scrollable">${pendingRows || `<p class="empty">Queue is empty.</p>`}${morePending}</div>
    </div>
    <div class="triptych-col triptych-doing">
      <div class="triptych-head"><span class="triptych-count">${doing.length}</span><span class="triptych-label">DOING</span></div>
      <div class="triptych-body" tabindex="0" aria-label="Work in progress right now, scrollable">${doingRows || `<p class="empty">Nothing in progress right now.</p>`}${moreDoing}</div>
    </div>
    <div class="triptych-col triptych-done">
      <div class="triptych-head"><span class="triptych-count">${done.length}</span><span class="triptych-label">DONE</span></div>
      <div class="triptych-body" tabindex="0" aria-label="Recently shipped work, scrollable">${doneRows || `<p class="empty">Nothing shipped yet.</p>`}${moreDone}</div>
    </div>`;
}

// ---------- Overview ----------
function renderOverview() {
  renderTriptych();
  const projects = scopedProjects();
  const agents = allAgentsTagged();
  const activeAgents = agents.filter((a) => !RESOLVED_STATES.has(a.state)).length;
  const stalledAgents = agents.filter((a) => NEEDS_ATTENTION_STATES.has(a.state)).length;
  // Kanban done/total is now shown by the triptych above (DONE column count) — this KPI band
  // shouldn't restate it (single source of truth); replaced with git ahead-count, which isn't
  // shown anywhere else on the front screen.
  let unpushedCommits = 0;
  for (const p of projects) {
    const git = p.board.campaign && p.board.campaign.git;
    if (git && git.available) for (const ab of Object.values(git.aheadBehind || {})) unpushedCommits += ab.ahead || 0;
  }

  let lastResult = "";
  let lastResultTs = "";
  for (const p of projects) {
    const rows = (p.board.testRuns && p.board.testRuns.rows) || [];
    const headers = (p.board.testRuns && p.board.testRuns.headers) || [];
    const resultIdx = headers.findIndex((h) => /result|status/i.test(h));
    const dateIdx = headers.findIndex((h) => /date/i.test(h));
    if (resultIdx >= 0 && rows.length) {
      const row = rows[rows.length - 1];
      const ts = dateIdx >= 0 ? row[dateIdx] : "";
      if (ts >= lastResultTs) { lastResult = row[resultIdx]; lastResultTs = ts; }
    }
  }
  const pendingControl = projects.reduce((sum, p) => sum + ((p.board.control && p.board.control.pendingCount) || 0), 0);

  const tiles = [
    { label: "Active Agents", value: `${activeAgents}/${agents.length || 0}` },
    { label: "Needs Attention", value: String(stalledAgents), warn: stalledAgents > 0 },
    { label: "Unpushed Commits", value: String(unpushedCommits), warn: unpushedCommits > 0 },
    { label: "Last Test Run", value: lastResult ? statusBadge(lastResult) : "—", badge: true },
    { label: "Pending Control", value: String(pendingControl) },
  ];
  $("#kpiBand").innerHTML = tiles
    .map(
      (t) => `<div class="kpi-tile${t.warn ? " kpi-warn" : ""}"><div class="kpi-number${t.badge ? " kpi-badge" : ""}">${t.badge ? t.value : esc(t.value)}</div><div class="kpi-label">${esc(t.label)}</div></div>`
    )
    .join("");

  renderMiniFeed();
  renderActivityChart();
}

function statusBadge(text) {
  const cls = statusClassFor(text) || "";
  const short = text.length > 28 ? `${text.slice(0, 27)}…` : text;
  return `<span class="badge${cls ? ` ${cls}` : ""}">${esc(short)}</span>`;
}

function renderMiniFeed() {
  const items = scopedFeed().slice(-5).reverse();
  $("#feedListMini").innerHTML = items.length ? items.map((e) => feedRowHtml(e, true)).join("") : `<p class="empty">No activity yet.</p>`;
}

function renderActivityChart() {
  const wrap = $("#activityChart");
  const now = Date.now();
  const windowMs = 30 * 60 * 1000;
  const bucketMs = 60 * 1000;
  const buckets = new Array(30).fill(0);
  for (const e of scopedFeed()) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    const age = now - t;
    if (age < 0 || age > windowMs) continue;
    const idx = 29 - Math.floor(age / bucketMs);
    if (idx >= 0 && idx < 30) buckets[idx]++;
  }
  const max = Math.max(1, ...buckets);
  const w = 560, h = 120, padL = 28, padB = 18, padT = 10, padR = 10;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const x = (i) => padL + (i / 29) * plotW;
  const y = (v) => padT + plotH - (v / max) * plotH;
  const points = buckets.map((v, i) => [x(i), y(v)]);
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const last = points[points.length - 1];

  wrap.innerHTML = `
    <svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Activity events per minute, last 30 minutes">
      <line class="chart-axis" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" />
      <text x="${padL}" y="${h - 4}">-30m</text>
      <text x="${padL + plotW}" y="${h - 4}" text-anchor="end">now</text>
      <path class="chart-line" d="${linePath}" />
      <circle class="chart-dot" cx="${last[0]}" cy="${last[1]}" r="3" />
    </svg>
    <div class="chart-tooltip" id="chartTooltip"></div>`;

  const svg = $("svg", wrap);
  const tooltip = $("#chartTooltip", wrap);
  svg.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((ev.clientX - rect.left) / rect.width) * w;
    const idx = Math.max(0, Math.min(29, Math.round(((relX - padL) / plotW) * 29)));
    const [px, py] = points[idx];
    const minsAgo = 29 - idx;
    tooltip.textContent = `${buckets[idx]} event${buckets[idx] === 1 ? "" : "s"} · ${minsAgo === 0 ? "this minute" : `${minsAgo}m ago`}`;
    tooltip.style.left = `${(px / w) * 100}%`;
    tooltip.style.top = `${(py / h) * 100}%`;
    tooltip.classList.add("show");
  });
  svg.addEventListener("mouseleave", () => tooltip.classList.remove("show"));
}

// ---------- Project Lanes ----------
function laneCardHtml(p) {
  const agents = (p.board.agents || []).map((a) => ({ ...a, projectKey: p.key, projectName: p.name }));
  const counts = { working: 0, composing: 0, waiting: 0, possibly_stuck: 0, stopped: 0, orphaned: 0, done: 0, paused: 0 };
  for (const a of agents) counts[a.state] = (counts[a.state] || 0) + 1;
  // "top" = the most recently-touched AGENT WORK IN PROGRESS — resolved states (done/paused)
  // aren't "what's happening now," so they're excluded from this pick even though they're still
  // real agents. A NEEDS_ATTENTION agent (possibly_stuck/stopped/orphaned) IS eligible — that's
  // exactly the kind of thing a lane card should surface prominently.
  const top = agents.filter((a) => !RESOLVED_STATES.has(a.state)).sort((a, b) => a.quietMs - b.quietMs)[0];
  const git = p.board.campaign && p.board.campaign.git;
  const milestone = git && git.tags && git.tags.length
    ? `tag ${git.tags[0].name}`
    : git && git.lastCommit
      ? `${git.lastCommit.hash} ${git.lastCommit.subject}`
      : "no milestones yet";
  const shownStates = ["working", "composing", "waiting", "possibly_stuck", "stopped", "orphaned", "done"];

  return `<div class="lane-card" data-flip-key="${esc(p.key)}">
    <div class="lane-head">
      <span class="lane-name">${esc(p.name)}</span>
      <span class="mono lane-key">${esc(p.key)}</span>
    </div>
    <div class="lane-counts">
      ${shownStates.filter((k) => counts[k] > 0).map((k) => `<span class="chip chip-${STATE_DOT_CLASS[k]}">${counts[k]} ${esc(STATE_LABEL[k])}</span>`).join("") || `<span class="chip chip-idle">all quiet</span>`}
      ${counts.paused > 0 ? `<span class="chip chip-paused">${counts.paused} paused</span>` : ""}
    </div>
    <div class="lane-doing">
      ${top ? `${stateChipHtml(top.state)} <strong class="mono">${esc(top.name)}</strong> ${esc(top.lastAction?.summary || "")} <span class="lane-age">${humanAge(top.quietMs)} ago</span>` : `<span class="empty">No active agent right now.</span>`}
    </div>
    <div class="lane-milestone mono">${esc(milestone)}</div>
  </div>`;
}

/** v3.3 owner directive ("lanes/projects: projects with live activity first"). "Live" here means
 * at least one agent in LIVE_STATES (working/composing) — a project with only a stalled agent is
 * NOT promoted by this rule (stalled agents are already visible via each lane's own red chip/
 * counts; this specific sort is about surfacing "where is work actively happening RIGHT NOW"). */
function projectHasLiveAgent(p) {
  return (p.board.agents || []).some((a) => LIVE_STATES.has(a.state));
}

function renderLanesTab() {
  const projects = scopedProjects()
    .map((p, i) => ({ p, i, live: projectHasLiveAgent(p) }))
    .sort((a, b) => (a.live === b.live ? a.i - b.i : a.live ? -1 : 1))
    .map((x) => x.p);
  const flipKeys = flipCapture($("#lanesBoard"), "[data-flip-key]");
  $("#lanesBoard").innerHTML = projects.length
    ? projects.map(laneCardHtml).join("")
    : state.scope
      ? `<p class="empty">The scoped project isn't currently enabled/watched.</p>`
      : `<p class="empty">No projects configured yet — add one in Settings.</p>`;
  flipPlay($("#lanesBoard"), "[data-flip-key]", flipKeys);
  $("#lanesTabBadge").textContent = String(projects.length);
}

// ---------- Live Feed ----------
// v3.1 Stage 4: kind color/label comes from the SERVER'S event-kinds SSOT (state.eventKinds,
// fetched once at boot from /api/event-kinds — lib/event-kinds.mjs) rather than a second
// hand-maintained map here (this project's own no-drift/SSOT discipline: one definition, not two
// that can silently disagree). FALLBACK_KIND_COLOR covers the brief window before that fetch
// resolves (or if it ever fails) so the feed never renders with NO color at all.
const FALLBACK_KIND_COLOR = "var(--i3)";

function kindDef(kind) {
  return (state.eventKinds && state.eventKinds[kind]) || null;
}
function kindColor(kind) {
  const d = kindDef(kind);
  return (d && d.color) || FALLBACK_KIND_COLOR;
}
function kindLabel(kind) {
  const d = kindDef(kind);
  return (d && d.label) || kind || "";
}

function feedRowHtml(e, mini = false) {
  const time = e.ts ? new Date(e.ts).toLocaleTimeString([], { hour12: false }) : "";
  const dotColor = kindColor(e.kind);
  const tag = e.projectName ? `<span class="feed-project mono">${esc(e.projectName)}</span>` : "";
  // Red-flag events (death/error/a destructive command/a failed test_result — lib/red-flags.mjs,
  // computed server-side once, not re-derived here) get a visible border treatment so they can't
  // be missed scrolling past at normal feed cadence (SPEC §3's "auto-elevation" requirement).
  const flagClass = e.redFlag ? " feed-row--redflag" : "";
  // Appended INSIDE the summary cell (not a sibling grid item) — .feed-row's grid-template-columns
  // is a fixed 7-column layout; adding an 8th sibling would silently misalign every column after
  // it for rows that happen to carry a verifiedBy link. Embedding keeps the grid honest.
  const verified = e.verifiedBy ? ` <span class="feed-link" title="${esc(e.verifiedBy.summary || "")}">↳ verified → committed</span>` : "";
  return `<div class="feed-row kind-${esc(e.kind || "")}${flagClass}${mini ? " feed-row--mini" : ""}">
    <span class="feed-time">${esc(time)}</span>
    <span class="feed-dot" style="background:${dotColor}"></span>
    ${mini ? "" : tag}
    <span class="feed-agent">${esc(e.agent || "")}</span>
    ${mini ? "" : `<span class="feed-kind">${esc(kindLabel(e.kind))}</span>`}
    <span class="feed-summary">${esc(e.summary || "")}${mini ? "" : verified}</span>
    ${mini ? "" : `<span class="feed-model">${esc(e.model || "")}</span>`}
  </div>`;
}

/** Builds the kind-filter chip row from state.eventKinds — every kind present in the CURRENT feed
 * buffer gets a toggle chip (not every kind that theoretically exists, so the row stays short and
 * relevant instead of listing 21 kinds when only 4 have ever appeared). `state.feedKindFilter ===
 * null` means "show all" (the default); a non-null Set means "show only these kinds." */
function renderKindFilterRow() {
  const el = $("#feedKindFilter");
  if (!el) return;
  const present = [...new Set(scopedFeed().map((e) => e.kind).filter(Boolean))].sort();
  if (present.length === 0) {
    el.innerHTML = "";
    return;
  }
  const allActive = state.feedKindFilter === null;
  el.innerHTML =
    `<button type="button" class="kind-chip${allActive ? " active" : ""}" data-kind="__all__">all</button>` +
    present
      .map((k) => {
        const active = allActive || state.feedKindFilter.has(k);
        return `<button type="button" class="kind-chip${active ? " active" : ""}" data-kind="${esc(k)}" style="--chip-color:${kindColor(k)}">${esc(kindLabel(k))}</button>`;
      })
      .join("");
  $$("[data-kind]", el).forEach((btn) =>
    btn.addEventListener("click", () => {
      const k = btn.dataset.kind;
      if (k === "__all__") {
        state.feedKindFilter = null;
      } else {
        const next = state.feedKindFilter === null ? new Set(present) : new Set(state.feedKindFilter);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        // selecting every kind individually is equivalent to "all" — collapse back to null so the
        // "all" chip re-highlights instead of staying dim with every other chip also active
        state.feedKindFilter = next.size >= present.length ? null : next;
      }
      renderFeedTab();
    })
  );
}

function renderFeedTab() {
  if (state.feedPaused) return;
  renderKindFilterRow();
  const filter = $("#feedProjectFilter").value;
  const list = $("#feedList");
  const items = scopedFeed()
    .filter((e) => !filter || e.projectKey === filter)
    .filter((e) => state.feedKindFilter === null || state.feedKindFilter.has(e.kind))
    .slice(-300)
    .reverse();
  list.innerHTML = items.length ? items.map((e) => feedRowHtml(e)).join("") : `<p class="empty">No activity yet — waiting for the first tool call, commit, or ledger update.</p>`;
  $("#feedTabBadge").textContent = String(scopedFeed().length);
}

$("#feedList").addEventListener("mouseenter", () => { state.feedPaused = true; $("#feedPausedTag").classList.add("show"); });
$("#feedList").addEventListener("mouseleave", () => { state.feedPaused = false; $("#feedPausedTag").classList.remove("show"); renderFeedTab(); });
$("#feedProjectFilter").addEventListener("change", renderFeedTab);

// v3.3 — every per-project select (Feed/Routing/Kanban/Tests/Git/Control) is built from
// scopedProjects(), not the full activeProjects() list, so a global scope narrows EVERY tab's own
// dropdown down to just the in-scope project(s) — "pick a project -> every tab tailors to it," per
// the owner's ask, without maintaining N separate scoping rules (one function, every consumer).
function populateProjectFilterOptions(selectEl, { keepSelection = true } = {}) {
  const prev = selectEl.value;
  const isAll = selectEl.id === "feedProjectFilter";
  const pool = scopedProjects();
  const opts = pool.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join("");
  selectEl.innerHTML = (isAll && !state.scope ? `<option value="">All projects</option>` : "") + opts;
  if (keepSelection && [...selectEl.options].some((o) => o.value === prev)) selectEl.value = prev;
  else if (selectEl.options.length) selectEl.value = selectEl.options[0].value;
}

// ---------- Agents (merged, active-first, idle collapsed) ----------
function renderAgentsTab() {
  const agents = allAgentsTagged().sort((a, b) => {
    const r = stateRank(a.state) - stateRank(b.state);
    if (r !== 0) return r;
    if (NEEDS_ATTENTION_STATES.has(a.state)) return b.quietMs - a.quietMs; // longest-quiet worst-offender leads
    return a.quietMs - b.quietMs;
  });
  // v3.1: DONE agents are the new long tail (a real session accumulates many finished agents —
  // observed live: 11 of ~15 real agents on this machine were "done" at once) — collapsed behind
  // a disclosure, same UX slot v3.0's "idle" bucket occupied, but for a different reason (volume,
  // not lack of information — a done agent's evidence string IS informative, just not urgent).
  const visible = agents.filter((a) => a.state !== "done");
  const finished = agents.filter((a) => a.state === "done");

  const ageBadge = (a) => {
    if (a.state === "possibly_stuck" || a.state === "stopped") return ` <span class="stall-age">(${humanAge(a.quietMs)} quiet)</span>`;
    if (a.state === "orphaned") return ` <span class="stall-age orphaned-age">(${humanAge(a.quietMs)} quiet)</span>`;
    if (a.state === "done") return ` <span class="stall-age done-age">(${humanAge(a.quietMs)} ago)</span>`;
    return "";
  };

  const row = (a) => `<tr class="agent-row agent-${a.state}${a.sourceConflict ? " agent-conflict" : ""}" data-flip-key="${esc(a.projectKey)}::${esc(a.name)}">
    <td>${stateChipHtml(a.state)}</td>
    <td class="mono">${esc(a.projectName)}</td>
    <td class="mono">${esc(a.name)}</td>
    <td>${esc(STATE_LABEL[a.state])}${ageBadge(a)}${a.sourceConflict ? ` <span class="badge pending" title="control ledger and transcript disagree">conflict</span>` : ""}</td>
    <td class="doing-cell" title="${esc(a.evidence || "")}">${esc(a.evidence || a.lastAction?.summary || "—")}</td>
    <td class="mono">${esc((a.models || []).join(", ") || "—")}</td>
    <td class="num">${esc(a.turnCount)}</td>
    <td class="num">${esc(a.tokensIn)}/${esc(a.tokensOut)}</td>
  </tr>`;

  const thead = `<tr><th></th><th>Project</th><th>Agent</th><th>Status</th><th>Evidence</th><th>Model(s)</th><th>Turns</th><th>Tokens (in/out)</th></tr>`;
  const body = visible.map(row).join("");
  const finishedHtml = finished.length
    ? `<details class="idle-disclosure"><summary>+ ${finished.length} finished agent${finished.length === 1 ? "" : "s"}</summary><div class="table-scroll" tabindex="0" aria-label="Data table, scrollable"><table><tbody>${finished.map(row).join("")}</tbody></table></div></details>`
    : "";

  const flipKeys = flipCapture($("#agentsTable"), "[data-flip-key]");
  $("#agentsTable").innerHTML = agents.length
    ? `<div class="table-scroll" tabindex="0" aria-label="Data table, scrollable"><table><thead>${thead}</thead><tbody>${body}</tbody></table></div>${finishedHtml}`
    : `<p class="empty">No subagent transcripts found for any watched project yet.</p>`;
  flipPlay($("#agentsTable"), "[data-flip-key]", flipKeys);

  populateProjectFilterOptions($("#routingProjectFilter"));
  const rp = state.selected.routing || $("#routingProjectFilter").value;
  const project = activeProjects().find((p) => p.key === rp);
  $("#routingLogTable").innerHTML = renderTable(project && project.board.routing, { emptyText: "No ROUTING-LOG.md found for the selected project." });
}
$("#routingProjectFilter").addEventListener("change", (e) => { state.selected.routing = e.target.value; renderAgentsTab(); });

// ---------- Kanban ----------
// v3.3 owner critique ("Kanban... don't show great details, realtime updated, with proper
// differentiation, highlighting and color coding"): every card now surfaces its W-RECORD inline —
// who + model, current action, dwell time in this column — not just a name; three explicit color
// states (working-pulse / stalled-red / done-dim) instead of the old binary live/stalled dot; and
// the drawer expands to the full interrogative record (who/what/where/when/how-long/how-much/
// whose/why/how/how-well/which/from-to/depends-on/what-next/verified-by), writing "n/a" wherever
// this dashboard genuinely has no signal for a field rather than guessing (no-guessing-evidence-
// first) — e.g. "how-much" (no per-card cost/effort metric exists) and "depends-on" (STATUS.md rows
// carry no dependency graph) are always "n/a", stated plainly, not fabricated.
const NA = `<span class="na">n/a</span>`;

function cardColorClass(c) {
  if (c.stalled) return "stalled";
  if (c.column === "Done") return "done-dim";
  if (c.activeAgents && c.activeAgents.length) return "live";
  return "";
}
/** The single state a card's chip represents — picks the most urgent ownerRecord state (a stalled
 * owner wins over a live one, matching cardColorClass's own priority) rather than showing multiple
 * chips per card, which would compete with the W-record line for attention. Returns null when the
 * card has no agent history at all (queued/no-owner cards get no chip — correct: nothing to show). */
function cardPrimaryState(c) {
  const records = c.ownerRecords || [];
  const stalledRec = records.find((r) => NEEDS_ATTENTION_STATES.has(r.state));
  if (stalledRec) return stalledRec.state;
  const liveRec = records.find((r) => LIVE_STATES.has(r.state));
  if (liveRec) return liveRec.state;
  return null;
}

function ownerRecordLine(rec) {
  const model = rec.models && rec.models.length ? esc(rec.models.join(", ")) : "no model recorded";
  const doing = rec.evidence ? esc(rec.evidence) : rec.state ? `state: ${esc(rec.state)}` : "not currently active";
  return `<span class="mono">${esc(rec.name)}</span> <span class="i2">(${model})</span> — ${doing}`;
}

function cardWRecordHtml(c) {
  const records = c.ownerRecords || [];
  if (!records.length) return `<div class="kanban-card-wrecord empty-wrecord">no agent claimed yet</div>`;
  // Front face stays to ONE line even with multiple owners (drawer shows every one in full) —
  // avoids the exact "cramped, everything crammed in" failure mode a dense card layout invites.
  const lead = records[0];
  const more = records.length > 1 ? ` +${records.length - 1} more` : "";
  return `<div class="kanban-card-wrecord">${ownerRecordLine(lead)}${more}</div>`;
}

function renderKanbanTab() {
  populateProjectFilterOptions($("#kanbanProjectFilter"));
  const key = state.selected.kanban || $("#kanbanProjectFilter").value;
  const project = activeProjects().find((p) => p.key === key);
  const board = $("#kanbanBoard");
  const k = project && project.board.kanban;
  if (!k || !k.columns || k.columns.length === 0) {
    board.innerHTML = `<p class="empty">No STATUS.md phase board or tasks.json found for the selected project.</p>`;
    return;
  }
  const flipKeys = flipCapture(board, "[data-card-id]", "cardId");
  board.innerHTML = k.columns
    .map((col) => {
      // v3.3 owner directive ("kanban columns: active cards float to top of their column"): a
      // stable sort — active-agent-owned cards first (stalled counts as active-needing-attention,
      // still "something is happening"), then everything else in its existing order. Stable sort
      // (Array.prototype.sort is stable per spec) means cards that DON'T move keep their relative
      // order, so this never shuffles the whole column on every render, only promotes the ones
      // that genuinely have live/stalled activity.
      const cards = k.cards
        .filter((c) => c.column === col)
        .map((c, i) => ({ c, i, active: (c.activeAgents && c.activeAgents.length > 0) || c.stalled }))
        .sort((a, b) => (a.active === b.active ? a.i - b.i : a.active ? -1 : 1))
        .map((x) => x.c);
      const colClass = col.toLowerCase().replace(/\s+/g, "-");
      const liveCount = cards.filter((c) => c.activeAgents && c.activeAgents.length).length;
      return `<div class="kanban-col">
        <div class="kanban-col-head"><span>${esc(col)}</span><span class="kanban-col-counts"><span class="num">${cards.length}</span>${liveCount ? `<span class="num kanban-wip-live" title="${liveCount} with an active agent right now">${liveCount} live</span>` : ""}</span></div>
        <div class="kanban-col-body">${
          cards.length
            ? cards
                .map((c) => {
                  const colorClass = cardColorClass(c);
                  const primaryState = cardPrimaryState(c);
                  return `<button class="kanban-card col-${esc(colClass)}${colorClass ? ` ${colorClass}` : ""}" data-card-id="${esc(c.id)}">
                    <div class="kanban-card-title">${esc(c.title)}</div>
                    ${cardWRecordHtml(c)}
                    <div class="kanban-card-meta">
                      <span class="mono">${esc(c.owner || c.source)}</span>
                      <span class="kanban-card-dwell" title="Time in this column">${humanAge(c.dwellMs)}${c.fromColumn ? ` <span class="i2">from ${esc(c.fromColumn)}</span>` : ""}</span>
                      ${primaryState ? stateChipHtml(primaryState, { compact: true }) : ""}
                    </div>
                  </button>`;
                })
                .join("")
            : `<p class="empty">Empty</p>`
        }</div>
      </div>`;
    })
    .join("");
  flipPlay(board, "[data-card-id]", flipKeys, "cardId");

  $$(".kanban-card", board).forEach((btn) =>
    btn.addEventListener("click", () => {
      const card = k.cards.find((c) => c.id === btn.dataset.cardId);
      if (card) openDrawer(card, project);
    })
  );
}
$("#kanbanProjectFilter").addEventListener("change", (e) => { state.selected.kanban = e.target.value; renderKanbanTab(); });

function showDrawer(html) {
  $("#drawerContent").innerHTML = html;
  $("#drawerOverlay").classList.add("show");
  $("#drawer").classList.add("show");
}

/** The full interrogative record (v3.3 owner critique). `project` is optional — only Kanban cards
 * currently pass it (for "where"); other drawer callers (git branches, dirty files) keep their own
 * shorter field sets untouched, this function is Kanban-specific. */
function openDrawer(card, project) {
  const records = card.ownerRecords || [];
  const whoHtml = records.length ? records.map((r) => `<div>${ownerRecordLine(r)}</div>`).join("") : NA;
  const howHtml = records.length && records.some((r) => r.evidence) ? records.filter((r) => r.evidence).map((r) => `<div class="mono">${esc(r.name)}: ${esc(r.evidence)}</div>`).join("") : NA;
  showDrawer(`
    <h3>${esc(card.title)}</h3>
    <div class="field"><label>Who</label><div class="val">${whoHtml}</div></div>
    <div class="field"><label>What</label><div class="val">${esc(card.title)}</div></div>
    <div class="field"><label>Where</label><div class="val mono">${project ? esc(project.name) : NA}</div></div>
    <div class="field"><label>When (entered this column)</label><div class="val mono">${card.columnEnteredAt ? esc(new Date(card.columnEnteredAt).toLocaleString()) : NA}</div></div>
    <div class="field"><label>How long</label><div class="val">${humanAge(card.dwellMs)} in <strong>${esc(card.column)}</strong></div></div>
    <div class="field"><label>How much</label><div class="val">${NA}</div></div>
    <div class="field"><label>Whose (raw owner cell)</label><div class="val mono">${esc(card.owner || "") || NA}</div></div>
    <div class="field"><label>Why</label><div class="val">${esc(card.why || "") || NA}</div></div>
    <div class="field"><label>How</label><div class="val">${howHtml}</div></div>
    <div class="field"><label>How well (status, raw)</label><div class="val">${esc(card.statusRaw || "") || NA}</div></div>
    <div class="field"><label>Which (source)</label><div class="val mono">${esc(card.source)}</div></div>
    <div class="field"><label>From &rarr; To</label><div class="val mono">${card.fromColumn ? `${esc(card.fromColumn)} &rarr; ${esc(card.column)}` : `(first seen) &rarr; ${esc(card.column)}`}</div></div>
    <div class="field"><label>Depends on</label><div class="val">${NA}</div></div>
    <div class="field"><label>What's next</label><div class="val">${esc(card.next || "") || NA}</div></div>
    <div class="field"><label>Verified by</label><div class="val">${NA}</div></div>`);
}
function closeDrawer() {
  $("#drawerOverlay").classList.remove("show");
  $("#drawer").classList.remove("show");
}
$("#drawerClose").addEventListener("click", closeDrawer);
$("#drawerOverlay").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// ---------- Tests & Quality ----------
/** v3.3 owner critique — the FIRST thing this tab shows is now the latest run itself (large, one
 * glance), not a trend row you have to interpret. Every field it reads (date/trigger/scope/result)
 * comes straight from the same TEST-RUNS.md table row the trend dots and the table below already
 * parse — no second source of truth for "what happened last." */
function renderTestHero(t, headers, rows) {
  const el = $("#testHero");
  if (!rows.length) {
    el.innerHTML = `<p class="empty">No test runs recorded yet for this project.</p>`;
    return;
  }
  const dateIdx = headers.findIndex((h) => /date/i.test(h));
  const triggerIdx = headers.findIndex((h) => /trigger/i.test(h));
  const scopeIdx = headers.findIndex((h) => /scope/i.test(h));
  const resultIdx = headers.findIndex((h) => /result|status/i.test(h));
  const last = rows[rows.length - 1];
  const cell = (idx) => (idx >= 0 ? last[idx] : "");
  const cls = statusClassFor(cell(resultIdx)) || "pending";
  const label = { pass: "PASS", fail: "FAIL", warn: "CAVEATED", pending: "PENDING" }[cls] || "UNKNOWN";
  el.innerHTML = `
    <div class="test-hero test-hero--${cls}">
      <div class="test-hero-verdict"><span class="badge ${cls}">${esc(label)}</span> <span class="mono test-hero-date">${esc(cell(dateIdx) || "—")}</span></div>
      <div class="test-hero-trigger">${esc(cell(triggerIdx) || "no trigger recorded")}</div>
      ${scopeIdx >= 0 && cell(scopeIdx) ? `<div class="test-hero-scope">${renderCell(cell(scopeIdx))}</div>` : ""}
      <div class="test-hero-result">${renderCell(cell(resultIdx) || "")}</div>
    </div>`;
}

function renderTestsTab() {
  populateProjectFilterOptions($("#testsProjectFilter"));
  const key = state.selected.tests || $("#testsProjectFilter").value;
  const project = activeProjects().find((p) => p.key === key);
  const t = project && project.board.testRuns;
  const rows = (t && t.rows) || [];
  const headers = (t && t.headers) || [];
  const resultIdx = headers.findIndex((h) => /result|status/i.test(h));
  renderTestHero(t, headers, rows);
  $("#testTrend").innerHTML = rows.length
    ? rows.map((row) => {
        const cell = resultIdx >= 0 ? row[resultIdx] : "";
        const cls = statusClassFor(cell) || "pending";
        return `<span class="trend-dot ${cls}" title="${esc(cell)}"></span>`;
      }).join("")
    : `<p class="empty">No test runs recorded yet.</p>`;
  $("#testRunsTable").innerHTML = renderTable(t, { emptyText: "No TEST-RUNS.md found for the selected project." });
}
$("#testsProjectFilter").addEventListener("change", (e) => { state.selected.tests = e.target.value; renderTestsTab(); });

// ---------- Git Timeline ----------
function matrixCellBadge(cell) {
  const cls = cell.status === "ok" ? "pass" : cell.status === "amber" ? "pending" : "fail";
  const label = cell.count > 0 ? cell.count : cell.status === "ok" ? "✓" : "—";
  return `<span class="badge ${cls}" title="${esc(cell.note)}">${esc(String(label))}</span>`;
}

function renderCadenceSparkline(buckets) {
  if (!buckets || !buckets.length) return `<p class="empty">No commit activity in the last 14 days.</p>`;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const bars = buckets
    .map((b) => {
      const h = Math.round((b.count / max) * 28) + 2;
      return `<div class="spark-bar" style="height:${h}px" title="${esc(b.date)}: ${b.count} commit${b.count === 1 ? "" : "s"}"></div>`;
    })
    .join("");
  return `<div class="sparkline" aria-label="Commit cadence, last 14 days">${bars}</div><p class="sub" style="margin-top:6px;">Commits/day, last 14 days.</p>`;
}

function renderGitTab() {
  populateProjectFilterOptions($("#gitProjectFilter"));
  const key = state.selected.git || $("#gitProjectFilter").value;
  const project = activeProjects().find((p) => p.key === key);
  const git = (project && project.board.campaign && project.board.campaign.git) || {};

  if (!git.available) {
    $("#gitRollup").textContent = "No git repository found for the selected project.";
    $("#gitBranch").textContent = "—";
    $("#gitStash").textContent = "—";
    $("#gitAheadBehind").innerHTML = "";
    $("#gitDirtySummary").textContent = "";
    $("#gitCadence").innerHTML = "";
    $("#gitMatrix").innerHTML = "";
    $("#gitTags").innerHTML = "";
    return;
  }

  $("#gitRollup").textContent = git.rollup || "—";
  $("#gitBranch").textContent = git.branch || "—";
  $("#gitStash").textContent = git.stashCount ? `${git.stashCount} stashed` : "none";

  const remotes = Object.entries(git.aheadBehind || {});
  $("#gitAheadBehind").innerHTML = remotes.length
    ? remotes
        .map(([remote, ab]) => {
          const rowStyle = `style="grid-template-columns: 100px 1fr;"`;
          if (!ab.tracked) return `<div class="feed-row" ${rowStyle}><span class="feed-summary mono">${esc(remote)}</span><span class="badge pending">not tracked</span></div>`;
          // v3.3 owner critique ("unpushed-age amber") — a branch sitting unpushed past the
          // threshold (lib/git-status.mjs's unpushedAmber, >30min) is a CAUTION (warn/amber,
          // dashed), not the same severity as an outright failure (solid red). Previously mapped to
          // "fail," which over-stated the urgency of "you forgot to push," a very different problem
          // from a broken build or a stalled agent.
          const cls = ab.ahead === 0 && ab.behind === 0 ? "pass" : ab.ahead > 0 && git.unpushedAmber ? "warn" : "pending";
          return `<div class="feed-row" ${rowStyle}><span class="feed-summary mono">${esc(remote)}</span><span class="badge ${cls}" title="${cls === "warn" ? "unpushed for over 30 minutes" : ""}">${ab.ahead} ahead / ${ab.behind} behind</span></div>`;
        })
        .join("")
    : `<p class="empty">No remotes configured.</p>`;

  const dirty = git.dirty || { count: 0, files: [] };
  $("#gitDirtySummary").innerHTML = dirty.count
    ? `<button class="link-btn" id="gitDirtyOpen">${dirty.count} uncommitted file${dirty.count === 1 ? "" : "s"} — view</button>`
    : "Working tree clean.";
  const dirtyBtn = document.getElementById("gitDirtyOpen");
  if (dirtyBtn) {
    dirtyBtn.addEventListener("click", () => {
      const rows = dirty.files.map((f) => `<div class="feed-row" style="grid-template-columns:100px 1fr;"><span class="feed-time mono">${esc(f.state)}</span><span class="feed-summary mono">${esc(f.path)}</span></div>`).join("");
      showDrawer(`<h3>Uncommitted changes</h3><div class="field"><div class="val">${rows || "—"}</div></div>`);
    });
  }

  $("#gitCadence").innerHTML = renderCadenceSparkline(git.cadence);

  const matrix = git.matrix || { rows: [] };
  $("#gitMatrix").innerHTML = matrix.rows.length
    ? `<div class="matrix-table">
        <div class="matrix-row matrix-head"><span>Branch</span><span>Committed</span><span>Pushed</span><span>Merged</span></div>
        ${matrix.rows
          .map(
            (r, i) => `<div class="matrix-row" data-row="${i}">
              <span class="mono">${esc(r.branch)}${r.worktreePath ? ` <span class="chip">worktree</span>` : ""}</span>
              <span>${matrixCellBadge(r.committed)}</span>
              <span>${matrixCellBadge(r.pushed)}</span>
              <span>${matrixCellBadge(r.merged)}</span>
            </div>`
          )
          .join("")}
      </div>`
    : `<p class="empty">No local branches.</p>`;
  $$("#gitMatrix .matrix-row[data-row]").forEach((row) => {
    row.addEventListener("click", () => {
      const r = matrix.rows[Number(row.dataset.row)];
      showDrawer(`<h3>${esc(r.branch)}</h3>
        <div class="field"><label>Worktree</label><div class="val mono">${esc(r.worktreePath || "none (branch only)")}</div></div>
        <div class="field"><label>Committed</label><div class="val">${matrixCellBadge(r.committed)} ${esc(r.committed.note)}</div></div>
        <div class="field"><label>Pushed</label><div class="val">${matrixCellBadge(r.pushed)} ${esc(r.pushed.note)}</div></div>
        <div class="field"><label>Merged</label><div class="val">${matrixCellBadge(r.merged)} ${esc(r.merged.note)}</div></div>`);
    });
  });
  if (matrix.strandedBranches && matrix.strandedBranches.length) {
    $("#gitMatrix").innerHTML += `<p class="sub" style="margin-top:8px;color:var(--fail-text);">Stranded: ${matrix.strandedBranches.map(esc).join(", ")}</p>`;
  }

  const tags = git.tags || [];
  $("#gitTags").innerHTML = tags.length
    ? `<div class="feed-list-static">${tags.map((t) => `<div class="feed-row" style="grid-template-columns:90px 90px 1fr;"><span class="feed-time mono">${esc(t.date || "")}</span><span class="feed-time mono">${esc(t.name)}</span><span class="feed-summary">${esc(t.subject || "")}</span></div>`).join("")}</div>`
    : `<p class="empty">No tags.</p>`;
}
$("#gitProjectFilter").addEventListener("change", (e) => { state.selected.git = e.target.value; renderGitTab(); });

// ---------- Control ----------
/** v3.1 Stage 5 carried finding (verify/M9-first-screen.md's honest observation): when the
 * SELECTED project has no control-request history, ~450px of the first screen sits empty below
 * the (also-empty) table — satisfies M9's letter (zero scroll, no defect) but not its spirit
 * (every pixel earning its place). Fills that space with a compact "recent activity across your
 * projects" strip — reusing feedRowHtml's existing mini mode (the same one Overview's "Recent
 * activity" card already uses) rather than inventing a second rendering path. Renders NOTHING
 * (returns the element to empty) once real control history exists for the selected project, so it
 * never competes with or duplicates the table above — it only fills a genuinely empty first
 * screen, never crowds a populated one. */
function renderControlActivityStrip(hasOwnHistory) {
  const el = $("#controlActivityStrip");
  if (!el) return;
  if (hasOwnHistory) {
    el.innerHTML = "";
    return;
  }
  const items = scopedFeed().slice(-8).reverse();
  el.innerHTML = items.length
    ? `<div class="control-activity-strip">
        <h3>Recent activity ${state.scope ? "for this project" : "across your projects"} <button class="info-dot" type="button" data-info="This project has no control-request history yet. Showing the 8 most recent events instead — full history lives in the Live Feed tab.">?</button></h3>
        ${items.map((e) => feedRowHtml(e, true)).join("")}
      </div>`
    : "";
}

/** v3.3 owner critique ("The Control section is too poor") — pending requests render as actionable
 * cards with a visible SUBMITTED -> PROJECT -> HONORED/PENDING chain, not a flat table row; honored
 * history is a separate section so "what's still waiting" is never buried under "what's done."
 * Honest boundary (control.mjs's documented contract, README "Control contract"): a request only
 * ever carries { action, agent, note, ts, honored } — the honoring ACT itself has no required
 * timestamp/actor/reason (the external orchestrator that flips honored:true isn't required to
 * record any of that). If a forward-compatible orchestrator DOES stamp honoredAt/honoredBy/
 * honoredNote (control.mjs's reader passes any extra fields through untouched), this renders them;
 * otherwise it says so plainly rather than inventing a "who/when/why" that was never captured. */
function controlCardHtml(r, projectName) {
  const honored = !!r.honored;
  const chainStep = (label, active, done) => `<span class="control-chain-step${done ? " done" : active ? " active" : ""}">${esc(label)}</span>`;
  const honoredDetail = honored
    ? `<div class="control-honored-detail">
        <span>Honored ${r.honoredAt ? esc(new Date(r.honoredAt).toLocaleString()) : NA}</span>
        <span>by ${r.honoredBy ? esc(r.honoredBy) : NA}</span>
        ${r.honoredNote ? `<span>— ${esc(r.honoredNote)}</span>` : ""}
      </div>`
    : "";
  return `<div class="control-card control-card--${honored ? "honored" : "pending"}">
    <div class="control-card-head">
      <span class="mono control-card-action">${esc(r.action)}</span>
      <span class="control-chain">
        ${chainStep("submitted", false, true)}
        <span class="control-chain-arrow">&rarr;</span>
        ${chainStep(esc(projectName || "project"), false, true)}
        <span class="control-chain-arrow">&rarr;</span>
        ${chainStep(honored ? "honored" : "pending", !honored, honored)}
      </span>
    </div>
    <div class="control-card-body">
      <span class="mono">${esc(r.agent || "no agent specified")}</span>
      <span>${esc(r.note || "no note")}</span>
      <span class="control-card-ts" title="Request submitted">${esc(new Date(r.ts).toLocaleString())}</span>
    </div>
    ${honoredDetail}
  </div>`;
}

function renderControlTab() {
  populateProjectFilterOptions($("#controlProject"));
  const key = state.selected.control || $("#controlProject").value;
  const project = activeProjects().find((p) => p.key === key);
  const control = (project && project.board.control) || { requests: [] };
  const rows = [...control.requests].reverse();
  const pending = rows.filter((r) => !r.honored);
  const honored = rows.filter((r) => r.honored);

  $("#controlPendingBadge").textContent = String(pending.length);
  $("#controlPending").innerHTML = pending.length
    ? pending.map((r) => controlCardHtml(r, project && project.name)).join("")
    : rows.length
      ? `<p class="empty">Nothing pending — every request for this project has been honored.</p>`
      : `<p class="empty">No control requests submitted yet for this project. Submit one below — its orchestrator's watchdog reads and honors requests on its own cycle, not instantly.</p>`;

  $("#controlHonored").innerHTML = honored.length
    ? honored.map((r) => controlCardHtml(r, project && project.name)).join("")
    : `<p class="empty">No honored requests yet for this project.</p>`;

  renderControlActivityStrip(rows.length > 0);
}
$("#controlProject").addEventListener("change", (e) => { state.selected.control = e.target.value; renderControlTab(); });

$("#controlForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("#controlMsg");
  const key = $("#controlProject").value;
  const body = {
    action: $("#action").value,
    agent: $("#agent").value.trim() || undefined,
    note: $("#note").value.trim() || undefined,
  };
  try {
    const res = await fetch(`/api/control/${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    msg.textContent = `Request queued for ${key} — the orchestrator's watchdog will read it on its next cycle.`;
    msg.className = "ok";
    $("#controlForm").reset();
    await refreshState();
  } catch (err) {
    msg.textContent = String(err.message || err);
    msg.className = "err";
  }
});

// ---------- Settings: general knobs ----------
const SETTINGS_SCHEMA = [
  { key: "port", label: "Port", type: "number", restart: true },
  { key: "bind", label: "Bind address", type: "text", restart: true },
  { key: "dashToken", label: "Dash token (bearer auth)", type: "text", restart: true, hint: "Leave as-is to keep unchanged; clear + save to disable." },
  { key: "controlContractEnabled", label: "Control contract enabled", type: "checkbox" },
  { key: "feed.refreshMs", label: "State refresh (ms)", type: "number" },
  { key: "feed.debounceMs", label: "Feed debounce (ms)", type: "number" },
  { key: "feed.bufferMax", label: "Feed ring buffer size (per project)", type: "number" },
  { key: "feed.liveWindowMs", label: "\"Working/Composing\" window (ms) — active while quieter than this", type: "number" },
  { key: "feed.stallThresholdMs", label: "Possibly-stuck threshold (ms) — flagged past this with no sign-off", type: "number" },
  { key: "feed.orphanThresholdMs", label: "Presumed-dead threshold (ms) — past this, still no sign-off", type: "number" },
  { key: "feed.hysteresisGraceMs", label: "State-flap grace margin (ms) — resists reverting near a threshold", type: "number" },
  { key: "feed.idleThresholdMs", label: "v3.0 idle threshold (ms) — legacy, unused by the live 8-state classifier", type: "number" },
  { key: "suggestLimit", label: "Auto-discovery suggestions to show", type: "number" },
  { key: "theme.defaultMode", label: "Default theme mode", type: "select", options: ["dark", "light"] },
  { key: "theme.accent", label: "Accent", type: "color" },
  { key: "theme.accentHover", label: "Accent (hover)", type: "color" },
  { key: "theme.accentPressed", label: "Accent (pressed)", type: "color" },
  { key: "theme.status.pass", label: "Status: pass", type: "color" },
  { key: "theme.status.fail", label: "Status: fail", type: "color" },
  { key: "theme.status.pending", label: "Status: pending", type: "color" },
  { key: "theme.status.building", label: "Agent state: working/composing", type: "color" },
  { key: "theme.status.verifying", label: "Agent state: waiting", type: "color" },
  { key: "theme.status.stalled", label: "Agent state: possibly stuck", type: "color" },
  { key: "theme.status.stopped", label: "Agent state: stopped", type: "color" },
  { key: "theme.status.orphaned", label: "Agent state: presumed dead", type: "color" },
  { key: "watchedReportFiles", label: "Watched report files (one per line)", type: "lines" },
  { key: "kanban.columns", label: "Kanban columns (one per line)", type: "lines" },
  { key: "secretStripPatterns", label: "Extra secret-strip regex patterns (one per line)", type: "lines" },
];

function getPath(obj, path) { return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, path, value) {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = cur[keys[i]] && typeof cur[keys[i]] === "object" ? cur[keys[i]] : {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function renderSettingsTab() {
  const cfg = state.config;
  const form = $("#settingsForm");
  if (!cfg) {
    form.innerHTML = `<p class="empty">Loading settings…</p>`;
  } else {
    form.innerHTML = SETTINGS_SCHEMA.map((field) => {
      const raw = getPath(cfg, field.key);
      const id = `set-${field.key.replace(/\./g, "-")}`;
      let input;
      if (field.type === "checkbox") input = `<input type="checkbox" id="${id}" ${raw ? "checked" : ""}>`;
      else if (field.type === "select") input = `<select id="${id}">${field.options.map((o) => `<option value="${esc(o)}" ${raw === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      else if (field.type === "lines") input = `<textarea id="${id}">${esc((raw || []).join("\n"))}</textarea>`;
      else if (field.type === "color") input = `<input type="color" id="${id}" value="${esc(raw || "#000000")}">`;
      else input = `<input type="${field.type}" id="${id}" value="${esc(raw ?? "")}">`;
      return `<div class="field-row"><label for="${id}">${esc(field.label)}</label>${input}${field.hint ? `<span class="field-hint">${esc(field.hint)}</span>` : ""}</div>`;
    }).join("");
  }
  renderProjectsManage();
  loadAndRenderCollectors();
}

// ---------- v3.3 — Collector Sources (owner directive: "online first", built here since no
// collector-sources UI existed at all before this — /api/collectors has been live server-side
// since v3.2 with zero visual surface). Polled on Settings-tab render rather than pushed via SSE —
// collector online/offline is a low-frequency signal (flips on a 45s-heartbeat-miss timescale),
// not worth a dedicated push channel. ----------
async function loadAndRenderCollectors() {
  let collectors = [];
  try {
    const res = await fetch("/api/collectors", { headers: authHeaders });
    const data = await res.json();
    collectors = data.collectors || [];
  } catch {
    return; // degrade gracefully — the card just stays hidden/stale, never throws
  }
  const card = $("#collectorsCard");
  if (!collectors.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const sorted = [...collectors].sort((a, b) => (a.offline === b.offline ? 0 : a.offline ? 1 : -1));
  $("#collectorsList").innerHTML = sorted
    .map((c) => {
      const chip = c.offline
        ? `<span class="state-chip state-chip--stalled" title="OFFLINE">OFFLINE</span>`
        : `<span class="state-chip state-chip--live chip-pulse" title="ONLINE"><span class="state-chip-dot chip-pulse"></span><span class="state-chip-label">ONLINE</span></span>`;
      return `<div class="collector-row">
        ${chip}
        <span class="mono collector-id">${esc(c.collectorId)}</span>
        <span class="collector-projects">${esc((c.projectKeys || []).join(", ") || "no projects yet")}</span>
        <span class="collector-age">${c.offline ? `offline ${humanAge(c.offlineMs)}` : `seen ${humanAge(Date.now() - c.lastSeenMs)} ago`}</span>
      </div>`;
    })
    .join("");
}

$("#settingsSave").addEventListener("click", async () => {
  const patch = {};
  for (const field of SETTINGS_SCHEMA) {
    const id = `set-${field.key.replace(/\./g, "-")}`;
    const el = $(`#${id}`);
    if (!el) continue;
    let value;
    if (field.type === "checkbox") value = el.checked;
    else if (field.type === "number") value = Number(el.value);
    else if (field.type === "lines") value = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
    else value = el.value;
    if (field.key === "dashToken" && value === "********") continue;
    setPath(patch, field.key, value);
  }
  const msg = $("#settingsMsg");
  try {
    const res = await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify(patch) });
    const data = await res.json();
    if (!res.ok) throw new Error((data.details || [data.error]).join("; "));
    msg.textContent = "Saved.";
    msg.className = "ok";
    if (data.restartRequired && data.restartRequired.length) {
      $("#restartChip").classList.add("show");
      msg.textContent += ` Restart required for: ${data.restartRequired.join(", ")} (stop and re-run \`node server.mjs\`).`;
    } else {
      $("#restartChip").classList.remove("show");
    }
    state.config = data.config;
    applyTheme(state.config);
  } catch (err) {
    msg.textContent = String(err.message || err);
    msg.className = "err";
  }
});

// ---------- Settings: Projects management ----------
async function loadProjectsAndSuggestions() {
  try {
    const res = await fetch("/api/projects", { headers: authHeaders });
    const data = await res.json();
    state.suggestions = data.suggestions || [];
  } catch {
    state.suggestions = [];
  }
  if (state.tab === "settings") renderProjectsManage();
}

function renderProjectsManage() {
  const configured = state.unified.projects || [];
  $("#projectsManage").innerHTML = configured.length
    ? `<div class="table-scroll" tabindex="0" aria-label="Data table, scrollable"><table><thead><tr><th></th><th>Name</th><th>Repo path</th><th>Agents</th><th></th></tr></thead><tbody>${configured
        .map((p) => {
          const agentCount = p.board ? (p.board.agents || []).length : "—";
          return `<tr>
            <td><span class="dot ${p.enabled ? "live" : "idle"}"></span></td>
            <td class="mono">${esc(p.name)}</td>
            <td class="mono">${esc(p.repoPath)}</td>
            <td class="num">${esc(agentCount)}</td>
            <td class="proj-actions">
              <button type="button" class="mini-btn" data-toggle="${esc(p.key)}" data-enabled="${p.enabled}">${p.enabled ? "Disable" : "Enable"}</button>
              <button type="button" class="mini-btn mini-btn--danger" data-remove="${esc(p.key)}">Remove</button>
            </td>
          </tr>`;
        })
        .join("")}</tbody></table></div>`
    : `<p class="empty">No projects configured yet.</p>`;

  $$("[data-toggle]", $("#projectsManage")).forEach((btn) =>
    btn.addEventListener("click", async () => {
      const key = btn.dataset.toggle;
      const enabled = btn.dataset.enabled !== "true";
      await fetch(`/api/projects/${encodeURIComponent(key)}`, { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({ enabled }) });
      await refreshState();
      renderProjectsManage();
    })
  );
  $$("[data-remove]", $("#projectsManage")).forEach((btn) =>
    btn.addEventListener("click", async () => {
      const key = btn.dataset.remove;
      if (!confirm(`Remove "${key}" from the dashboard? This only stops watching it — nothing in the project itself is touched.`)) return;
      await fetch(`/api/projects/${encodeURIComponent(key)}`, { method: "DELETE", headers: authHeaders });
      await refreshState();
      renderProjectsManage();
    })
  );

  $("#projectSuggestions").innerHTML = state.suggestions.length
    ? state.suggestions
        .map(
          (s) => `<div class="suggestion-row">
            <span class="mono">${esc(s.repoPath)}</span>
            <button type="button" class="mini-btn" data-add-suggestion="${esc(s.repoPath)}">Add</button>
          </div>`
        )
        .join("")
    : `<p class="empty">No recently-active unconfigured projects found.</p>`;
  $$("[data-add-suggestion]", $("#projectSuggestions")).forEach((btn) =>
    btn.addEventListener("click", async () => {
      await addProject(btn.dataset.addSuggestion);
      await loadProjectsAndSuggestions();
    })
  );
}

async function addProject(repoPath, name) {
  const res = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders }, body: JSON.stringify({ repoPath, name }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  state.unified = data.state;
  renderProjectsManage();
  return data;
}

$("#addProjectForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("#addProjectMsg");
  const path = $("#newProjectPath").value.trim();
  const name = $("#newProjectName").value.trim();
  try {
    await addProject(path, name || undefined);
    msg.textContent = "Added — watching live.";
    msg.className = "ok";
    $("#addProjectForm").reset();
    await loadProjectsAndSuggestions();
  } catch (err) {
    msg.textContent = String(err.message || err);
    msg.className = "err";
  }
});

// ---------- Render dispatch ----------
function renderActiveTab() {
  renderNarrative();
  const renderers = {
    overview: renderOverview,
    lanes: renderLanesTab,
    feed: renderFeedTab,
    agents: renderAgentsTab,
    kanban: renderKanbanTab,
    tests: renderTestsTab,
    git: renderGitTab,
    control: renderControlTab,
    settings: renderSettingsTab,
  };
  (renderers[state.tab] || (() => {}))();
}

/** Fetches the event-vocabulary SSOT once at boot (v3.1 Stage 4). Static data, not per-poll — a
 * fetch failure just leaves state.eventKinds empty, and kindColor()/kindLabel() above already
 * degrade to a safe fallback color and the raw kind string, so a failed fetch here is a cosmetic
 * gap (generic dots instead of per-kind colors), never a broken feed.
 *
 * REAL BUG FOUND & FIXED here (caught via a live-server screenshot, not just unit tests — the
 * browser-validation rule earning its keep): this fetch races the SSE `feed_batch` push. If
 * feed_batch (and its renderFeedTab() call) lands FIRST, the kind-filter chips and feed rows
 * render with the fallback (raw kind key, e.g. "COMMAND_BUILD" uppercased by CSS) — and, since
 * nothing re-rendered them, they stayed WRONG until the next feed event happened to arrive, which
 * on a quiet project could be minutes or never. Fixed: re-render once this resolves, so the UI
 * self-corrects regardless of which of the two async sources wins the race. */
async function loadEventKinds() {
  try {
    const res = await fetch("/api/event-kinds", { headers: authHeaders });
    state.eventKinds = await res.json();
    renderActiveTab();
  } catch {
    // degrade gracefully — see function header
  }
}

async function refreshState() {
  try {
    const res = await fetch("/api/state", { headers: authHeaders });
    state.unified = await res.json();
    renderActiveTab();
  } catch {
    // SSE `state` events are the primary channel; this is only the initial/manual fallback
  }
}

// ---------- SSE with manual backoff reconnect (native EventSource retry is fixed-interval only;
// this gives a fast, visible <3s reconnect with a banner instead of a silent multi-second gap) ----------
let es = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

function connect() {
  es = new EventSource(`/events${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`);

  es.addEventListener("open", () => {
    reconnectAttempts = 0;
    setConn(true);
    hideReconnectBanner();
  });

  es.addEventListener("error", () => {
    setConn(false);
    es.close();
    scheduleReconnect();
  });

  es.addEventListener("state", (ev) => {
    state.unified = JSON.parse(ev.data);
    if (state.tab !== "feed") renderActiveTab();
    else { renderNarrative(); renderFeedTab(); }
  });

  es.addEventListener("config", (ev) => {
    state.config = JSON.parse(ev.data);
    applyTheme(state.config);
    if (state.tab === "settings") renderSettingsTab();
  });

  es.addEventListener("warning", (ev) => {
    const data = JSON.parse(ev.data);
    const banner = $("#warningBanner");
    banner.textContent = data.message;
    banner.classList.add("show");
  });

  es.addEventListener("feed_batch", (ev) => {
    state.feed = JSON.parse(ev.data);
    renderActiveTab();
  });

  es.addEventListener("feed", (ev) => {
    const event = JSON.parse(ev.data);
    state.feed.push(event);
    const max = (state.config && state.config.feed && state.config.feed.bufferMax) || 500;
    if (state.feed.length > max * 4) state.feed = state.feed.slice(-max * 4); // client buffer covers all projects combined
    if (state.tab === "feed" && !state.feedPaused) renderFeedTab();
    if (state.tab === "overview") { renderMiniFeed(); renderActivityChart(); }
    if (state.tab === "lanes") renderLanesTab();
    // v3.1 Stage 5: only the ACTIVITY STRIP needs a live refresh here (new cross-project events
    // keep it current) — the control-request TABLE itself only changes via a POST this same client
    // made (already re-rendered there) or another session's request (which the 5s state poll
    // picks up), not via the fast per-event feed push; re-running the full renderControlTab() on
    // every feed event would be wasted work for a table that didn't change.
    if (state.tab === "control") {
      const key = state.selected.control || ($("#controlProject") && $("#controlProject").value);
      const project = activeProjects().find((p) => p.key === key);
      const hasOwnHistory = !!(project && project.board.control && project.board.control.requests.length);
      renderControlActivityStrip(hasOwnHistory);
    }
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectAttempts++;
  const delayMs = Math.min(1000 * reconnectAttempts, 3000); // 1s, 2s, capped at 3s (gate: <3s reconnect)
  showReconnectBanner(delayMs);
  reconnectTimer = setTimeout(connect, delayMs);
}

function showReconnectBanner(delayMs) {
  const el = $("#reconnectBanner");
  el.textContent = `Connection lost — reconnecting in ${Math.round(delayMs / 1000)}s… (attempt ${reconnectAttempts})`;
  el.classList.add("show");
}
function hideReconnectBanner() {
  $("#reconnectBanner").classList.remove("show");
}

function setConn(live) {
  $("#connDot").className = `dot ${live ? "live" : "down"}`;
  $("#connText").textContent = live ? "live" : "reconnecting…";
}

// ---------- Boot ----------
(async function boot() {
  connect(); // open the SSE stream immediately — don't serialize it behind other fetches (M1: <1s live)
  switchTab("overview");
  await Promise.all([refreshState(), loadProjectsAndSuggestions(), loadEventKinds()]);
  setInterval(loadProjectsAndSuggestions, 30000); // keep suggestions fresh without a manual refresh
})();
