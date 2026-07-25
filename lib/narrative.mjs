// Builds the plain-English narrative strip (M2 novice test): a first-time viewer must be able to
// answer, in <30s and without knowing any jargon, "which projects are active / who's working / on
// what right now / what just happened / is anything broken" — this function is that answer,
// pre-composed server-side so the client never has to re-derive it.
//
// v3.1 Stage 3: rewritten for the 8-state taxonomy (lib/agent-status-v31.mjs). Per the owner's
// spec ("narrative uses the right verb per state"), each state gets its own phrasing rather than
// one generic template — "is working on", "is composing", "is waiting on", "finished", "was
// stopped by", "is paused", "may be stuck", "is presumed dead". humanAge/import kept from
// agent-status.mjs (SSOT — that helper isn't state-specific, no reason to duplicate it).
import { humanAge } from "./agent-status.mjs";
import { STATE_LABEL_V31 } from "./agent-status-v31.mjs";

function latestMilestone(projects) {
  let best = null;
  for (const p of projects) {
    const git = p.board?.campaign?.git;
    if (git && git.tags && git.tags.length) {
      // git-status.mjs returns tags pre-sorted newest-first, each as {name, date, subject}
      const candidate = { project: p.name, label: `tag ${git.tags[0].name}` };
      if (!best) best = candidate;
    }
  }
  return best;
}

const ACTIVE_STATES = new Set(["working", "composing", "waiting"]);
const PROBLEM_STATES = new Set(["possibly_stuck", "orphaned"]);

/** The "what's it doing" clause for the LEAD sentence — one per active-ish state, per the owner's
 * "right verb per state" spec. Never called for possibly_stuck/orphaned (those go in the problems
 * list, not the lead line, since they're inferences about ABSENCE of activity, not a "doing" verb). */
function leadClause(agent) {
  switch (agent.state) {
    case "working":
      return agent.lastAction?.summary ? `is working — ${agent.lastAction.summary}` : "is working";
    case "composing":
      return "is composing a response";
    case "waiting":
      return agent.lastAction?.summary ? `is waiting — ${agent.lastAction.summary}` : "is waiting on something";
    case "stopped":
      return `was stopped — ${agent.evidence || "session ended"}`;
    case "paused":
      return "is paused";
    default:
      return `is ${STATE_LABEL_V31[agent.state] || agent.state}`;
  }
}

/** `projects` = [{ key, name, board }] for every ENABLED project (board = buildBoardState output). */
export function buildNarrative(projects) {
  if (!projects || projects.length === 0) {
    return "No projects configured yet. Add one in Settings to start watching.";
  }

  const sentences = [];
  sentences.push(`${projects.length} project${projects.length === 1 ? "" : "s"} watched.`);

  // The single most newsworthy agent right now — priority: active (working/composing/waiting) >
  // recently done > recently stopped > paused. One lead line, not a list, keeps the strip stable.
  let activeLead = null;
  let doneLead = null;
  let stoppedLead = null;
  let pausedLead = null;
  const problems = []; // possibly_stuck + orphaned — surfaced separately, always, regardless of the lead

  for (const p of projects) {
    for (const a of p.board?.agents || []) {
      if (ACTIVE_STATES.has(a.state)) {
        if (!activeLead || a.quietMs < activeLead.agent.quietMs) activeLead = { project: p, agent: a };
      } else if (a.state === "done") {
        if (!doneLead || a.quietMs < doneLead.agent.quietMs) doneLead = { project: p, agent: a };
      } else if (a.state === "stopped") {
        if (!stoppedLead || a.quietMs < stoppedLead.agent.quietMs) stoppedLead = { project: p, agent: a };
      } else if (a.state === "paused") {
        if (!pausedLead || a.quietMs < pausedLead.agent.quietMs) pausedLead = { project: p, agent: a };
      }
      if (PROBLEM_STATES.has(a.state)) {
        problems.push({ projectName: p.name, agentName: a.name, quietMs: a.quietMs, state: a.state, evidence: a.evidence });
      }
    }
  }

  if (activeLead) {
    sentences.push(`In ${activeLead.project.name}, ${activeLead.agent.name} ${leadClause(activeLead.agent)}, ${humanAge(activeLead.agent.quietMs)} ago.`);
  } else if (doneLead) {
    sentences.push(`${doneLead.agent.name} finished its task in ${doneLead.project.name}, ${humanAge(doneLead.agent.quietMs)} ago.`);
  } else if (stoppedLead) {
    sentences.push(`In ${stoppedLead.project.name}, ${stoppedLead.agent.name} ${leadClause(stoppedLead.agent)}, ${humanAge(stoppedLead.agent.quietMs)} ago.`);
  } else if (pausedLead) {
    sentences.push(`${pausedLead.agent.name} is paused in ${pausedLead.project.name}.`);
  } else {
    sentences.push("No agent is active right now.");
  }

  const milestone = latestMilestone(projects);
  if (milestone) sentences.push(`Last milestone: ${milestone.label} in ${milestone.project}.`);

  if (problems.length > 0) {
    const names = problems
      .sort((a, b) => b.quietMs - a.quietMs)
      .slice(0, 3)
      .map((s) => {
        const verb = s.state === "orphaned" ? "presumed dead" : "may be stuck";
        return `${s.agentName} (${s.projectName}, ${verb}, ${humanAge(s.quietMs)} quiet)`;
      })
      .join(", ");
    sentences.push(`${problems.length} agent${problems.length === 1 ? "" : "s"} need${problems.length === 1 ? "s" : ""} a look: ${names}.`);
  } else {
    sentences.push("Nothing needs attention.");
  }

  return sentences.join(" ");
}

export { humanAge };
