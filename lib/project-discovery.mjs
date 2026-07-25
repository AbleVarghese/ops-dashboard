// Auto-suggest projects to watch (M4): scans ~/.claude/projects for recently-active dirs not
// already configured. The Claude-Code project-dir name is a LOSSY hyphenation of the repo's real
// path (paths.mjs's own doc comment: a real path segment can itself contain a hyphen), so this
// does NOT reverse-guess the path from the dirname. Instead it reads the `cwd` field out of the
// first parseable line of any session transcript in that dir — the same ground-truth field
// board-state already trusts per-agent — which is exact, not a guess. A dir where no `cwd` can be
// recovered is skipped rather than offered with a wrong guessed path (never propose an unverified
// path as if it were known-good).
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_PROJECTS_ROOT } from "./paths.mjs";

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeMtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Reads just enough of a .jsonl file to find a `cwd` field, without loading multi-MB transcripts
 * whole. Checks the first few lines only — `cwd` is emitted on effectively every line in practice. */
function sniffCwd(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    for (const line of text.split("\n").slice(0, 5)) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.cwd) return obj.cwd;
      } catch {
        // partial line at the 16KB cut, or non-JSON — try the next
      }
    }
  } catch {
    // unreadable — fall through to null
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

function newestActivityAndCwd(projectDir) {
  let newest = safeMtimeMs(projectDir);
  let cwd = null;
  const entries = safeReaddir(projectDir);
  for (const ent of entries) {
    const full = path.join(projectDir, ent.name);
    if (ent.isFile() && ent.name.endsWith(".jsonl")) {
      newest = Math.max(newest, safeMtimeMs(full));
      if (!cwd) cwd = sniffCwd(full);
    } else if (ent.isDirectory()) {
      newest = Math.max(newest, safeMtimeMs(full));
      const subagents = path.join(full, "subagents");
      for (const sub of safeReaddir(subagents)) {
        if (sub.isFile() && sub.name.endsWith(".jsonl")) {
          newest = Math.max(newest, safeMtimeMs(path.join(subagents, sub.name)));
        }
      }
    }
  }
  return { newest, cwd };
}

/** [{ key, repoPath, lastActivityMs }] — recently-active, unconfigured project dirs with a
 * verified `cwd`, newest first, capped at `limit`. Never throws; [] if the root doesn't exist. */
export function suggestProjects(excludeKeys, limit = 8) {
  const dirs = safeReaddir(CLAUDE_PROJECTS_ROOT).filter((e) => e.isDirectory());
  const candidates = [];
  for (const dir of dirs) {
    if (excludeKeys.has(dir.name)) continue;
    const { newest, cwd } = newestActivityAndCwd(path.join(CLAUDE_PROJECTS_ROOT, dir.name));
    if (!cwd || !fs.existsSync(cwd)) continue; // never suggest an unverifiable/gone path
    candidates.push({ key: dir.name, repoPath: cwd, lastActivityMs: newest });
  }
  candidates.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return candidates.slice(0, limit);
}
