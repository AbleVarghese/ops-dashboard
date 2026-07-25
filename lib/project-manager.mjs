// v3's core addition: watches N projects SIMULTANEOUSLY (M4), where v2 watched exactly one at a
// time and "switching" tore the old watcher set down first. Owns one resolved `project` + one
// `feed` (lib/feed.mjs instance) per ENABLED entry in config.projects, reconciled live whenever
// the project list changes (add/remove/enable/disable) — no process restart, ever.
import { resolveProject } from "./paths.mjs";
import { ensureControlFile } from "./control.mjs";
import { createProjectFeed } from "./feed.mjs";
import { buildBoardState } from "./board-state.mjs";
import { buildNarrative } from "./narrative.mjs";

/** Derives a project-list entry (key/name/repoPath) from a repoPath — the same shape whether it
 * comes from a manual "add" or an auto-discovery suggestion. Does not persist anything. */
export function entryFromRepoPath(repoPath, name) {
  const project = resolveProject(repoPath);
  return {
    key: project.projectKey,
    name: name || project.repoPath.split("/").filter(Boolean).pop() || project.projectKey,
    repoPath: project.repoPath,
    enabled: true,
    addedAt: new Date().toISOString(),
  };
}

// v3.1: "stalled" is the NEEDS_ATTENTION tier — possibly_stuck (inference, mid-task), stopped
// (fact, a real session-ending error), orphaned (inference, presumed dead) — the strip's red-
// border "has-stall" signal fires for any of the three. Exported (not just inlined in
// buildUnifiedState below) as the SSOT for this computation — server.mjs's hub-merge path
// (buildFullState) needs the identical rule applied to remote/collector-sourced projects too, and
// must not hand-duplicate the state-name list a second time (structural-prevention.md Law 1).
export function stalledFrom(enabledWithBoard) {
  const stalled = [];
  for (const p of enabledWithBoard) {
    for (const a of p.board.agents || []) {
      if (a.state === "possibly_stuck" || a.state === "stopped" || a.state === "orphaned") {
        stalled.push({ projectKey: p.key, projectName: p.name, agentName: a.name, quietMs: a.quietMs, lastAction: a.lastAction, state: a.state, evidence: a.evidence });
      }
    }
  }
  return stalled.sort((a, b) => b.quietMs - a.quietMs);
}

export function createProjectManager(onFeedEvent) {
  // key -> { entry, project, feed }
  const armed = new Map();

  function armOne(entry, config) {
    const project = resolveProject(entry.repoPath);
    ensureControlFile(project.projectKey);
    const feed = createProjectFeed();
    feed.start(project, config, (event) => onFeedEvent({ ...event, projectKey: project.projectKey, projectName: entry.name }));
    armed.set(entry.key, { entry, project, feed });
  }

  function disarmOne(key) {
    const rec = armed.get(key);
    if (rec) rec.feed.stop();
    armed.delete(key);
  }

  /** Starts watchers for every newly-enabled project, stops watchers for every project that was
   * removed or disabled, and re-arms an already-running project whose repoPath changed under the
   * same key (rare, but a settings edit could do it). Idempotent — safe to call after ANY config
   * mutation (settings PATCH, project add/remove/toggle). */
  function reconcile(config) {
    const wanted = new Map((config.projects || []).filter((p) => p.enabled).map((p) => [p.key, p]));
    for (const key of [...armed.keys()]) {
      const want = wanted.get(key);
      if (!want || want.repoPath !== armed.get(key).entry.repoPath) disarmOne(key);
    }
    for (const [key, entry] of wanted) {
      if (!armed.has(key)) armOne(entry, config);
    }
  }

  /** Re-applies the current config's feed/report-file settings to every already-armed project
   * (a Settings save that changes debounce/watched-files/thresholds without adding/removing
   * projects) — cheaper than a full reconcile since project identity didn't change. */
  function restartAllWatchers(config) {
    for (const [key, rec] of armed) {
      rec.feed.stop();
      rec.feed.start(rec.project, config, (event) => onFeedEvent({ ...event, projectKey: key, projectName: rec.entry.name }));
    }
  }

  function stopAll() {
    for (const key of [...armed.keys()]) disarmOne(key);
  }

  function listArmedKeys() {
    return [...armed.keys()];
  }

  /** Every configured project (armed AND disabled) with live board state where armed, for the
   * unified snapshot the client renders. Disabled entries carry `board: null` so Settings can
   * still list + re-enable them without the server having watched anything for them.
   * v3.3.1 — ASYNC + PARALLEL ACROSS PROJECTS: buildBoardState() (now itself parallelized
   * internally, see git-status.mjs) is awaited via Promise.all over every armed project instead of
   * one at a time in a synchronous .map() — a deployment watching N projects used to pay N times
   * the per-project cost sequentially; it now pays roughly 1x wall-clock time. */
  async function buildUnifiedState(config) {
    const configured = config.projects || [];
    const projects = await Promise.all(
      configured.map(async (entry) => {
        const rec = armed.get(entry.key);
        const board = rec ? await buildBoardState(rec.project, config) : null;
        return { key: entry.key, name: entry.name, repoPath: entry.repoPath, enabled: entry.enabled, board };
      })
    );
    const enabledWithBoard = projects.filter((p) => p.enabled && p.board);
    return {
      generatedAt: new Date().toISOString(),
      projects,
      narrative: buildNarrative(enabledWithBoard),
      stalled: stalledFrom(enabledWithBoard),
    };
  }

  /** Merged, time-sorted feed events across every armed project, newest last (append order),
   * capped at `limit` — what a freshly-opened tab replays on connect. */
  function getRecentFeed(limit = 200) {
    const merged = [];
    for (const rec of armed.values()) merged.push(...rec.feed.getRecentFeedEvents(limit));
    merged.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
    return merged.slice(-limit);
  }

  /** Pushes a non-watcher-sourced event (currently: a control.json request, server.mjs's control
   * route) into ONE project's feed pipeline — same ring/red-flag/link treatment as every watcher
   * event. projectKey/projectName tagging happens automatically via armOne's onFeedEvent wrapper
   * (the same one every watcher event already passes through), so the caller doesn't repeat it.
   * A no-op for an unarmed/unknown key (degrade gracefully — a disabled project's control request
   * still gets recorded to control.json by the caller; it just doesn't appear in a feed nothing is
   * watching). */
  function injectFeedEvent(key, event) {
    const rec = armed.get(key);
    if (!rec) return;
    rec.feed.injectEvent(event);
  }

  return { reconcile, restartAllWatchers, stopAll, listArmedKeys, buildUnifiedState, getRecentFeed, injectFeedEvent };
}
