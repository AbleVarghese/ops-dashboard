// Derives Kanban cards from the STATUS.md phase board + live agent liveness, optionally merged
// with a project-authored tasks.json for finer-grained tracking than one card per phase row.
//
// DECISION (solvemax-style, see close-out report for the full comparison): column assignment
// priority is (1) an agent named in the row's Owner cell is CURRENTLY ACTIVE -> "Verifying"
// (something real is happening on this right now, regardless of nominal status text) — this beats
// parsing fuzzy "verified"/"verifying" language out of free-text evidence cells, because it's
// grounded in the same ground-truth liveness signal the rest of the dashboard already computes,
// not a second, weaker heuristic; (2) else the status cell's emoji/text maps directly.
import fs from "node:fs";
import path from "node:path";

const STATUS_DONE = /✅/;
const STATUS_QUEUED = /🔴/;
const STATUS_BLOCKED = /⏸️|blocked/i;

function extractOwnerAgentNames(ownerCell) {
  if (!ownerCell) return [];
  const backticked = [...ownerCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return backticked.length ? backticked : [];
}

function columnForStatusRow(ownerCell, statusCell, activeAgentNames, columns) {
  const owners = extractOwnerAgentNames(ownerCell);
  if (owners.some((name) => activeAgentNames.has(name))) {
    return columns.includes("Verifying") ? "Verifying" : columns[columns.length - 1];
  }
  if (STATUS_DONE.test(statusCell)) return columns.includes("Done") ? "Done" : columns[columns.length - 1];
  if (STATUS_QUEUED.test(statusCell)) return columns.includes("Queued") ? "Queued" : columns[0];
  if (STATUS_BLOCKED.test(statusCell)) {
    return columns.includes("In Progress") ? "In Progress" : columns[Math.min(1, columns.length - 1)];
  }
  return columns.includes("In Progress") ? "In Progress" : columns[Math.min(1, columns.length - 1)];
}

function cardsFromPhaseTable(phaseTable, activeAgentNames, stalledAgentNames, columns, agentsByName) {
  if (!phaseTable || !phaseTable.rows || phaseTable.rows.length === 0) return [];
  const idx = (name) => phaseTable.headers.findIndex((h) => new RegExp(name, "i").test(h));
  const iId = idx("^#$");
  const iItem = idx("item");
  const iOwner = idx("owner");
  const iStatus = idx("status");
  const iWhy = idx("why|evidence");
  const iNext = idx("next");

  return phaseTable.rows.map((row, i) => {
    const ownerCell = iOwner >= 0 ? row[iOwner] : "";
    const statusCell = iStatus >= 0 ? row[iStatus] : "";
    const owners = extractOwnerAgentNames(ownerCell);
    const activeOwners = owners.filter((name) => activeAgentNames.has(name));
    const stalledOwners = owners.filter((name) => stalledAgentNames.has(name));
    // v3.3 owner-critique — the card's W-RECORD: who + which model + what they're doing right now +
    // how long, sourced directly from the SAME agent objects the Agents tab reads (agentsByName is
    // a lookup over lib/transcripts.mjs's getAgents() output) — never a second, independently-
    // derived copy of "who's active" (structural-prevention.md Law 1). Every owner named on the row
    // gets an entry, active or not, so the drawer can show "n/a, not currently active" honestly
    // rather than omitting a named owner silently.
    const ownerRecords = owners.map((name) => {
      const a = agentsByName ? agentsByName.get(name) : null;
      if (!a) return { name, models: [], evidence: null, quietMs: null, state: null };
      return { name, models: a.models || [], evidence: a.evidence || null, quietMs: a.quietMs ?? null, state: a.state || null };
    });
    return {
      id: `status-${i}-${(iId >= 0 ? row[iId] : i).replace(/\s+/g, "")}`,
      title: iItem >= 0 ? row[iItem] : row.join(" "),
      column: columnForStatusRow(ownerCell, statusCell, activeAgentNames, columns),
      owner: ownerCell,
      activeAgents: activeOwners,
      stalledAgents: stalledOwners,
      ownerRecords,
      stalled: stalledOwners.length > 0,
      statusRaw: statusCell,
      why: iWhy >= 0 ? row[iWhy] : "",
      next: iNext >= 0 ? row[iNext] : "",
      source: "status",
    };
  });
}

function loadTasksJson(project) {
  const filePath = path.join(project.repoPath, "tasks.json");
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(raw) ? raw : Array.isArray(raw.tasks) ? raw.tasks : [];
  } catch {
    return [];
  }
}

function cardsFromTasksJson(project, columns) {
  return loadTasksJson(project).map((t, i) => ({
    id: `task-${t.id || i}`,
    title: String(t.title || t.name || `Task ${i + 1}`),
    column: columns.includes(t.column) ? t.column : columns[0],
    owner: t.owner || "",
    activeAgents: [],
    stalled: false,
    statusRaw: t.status || "",
    why: t.note || t.description || "",
    next: t.next || "",
    source: "tasks.json",
  }));
}

/** Full Kanban board: { columns: [...names], cards: [...] }. Never throws — degrades to an empty
 * board when neither STATUS.md nor tasks.json is present (a fresh/unrecognized project). */
export function getKanbanBoard(project, reportsData, agents, columns) {
  const activeAgentNames = new Set((agents || []).filter((a) => a.active).map((a) => a.name));
  // v3.1: "stalled" is now two states — possibly_stuck (inference, mid-task) and orphaned
  // (inference, presumed dead) — a card whose owner is in EITHER still gets flagged, same as v3.0's
  // single "stalled" bucket did.
  const stalledAgentNames = new Set((agents || []).filter((a) => a.state === "possibly_stuck" || a.state === "orphaned").map((a) => a.name));
  const agentsByName = new Map((agents || []).map((a) => [a.name, a]));
  const statusCards = cardsFromPhaseTable(reportsData.phaseTable, activeAgentNames, stalledAgentNames, columns, agentsByName);
  const taskCards = cardsFromTasksJson(project, columns);
  return { columns, cards: [...statusCards, ...taskCards] };
}
