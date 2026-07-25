// Project-agnostic path resolution — v1 hardcoded one repo; v2 takes a repoPath and derives
// everything else. The Claude Code project-dir encoding (repoPath with "/" -> "-") is the same
// scheme observed in ~/.claude/projects/ for every project on this machine (SSOT for that mapping).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME = os.homedir();
export const CLAUDE_PROJECTS_ROOT = path.join(HOME, ".claude", "projects");

export function claudeProjectDirName(repoPath) {
  return `-${repoPath.split("/").filter(Boolean).join("-")}`;
}

export function resolveProject(repoPath) {
  const resolved = path.resolve(repoPath);
  const claudeProjectDir = path.join(CLAUDE_PROJECTS_ROOT, claudeProjectDirName(resolved));
  return {
    repoPath: resolved,
    projectKey: path.basename(claudeProjectDir), // e.g. "-Users-Able-keralora" — stable ID
    claudeProjectDir,
    claudeProjectDirExists: fs.existsSync(claudeProjectDir),
    reportsDir: path.join(resolved, "reports"),
    gitDir: path.join(resolved, ".git"),
    gitDirExists: fs.existsSync(path.join(resolved, ".git")),
  };
}

/** A safe, filesystem-friendly key for this project's own data dir (data/ next to server.mjs, resolved
 *  relative to this file via import.meta.dirname — location-independent, so the package can live anywhere). */
export function dataDirFor(projectKey) {
  return path.join(import.meta.dirname, "..", "data", projectKey);
}
