// Live push feed for subagent transcripts AND the orchestrator's own top-level session
// transcripts. New subagent files (future spawns) are picked up automatically by watching each
// subagents/ dir for new entries. Returns a stop() so a project switch can tear this down cleanly
// and start fresh for the newly-selected project (module state is reset on every stop()).
import fs from "node:fs";
import path from "node:path";
import { primeAtCurrentEnd, readNewLines } from "./offset-tracker.mjs";
import { sanitizeAndTruncate } from "./sanitize.mjs";
import { summarizeToolInput } from "./summarize-tool.mjs";
import { deriveAgentName } from "./agent-name.mjs";
import { listAgentFileEntries } from "./transcripts.mjs";
import { classifyCommand } from "./recognizers/command-classifier.mjs";
import { recognizeAckStage } from "./recognizers/ack-stage.mjs";
import { recognizeTestResult } from "./recognizers/test-results.mjs";
import { recognizeError } from "./recognizers/error-recognition.mjs";
import { watchCompat } from "./watch-compat.mjs";

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function firstLineAgentId(filePath) {
  try {
    const firstLine = fs.readFileSync(filePath, "utf8").split("\n", 1)[0];
    return firstLine ? JSON.parse(firstLine).agentId : null;
  } catch {
    return null;
  }
}

// v3.1 Stage 4 — bounds the per-file pending-tool_use map (see rememberPending below) so a
// long-running, high-volume transcript file can't grow it unboundedly; oldest entries evicted
// first (Map iterates insertion order, so `.keys().next().value` is always the oldest).
const MAX_PENDING_PER_FILE = 200;

function rememberPending(pendingMap, id, info) {
  if (!id) return;
  if (pendingMap.size >= MAX_PENDING_PER_FILE) {
    const oldest = pendingMap.keys().next().value;
    pendingMap.delete(oldest);
  }
  pendingMap.set(id, info);
}

/** Assistant-type lines: tool_use/text -> feed events, ENRICHED with the Stage 4 recognizers —
 * Bash gets a `command_<category>` kind (test/build/lint/git/db/install/deploy/destructive) in
 * place of generic `tool_use` whenever classifyCommand recognizes something more specific than
 * "other"; Edit/Write get `file_edit`; a SendMessage carrying an ACK/STAGE-shaped body gets `ack`/
 * `stage`. Every tool_use's own `id` is remembered in `pendingMap` (keyed by the SAME id the
 * matching tool_result line will carry) so userLineToEvents() below can correlate a later result
 * back to the command that produced it — verify/V3.1-SPEC.md §3's "cross-source event linking."
 * Also handles the STRUCTURED api-error shape (`obj.isApiErrorMessage === true`) — a richer,
 * harness-set signal than any text pattern; see recognizers/error-recognition.mjs's module header
 * for the real captured fixture this shape comes from. */
export function assistantLineToEvents(obj, agentName, pendingMap) {
  if (!obj || obj.type !== "assistant" || !obj.message) return [];

  if (obj.isApiErrorMessage === true) {
    const err = recognizeError(obj);
    if (err) {
      return [
        {
          ts: obj.timestamp || new Date().toISOString(),
          agent: agentName,
          model: obj.message.model || null,
          kind: err.fatal ? "death" : "error",
          category: err.category,
          summary: sanitizeAndTruncate(err.detail),
        },
      ];
    }
  }

  const ts = obj.timestamp || new Date().toISOString();
  const model = obj.message.model || null;
  const content = Array.isArray(obj.message.content) ? obj.message.content : [];
  const events = [];
  for (const item of content) {
    if (item.type === "tool_use") {
      let kind = "tool_use";
      if (item.name === "Bash") {
        const category = classifyCommand(item.input && item.input.command);
        if (category !== "other") kind = `command_${category}`;
      } else if (item.name === "Edit" || item.name === "Write") {
        kind = "file_edit";
      } else if (item.name === "SendMessage") {
        const ackStage = recognizeAckStage(item.input);
        if (ackStage) kind = ackStage.type === "ack" ? "ack" : "stage";
      }
      rememberPending(pendingMap, item.id, { tool: item.name, ts });
      events.push({
        ts,
        agent: agentName,
        model,
        kind,
        tool: item.name,
        summary: sanitizeAndTruncate(summarizeToolInput(item.name, item.input)),
      });
    } else if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      events.push({ ts, agent: agentName, model, kind: "text", summary: sanitizeAndTruncate(item.text.trim()) });
    }
  }
  return events;
}

/** User-type lines carrying `tool_result` content (a Bash command's stdout, typically) -> zero or
 * one recognized event: a `test_result` (pass/fail/skip counts, recognizers/test-results.mjs) or
 * an `error`/`death` (recognizers/error-recognition.mjs). A tool_result matching NEITHER pattern
 * (the overwhelming majority — most command output is neither a test summary nor an error) emits
 * nothing here; its triggering command is already represented by the tool_use event above. When
 * `pendingMap` has a matching entry for this result's `tool_use_id`, the emitted event carries
 * `causedBy: { tool, ts }` — the cross-source link back to the command that produced it. */
export function userLineToEvents(obj, agentName, pendingMap) {
  if (!obj || obj.type !== "user" || !obj.message) return [];
  const content = Array.isArray(obj.message.content) ? obj.message.content : [];
  const ts = obj.timestamp || new Date().toISOString();
  const events = [];
  for (const item of content) {
    if (item.type !== "tool_result") continue;
    const raw = item.content;
    const text =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw.map((c) => (c && typeof c.text === "string" ? c.text : "")).join("\n")
          : "";
    if (!text) continue;

    let causedBy = null;
    if (item.tool_use_id && pendingMap.has(item.tool_use_id)) {
      causedBy = pendingMap.get(item.tool_use_id);
      pendingMap.delete(item.tool_use_id);
    }

    const testResult = recognizeTestResult(text);
    if (testResult) {
      events.push({
        ts,
        agent: agentName,
        model: null,
        kind: "test_result",
        framework: testResult.framework,
        passed: testResult.passed,
        failed: testResult.failed,
        skipped: testResult.skipped,
        total: testResult.total,
        causedBy,
        summary: sanitizeAndTruncate(
          `${testResult.framework}: ${testResult.passed} passed, ${testResult.failed} failed${testResult.skipped ? `, ${testResult.skipped} skipped` : ""}`
        ),
      });
      continue; // one tool_result narrates as a test summary OR an error, never both
    }
    const err = recognizeError(text);
    if (err) {
      events.push({
        ts,
        agent: agentName,
        model: null,
        kind: err.fatal ? "death" : "error",
        category: err.category,
        causedBy,
        summary: sanitizeAndTruncate(err.detail),
      });
    }
  }
  return events;
}

function orchestratorLabel(fileName) {
  return `orchestrator-${fileName.replace(/\.jsonl$/, "").slice(0, 8)}`;
}

/** Wires up every subagent + orchestrator transcript watcher for `project` and starts pushing
 * events to `emit`. Returns stop(). `debounceMs` comes from live config. */
export function startTranscriptFeed(project, debounceMs, emit) {
  const watchedFiles = new Set();
  const debounceTimers = new Map();
  const closers = [];

  function watchFile(filePath, agentName) {
    if (watchedFiles.has(filePath)) return;
    primeAtCurrentEnd(filePath);
    watchedFiles.add(filePath);
    // One pending-tool_use map PER FILE, living for the file's whole watch lifetime (not per
    // debounce tick) — a tool_use and its tool_result can land in different batches, so the
    // correlation map must outlive any single readNewLines() call. See rememberPending's header.
    const pendingMap = new Map();
    let watcher;
    try {
      watcher = watchCompat(filePath, () => {
        if (debounceTimers.has(filePath)) return;
        const timer = setTimeout(() => {
          debounceTimers.delete(filePath);
          for (const line of readNewLines(filePath)) {
            if (!line) continue;
            let obj;
            try {
              obj = JSON.parse(line);
            } catch {
              continue;
            }
            for (const ev of assistantLineToEvents(obj, agentName, pendingMap)) emit(ev);
            for (const ev of userLineToEvents(obj, agentName, pendingMap)) emit(ev);
          }
        }, debounceMs);
        debounceTimers.set(filePath, timer);
      });
    } catch {
      watchedFiles.delete(filePath);
      return;
    }
    watcher.on("error", () => watchedFiles.delete(filePath));
    closers.push(() => watcher.close());
  }

  function watchSubagentsDirForNewFiles(subagentsDir) {
    try {
      const watcher = watchCompat(subagentsDir, (eventType, filename) => {
        if (!filename || !filename.startsWith("agent-a") || !filename.endsWith(".jsonl")) return;
        const filePath = path.join(subagentsDir, filename);
        if (watchedFiles.has(filePath) || !fs.existsSync(filePath)) return;
        const name = deriveAgentName(firstLineAgentId(filePath), filename);
        watchFile(filePath, name);
        emit({ ts: new Date().toISOString(), agent: name, model: null, kind: "agent_spawned", summary: "new agent transcript detected" });
      });
      closers.push(() => watcher.close());
    } catch {
      // dir may not support watching (rare) — new agents in it just won't auto-register
    }
  }

  for (const entry of listAgentFileEntries(project)) {
    watchFile(entry.filePath, deriveAgentName(firstLineAgentId(entry.filePath), path.basename(entry.filePath)));
  }

  if (project.claudeProjectDirExists) {
    for (const fileEnt of safeReaddir(project.claudeProjectDir)) {
      if (fileEnt.isFile() && fileEnt.name.endsWith(".jsonl")) {
        watchFile(path.join(project.claudeProjectDir, fileEnt.name), orchestratorLabel(fileEnt.name));
      }
    }
    for (const sessionEnt of safeReaddir(project.claudeProjectDir)) {
      if (!sessionEnt.isDirectory()) continue;
      const subagentsDir = path.join(project.claudeProjectDir, sessionEnt.name, "subagents");
      if (fs.existsSync(subagentsDir)) watchSubagentsDirForNewFiles(subagentsDir);
    }
  }

  return function stop() {
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    for (const close of closers) close();
  };
}
