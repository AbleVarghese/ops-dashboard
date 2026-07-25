// Builds the board-pane snapshot (everything the UI's 5s `event: state` refresh needs) for ONE
// project. project-manager.mjs calls this once per enabled project and assembles the results into
// the unified multi-project payload the client actually receives.
import { getAgents } from "./transcripts.mjs";
import { getReportsData } from "./reports.mjs";
import { getGitStatus } from "./git-status.mjs";
import { getControlState } from "./control.mjs";
import { getKanbanBoard } from "./kanban.mjs";
import { applyDwell } from "./kanban-dwell.mjs";

// v3.3.1 — ASYNC (cascades from git-status.mjs's parallelization). getGitStatus() is kicked off
// FIRST, before the synchronous work below (getAgents/getReportsData/getKanbanBoard are all
// fs-based, not git-subprocess-bound — they run on the main thread while the git subprocesses are
// off doing their own I/O in parallel), then awaited only at the point its result is actually
// needed — so the git work and the fs work overlap in wall-clock time rather than one waiting on
// the other for no reason.
export async function buildBoardState(project, config) {
  const gitPromise = getGitStatus(project);
  const agents = getAgents(project, config.feed);
  const reportsData = getReportsData(project);
  const rawKanban = getKanbanBoard(project, reportsData, agents, config.kanban.columns);
  const git = await gitPromise;
  return {
    generatedAt: new Date().toISOString(),
    project: { projectKey: project.projectKey, repoPath: project.repoPath },
    agents,
    routing: reportsData.routingTable,
    campaign: {
      phaseTable: reportsData.phaseTable,
      decisionTable: reportsData.decisionTable,
      git,
    },
    reportFiles: reportsData.files.map((f) => f.name),
    testRuns: { ...reportsData.testRunsTable, rows: reportsData.testRunsTable.rows.slice(-10) },
    control: config.controlContractEnabled ? getControlState(project.projectKey) : { requests: [], pendingCount: 0, disabled: true },
    // v3.3 — dwell-enriched (how long each card has sat in its current column; see
    // lib/kanban-dwell.mjs's header for why this needs a stateful wrapper around an otherwise-
    // stateless board derivation). Keyed by projectKey so two projects' cards sharing an id shape
    // (e.g. "status-0-1") never cross-contaminate each other's dwell clocks.
    kanban: applyDwell(project.projectKey, rawKanban),
  };
}
