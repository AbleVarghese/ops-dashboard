// Aggregates the three live-push sources (transcripts, git, reports) behind one `emit` callback
// and a bounded ring buffer so a freshly-opened browser tab can replay recent history instead of
// starting on a blank feed.
//
// v3: INSTANTIABLE (createProjectFeed()) rather than module-level singleton state — v2 had exactly
// one active project at a time, so a single module-level `ring`/`activeStoppers` pair was enough;
// v3 watches N projects SIMULTANEOUSLY (project-manager.mjs holds one instance per enabled
// project), so shared mutable module state would let one project's stop() wipe another's buffer.
// The underlying watchers (feed-transcripts/git/reports.mjs) were already call-scoped (their state
// lives in closures returned from each start*Feed call) — only this aggregator needed to become
// instantiable. offset-tracker.mjs's path->offset map stays module-level/shared, which is safe:
// paths are absolute and therefore globally unique across projects.
import { startTranscriptFeed } from "./feed-transcripts.mjs";
import { startGitFeed } from "./feed-git.mjs";
import { startReportsFeed } from "./feed-reports.mjs";
import { isRedFlag } from "./red-flags.mjs";

// v3.1 Stage 4 — cross-source event linking (verify/V3.1-SPEC.md §3): "a commit shortly after a
// test-pass by the same agent renders as a linked 'verified -> committed' chain." Real constraint,
// stated honestly: feed-git.mjs's commit/tag events are NOT attributed to a specific building agent
// (git history has no per-commit "which agent" field this dashboard can read) — so the link is
// PROJECT-scoped (this feed instance = one project), not per-agent: "did a test pass recently,
// project-wide, before this commit landed." A commit within LINK_WINDOW_MS of the most recent
// passing test_result gets a `verifiedBy` reference attached. Honest boundary, not glossed over.
const LINK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes — generous enough to span "tests pass -> write commit message -> commit"

export function createProjectFeed() {
  let ring = [];
  let ringMax = 500;
  let activeStoppers = [];
  let running = false;
  let currentEmit = null; // set while running — lets injectEvent() (e.g. control.json requests,
  // which aren't produced by any file watcher) go through the SAME emit pipeline as every other
  // source, so red-flag tagging + cross-source linking apply uniformly regardless of origin.
  let lastPassingTest = null; // { ts, summary } | null — the linking state described above

  function getRecentFeedEvents(limit = 200) {
    return ring.slice(-limit);
  }

  /** Tears down every watcher this instance started. Safe to call when nothing is running. Does
   * NOT touch offset-tracker state (see module doc) — a later restart re-primes at current-end via
   * primeAtCurrentEnd(), which is correct regardless of any stale tracker entry left behind. */
  function stop() {
    for (const s of activeStoppers) s();
    activeStoppers = [];
    running = false;
    currentEmit = null;
  }

  function linkAndFlag(event) {
    if (event.kind === "test_result" && event.failed === 0) {
      lastPassingTest = { ts: event.ts, summary: event.summary };
    } else if (event.kind === "commit" && lastPassingTest) {
      const commitMs = Date.parse(event.ts);
      const testMs = Date.parse(lastPassingTest.ts);
      if (Number.isFinite(commitMs) && Number.isFinite(testMs) && commitMs - testMs <= LINK_WINDOW_MS && commitMs >= testMs) {
        event.verifiedBy = lastPassingTest;
      }
    }
    event.redFlag = isRedFlag(event);
    return event;
  }

  /** Starts every watcher for `project`, using live `config` values (feed.debounceMs,
   * feed.bufferMax, watchedReportFiles). `onEvent(event)` fires AFTER the event is recorded in the
   * ring buffer. Call stop() first when re-arming with new config values affecting watched paths. */
  function start(project, config, onEvent) {
    if (running) stop();
    ringMax = config.feed.bufferMax;
    ring = [];
    lastPassingTest = null;
    const emit = (event) => {
      linkAndFlag(event);
      ring.push(event);
      if (ring.length > ringMax) ring.shift();
      onEvent(event);
    };
    currentEmit = emit;
    activeStoppers = [
      startTranscriptFeed(project, config.feed.debounceMs, emit),
      startGitFeed(project, config.feed.debounceMs, emit),
      startReportsFeed(project, config.feed.debounceMs, config.watchedReportFiles, emit),
    ];
    running = true;
  }

  /** Pushes an event from a source OUTSIDE the file watchers (currently: server.mjs's control
   * route, on a new control.json request) through the same emit/ring/red-flag/link pipeline. A
   * no-op when this instance isn't running (the project isn't currently armed) — same
   * degrade-gracefully contract every watcher here already has. */
  function injectEvent(event) {
    if (running && currentEmit) currentEmit(event);
  }

  return { start, stop, injectEvent, getRecentFeedEvents, get running() { return running; } };
}
