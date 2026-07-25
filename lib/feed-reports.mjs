// Live push feed for the durable ledgers: every newly appended table row shows up in the feed the
// moment it's written. `watchedFiles` comes from live config (Settings tab), defaulting to the 3
// conventional names — but ANY *.md the project actually has under reports/ is watched if the
// project ships it (degrades gracefully if reports/ doesn't exist at all).
import fs from "node:fs";
import path from "node:path";
import { primeAtCurrentEnd, readNewLines } from "./offset-tracker.mjs";
import { sanitizeAndTruncate } from "./sanitize.mjs";
import { watchCompat } from "./watch-compat.mjs";

export function startReportsFeed(project, debounceMs, watchedFiles, emit) {
  const unwatchers = [];
  for (const name of watchedFiles) {
    const filePath = path.join(project.reportsDir, name);
    if (!fs.existsSync(filePath)) continue;
    primeAtCurrentEnd(filePath);

    let timer = null;
    const process = () => {
      timer = null;
      for (const line of readNewLines(filePath)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("|")) continue;
        emit({
          ts: new Date().toISOString(),
          agent: "ledger",
          model: null,
          kind: "ledger",
          source: name,
          summary: sanitizeAndTruncate(trimmed),
        });
      }
    };

    let watcher;
    try {
      watcher = watchCompat(filePath, () => {
        if (timer) return;
        timer = setTimeout(process, debounceMs);
      });
    } catch {
      continue;
    }
    unwatchers.push(() => {
      if (timer) clearTimeout(timer);
      watcher.close();
    });
  }
  return () => unwatchers.forEach((fn) => fn());
}
