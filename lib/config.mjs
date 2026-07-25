// config.json lives next to server.mjs, created with defaults on first run. Every knob in the
// Settings tab round-trips through here. Corrupt/unreadable config falls back to defaults + a
// warning banner surfaced to the client — never crashes the server (error-resilience rule).
import fs from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.join(import.meta.dirname, "..", "config.json");

// Changing any of these requires an actual process restart (listener rebind / auth middleware) —
// everything else in DEFAULTS applies live, INCLUDING the project list (server.mjs reconciles
// watchers against config.projects on every settings/project write — no restart needed).
export const RESTART_REQUIRED_KEYS = ["port", "bind", "dashToken", "collectorToken"];

export const DEFAULTS = Object.freeze({
  port: 4650,
  bind: "127.0.0.1",
  dashToken: null,
  // v3.2 — hub mode's /ingest auth. Security decision (owner acceptance item #5): a leaked laptop
  // collector config must not grant browser dashboard read+control, and vice versa. When set, ONLY
  // this token authenticates POST /ingest (dashToken no longer works there). When left null
  // (default, backward-compatible with a v3.1 single-token setup), /ingest falls back to sharing
  // dashToken — a weaker, documented trade-off for anyone who hasn't opted into the split yet.
  collectorToken: null,
  // v3: multi-project. Each entry: { key, name, repoPath, enabled, addedAt }. `key` is the
  // Claude-Code project-dir name (stable, derived from repoPath — see paths.mjs), used everywhere
  // as the join key (feed event tags, control ledgers, per-project data/ dirs).
  projects: [],
  // v2 back-compat: still read/migrated on load (see migrateLegacyProjects below), never written.
  projectRepoMap: {},
  theme: {
    accent: "#3E6B4F",
    accentHover: "#4C7D5E",
    accentPressed: "#325A41",
    surfaceDark: { s0: "#0F0D0B", s1: "#171412", s2: "#1F1B18", s3: "#2A2521" },
    inkDark: { i0: "#F5F0E8", i1: "#C9C0B2", i2: "#8F877A", i3: "#5C564C" },
    surfaceLight: { s0: "#FAF7F2", s1: "#F3EEE6", s2: "#EAE3D8", s3: "#DDD3C4" },
    // i2 is darkened from the original #7A7264 — that value measured 3.7-4.5:1 against the light
    // surface tiers (WCAG AA text needs >=4.5:1; axe-core color-contrast flagged the dark-mode
    // sibling of this bug during M3 verification). i3 stays whisper-quiet — it's reserved for
    // decoration (dots, hairlines, border accents), never for text a user needs to read.
    inkLight: { i0: "#1C1814", i1: "#4A443C", i2: "#6C6559", i3: "#A89F8F" },
    status: {
      pass: "#3E6B4F", fail: "#A63D2F", pending: "#B08A3E", building: "#B08A3E", verifying: "#3E6C8F", stalled: "#A63D2F",
      // v3.1 Stage 3 — two NEW hues for the 8-state taxonomy's two states that don't map onto an
      // existing token: STOPPED ("grey-red" per verify/V3.1-SPEC.md's table — a muted, matter-of-
      // fact red, deliberately less alarming than possibly_stuck's `stalled` red, since a session-
      // limit death is a fact, not something needing the same urgency as an inferred stall) and
      // ORPHANED ("dark red" — heavier than stalled, the most severe inference state). WORKING
      // reuses `pass`/live's hue, COMPOSING the same hue without pulse, WAITING reuses `verifying`,
      // PAUSED reuses `pending`, POSSIBLY_STUCK reuses `stalled` — no new tokens needed for those.
      stopped: "#8C6B63", orphaned: "#7A2A1F",
      // WCAG-AA text-safe variants (M3 gate): the base hues above double as dot/border/accent
      // colors and read fine there (non-text contrast rules are looser), but as small TEXT
      // (badges, chips, stall-age, status cells) pass/fail/verifying measured 2.5-3.5:1 in dark
      // mode — below the 4.5:1 text minimum. Light mode's base hues already clear 4.5:1 except
      // verifying (4.4:1, just short) AND pending (2.51:1 — CORRECTION, v3.3.1: this comment
      // previously claimed only verifying needed a light-mode override; a real axe-core scan
      // against the v3.3 Tests/Control tabs' badge/chain-step components found `.badge.pending`
      // and `.badge.warn` genuinely failing in light mode at 2.51:1 — the raw `pending` hue
      // (#B08A3E) was never actually AA-safe as light-mode TEXT, this just hadn't been exercised
      // by a component using it as a small-text color in light mode until now). Computed +
      // verified (relative-luminance formula, not guessed): #7a5f28 clears 4.71:1 against s2 and
      // 5.2:1 against s1, the two surfaces pending-text actually renders on.
      passTextDark: "#54926c", failTextDark: "#cf6557", verifyingTextDark: "#5189b4",
      verifyingTextLight: "#3c698b", pendingTextLight: "#7a5f28", buildingTextLight: "#7a5f28",
      stoppedTextDark: "#b39187", orphanedTextDark: "#c96a5a",
    },
    defaultMode: "dark",
  },
  feed: {
    refreshMs: 5000,
    debounceMs: 150,
    bufferMax: 500,
    // Liveness thresholds (all ms) driving the v3.1 8-state classifier (lib/agent-status-v31.mjs).
    // idleThresholdMs is kept for v3.0's still-shipping classifier (lib/agent-status.mjs) during
    // the Stage 3 cutover window; v3.1 replaces the live/building/verifying/stalled/idle vocabulary
    // with working/composing/waiting/done/stopped/paused/possibly_stuck/orphaned — see
    // verify/V3.1-SPEC.md's taxonomy table for the full state->color->meaning mapping.
    liveWindowMs: 60000,
    stallThresholdMs: 300000, // 5 min quiet, mid-task, no completion signal = "possibly stuck"
    idleThresholdMs: 1800000, // v3.0 only — 30 min quiet = collapsed as idle/dormant
    orphanThresholdMs: 86400000, // v3.1 — 24h quiet, no completion signal = "presumed dead"
    hysteresisGraceMs: 15000, // v3.1 — grace margin at the possibly_stuck/orphaned entry boundary
  },
  secretStripPatterns: [],
  watchedReportFiles: ["ROUTING-LOG.md", "TEST-RUNS.md", "STATUS.md"],
  kanban: { columns: ["Queued", "In Progress", "Verifying", "Done"] },
  controlContractEnabled: true,
  // How many recently-active ~/.claude/projects dirs to surface as one-click "suggested" adds in
  // Settings (auto-discovery, M4). 0 disables the scan entirely.
  suggestLimit: 8,
});

function deepMerge(base, patch) {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] = typeof base[key] === "object" && base[key] !== null && !Array.isArray(base[key])
      ? deepMerge(base[key], patch[key])
      : patch[key];
  }
  return out;
}

/** v2->v3 migration: if `projects` is empty but the legacy `projectRepoMap` has entries, convert
 * every mapping into an enabled project entry. Runs once at load time; the migrated shape is
 * persisted back so this is a one-time no-op on every subsequent boot. Never drops data — the
 * legacy map is left in place (harmless, unused) rather than deleted. */
function migrateLegacyProjects(config) {
  if (config.projects && config.projects.length > 0) return { config, migrated: false };
  const entries = Object.entries(config.projectRepoMap || {});
  if (entries.length === 0) return { config, migrated: false };
  const projects = entries.map(([key, repoPath]) => ({
    key,
    name: key.replace(/^-/, "").split("-").pop() || key,
    repoPath,
    enabled: true,
    addedAt: new Date().toISOString(),
  }));
  return { config: { ...config, projects }, migrated: true };
}

/** `configPath` defaults to this package's own config.json next to server.mjs — the optional
 * override exists so the fault-injection test suite can corrupt/point-at a throwaway file instead
 * of the live config the running server actually reads (see test/fault-injection.test.mjs). */
export function loadConfig(configPath = CONFIG_PATH) {
  // DEFAULTS is frozen (it's a shared module-level constant) — every return path here must hand
  // back a fresh, mutable copy. Returning DEFAULTS itself let a first-run (or empty-file) caller
  // crash the instant it tried `config.someKey = ...` (real bug: threw "Cannot assign to read
  // only property" the first time this ran against a freshly-touched config.json).
  if (!fs.existsSync(configPath)) {
    saveConfig(DEFAULTS, configPath);
    return { config: deepMerge(DEFAULTS, {}), warning: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const merged = deepMerge(DEFAULTS, raw);
    const { config, migrated } = migrateLegacyProjects(merged);
    if (migrated) saveConfig(config, configPath);
    return { config, warning: null };
  } catch (err) {
    return {
      config: deepMerge(DEFAULTS, {}),
      warning: `config.json was unreadable/corrupt (${String(err && err.message ? err.message : err)}) — using defaults`,
    };
  }
}

export function saveConfig(config, configPath = CONFIG_PATH) {
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Validates a patch against DEFAULTS' shape (unknown top-level keys rejected; types checked
 * where cheaply verifiable). Returns { ok, errors } — never throws. */
export function validatePatch(patch) {
  const errors = [];
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return { ok: false, errors: ["patch must be a JSON object"] };
  }
  for (const key of Object.keys(patch)) {
    if (!(key in DEFAULTS)) errors.push(`unknown setting "${key}"`);
  }
  if (typeof patch.port !== "undefined" && (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535)) {
    errors.push("port must be an integer 1-65535");
  }
  if (typeof patch.secretStripPatterns !== "undefined") {
    if (!Array.isArray(patch.secretStripPatterns)) {
      errors.push("secretStripPatterns must be an array of regex source strings");
    } else {
      for (const p of patch.secretStripPatterns) {
        try {
          new RegExp(p);
        } catch {
          errors.push(`invalid regex in secretStripPatterns: ${p}`);
        }
      }
    }
  }
  if (typeof patch.projects !== "undefined") {
    if (!Array.isArray(patch.projects)) {
      errors.push("projects must be an array");
    } else {
      for (const p of patch.projects) {
        if (!p || typeof p !== "object" || typeof p.repoPath !== "string" || !p.repoPath) {
          errors.push("each project needs a repoPath string");
          break;
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Which top-level keys in `patch` require a restart (present in RESTART_REQUIRED_KEYS). */
export function restartRequiredFor(patch) {
  return Object.keys(patch).filter((k) => RESTART_REQUIRED_KEYS.includes(k));
}
