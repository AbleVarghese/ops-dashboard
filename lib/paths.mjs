// Project-agnostic path resolution — v1 hardcoded one repo; v2 takes a repoPath and derives
// everything else. The Claude Code project-dir encoding (repoPath with "/" -> "-") is the same
// scheme observed in ~/.claude/projects/ for every project on this machine (SSOT for that mapping).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME = os.homedir();
export const CLAUDE_PROJECTS_ROOT = path.join(HOME, ".claude", "projects");

/** Claude Code names a project directory by replacing every character that is not a letter or a
 *  digit with "-". The leading "/" of an absolute path therefore produces the leading "-".
 *
 *  CORRECTED 2026-09-09. The previous rule replaced only "/", which is what the comment above
 *  described as the scheme "observed for every project on this machine" — and that was true when
 *  it was written, because no project then had a dot or a space in its path. It stopped being
 *  true the moment ~/.claude itself, ~/.pi/worktrees/*, and repos under a dot-directory became
 *  projects, and the failure was silent: the derived directory simply did not exist, so the
 *  dashboard reported zero agents rather than an error.
 *
 *  Measured against every project directory under ~/.claude/projects whose own transcripts record
 *  a cwd (the cwd is primary evidence; the directory name is the thing under test, so deriving one
 *  from the other would be circular):
 *
 *      old rule ("/" only)              10 of 26 correct
 *      "/" and "."                      24 of 26 correct
 *      every non-alphanumeric           25 of 26 correct
 *
 *  The 26th is a directory whose sampled transcripts only ever recorded a cwd of "/Users/Able"
 *  after the session moved — a limit of the sampling, not a counterexample to the rule.
 *
 *  This remains an INFERRED rule: Anthropic publishes no spec for it. That is precisely why
 *  resolveProject surfaces `claudeProjectDirExists` and why callers must show it — a wrong
 *  encoding must read as an error, never as a quiet empty list. */
export function claudeProjectDirName(repoPath) {
  return repoPath.replace(/[^a-zA-Z0-9]/g, "-");
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
