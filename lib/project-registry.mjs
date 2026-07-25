// The project switcher's data source. Self-registering, not filesystem-guessing: rather than
// reverse-engineering a real path from a dashed Claude Code project-dir name (lossy — a real
// directory can itself contain hyphens), every project the server has ever been pointed at gets
// recorded in config.projectRepoMap the first time it's resolved. The switcher lists THAT map —
// known-good mappings only, never a guess.
import { resolveProject } from "./paths.mjs";
import { saveConfig } from "./config.mjs";

/** Resolves repoPath, registers it in config.projectRepoMap if new/changed, returns
 * { project, config, configChanged }. Caller decides whether to persist (server.mjs does, once). */
export function registerProject(config, repoPath) {
  const project = resolveProject(repoPath);
  const existing = config.projectRepoMap[project.projectKey];
  if (existing === project.repoPath) {
    return { project, config, configChanged: false };
  }
  const nextConfig = { ...config, projectRepoMap: { ...config.projectRepoMap, [project.projectKey]: project.repoPath } };
  return { project, config: nextConfig, configChanged: true };
}

export function persistIfChanged(config, changed) {
  if (changed) saveConfig(config);
}

/** [{ projectKey, repoPath }] for the switcher UI — known-good mappings only. */
export function listKnownProjects(config) {
  return Object.entries(config.projectRepoMap).map(([projectKey, repoPath]) => ({ projectKey, repoPath }));
}
