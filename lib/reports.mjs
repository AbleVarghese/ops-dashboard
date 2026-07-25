// Generic markdown-table parsing for ANY project's reports/*.md files, plus live git state.
// v1 hardcoded 3 filenames; v2 reads every *.md under reports/ and additionally tries to
// recognize the 3 conventional names (status/routing-log/test-runs) by filename OR heading, so
// a project that doesn't follow Keralora's exact naming still gets its tables listed generically
// (just without the special Overview/Kanban/Tests-tab treatment those 3 unlock).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

/** Parses every GFM table in a markdown string, tagged with the heading that precedes it. */
export function parseMarkdownTables(md) {
  const lines = md.split("\n");
  const tables = [];
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      heading = line.replace(/^#+\s*/, "").trim();
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const headers = splitRow(line);
      let j = i + 2;
      const rows = [];
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        rows.push(splitRow(lines[j]));
        j++;
      }
      tables.push({ heading, headers, rows });
      i = j - 1;
    }
  }
  return tables;
}

function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function listMarkdownFiles(reportsDir) {
  try {
    return fs
      .readdirSync(reportsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const RECOGNIZERS = {
  status: /status/i,
  routingLog: /routing.?log/i,
  testRuns: /test.?runs/i,
};

/** Every reports/*.md file, parsed, plus the 3 conventionally-named ones singled out by name. */
export function getReportsData(project) {
  const files = listMarkdownFiles(project.reportsDir).map((name) => ({
    name,
    tables: parseMarkdownTables(safeReadFile(path.join(project.reportsDir, name))),
  }));

  const findByName = (re) => files.find((f) => re.test(f.name));
  const statusFile = findByName(RECOGNIZERS.status);
  const routingFile = findByName(RECOGNIZERS.routingLog);
  const testRunsFile = findByName(RECOGNIZERS.testRuns);

  const phaseTable =
    statusFile && (statusFile.tables.find((t) => /phase|board/i.test(t.heading)) || statusFile.tables[0]);
  const decisionTable = statusFile && statusFile.tables.find((t) => /decision/i.test(t.heading));

  return {
    files,
    phaseTable: phaseTable || { heading: "", headers: [], rows: [] },
    decisionTable: decisionTable || { heading: "", headers: [], rows: [] },
    routingTable: (routingFile && routingFile.tables[0]) || { heading: "", headers: [], rows: [] },
    testRunsTable: (testRunsFile && testRunsFile.tables[0]) || { heading: "", headers: [], rows: [] },
  };
}

function gitSafe(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Recent git tags + commits + branch — [] / "" if the project has no .git. */
export function getGitState(project) {
  if (!project.gitDirExists) return { branch: "", tags: [], recentCommits: [] };
  const tagsRaw = gitSafe(["tag", "--sort=-creatordate"], project.repoPath);
  const logRaw = gitSafe(["log", "--oneline", "-20"], project.repoPath);
  const branch = gitSafe(["branch", "--show-current"], project.repoPath);
  return {
    branch,
    tags: tagsRaw ? tagsRaw.split("\n").slice(0, 15) : [],
    recentCommits: logRaw ? logRaw.split("\n") : [],
  };
}
