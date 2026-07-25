// Live push feed for git state — new commits and new tags, for whichever project is active.
// Detection is SEMANTIC (compare HEAD/tag-list to last-known state), not per-fs-event — git
// touches many internal files per operation that carry no commit/tag news.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sanitizeAndTruncate } from "./sanitize.mjs";
import { watchCompat } from "./watch-compat.mjs";

function gitSafe(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function currentTags(cwd) {
  const raw = gitSafe(["tag"], cwd);
  return new Set(raw ? raw.split("\n") : []);
}

/** Watches `project.gitDir`. `opts.cwd`/`opts.gitDir` let the verification harness point this at
 * a throwaway repo instead of a real one. Returns stop(). */
export function startGitFeed(project, debounceMs, emit, opts = {}) {
  const cwd = opts.cwd || project.repoPath;
  const gitDir = opts.gitDir || project.gitDir;
  if (!fs.existsSync(gitDir)) return () => {};

  let lastHead = gitSafe(["rev-parse", "HEAD"], cwd);
  let lastTags = currentTags(cwd);

  function check() {
    const head = gitSafe(["rev-parse", "HEAD"], cwd);
    if (head && head !== lastHead) {
      const subject = gitSafe(["log", "-1", "--format=%h %s"], cwd);
      emit({ ts: new Date().toISOString(), agent: "git", model: null, kind: "commit", summary: sanitizeAndTruncate(subject) });
      lastHead = head;
    }
    const tags = currentTags(cwd);
    for (const tag of tags) {
      if (!lastTags.has(tag)) {
        emit({ ts: new Date().toISOString(), agent: "git", model: null, kind: "tag", summary: sanitizeAndTruncate(`tag: ${tag}`) });
      }
    }
    lastTags = tags;
  }

  let timer = null;
  const trigger = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      check();
    }, debounceMs);
  };

  let watcher;
  try {
    watcher = watchCompat(gitDir, { recursive: true }, trigger);
  } catch {
    try {
      watcher = watchCompat(path.join(gitDir, "HEAD"), trigger);
    } catch {
      return () => {};
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
