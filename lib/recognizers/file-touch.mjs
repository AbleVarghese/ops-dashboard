// v3.1 Stage 4 (the sensing layer) — file-touch recognition. Classifies which files an agent's
// tool_use entries touched, as structured {op, path}, rather than the truncated free-text summary
// already shown elsewhere (summarize-tool.mjs). Consumes the SAME shape lib/agent-evidence.mjs's
// lastTranscriptActions() and lib/transcripts.mjs's lastActionFromMessage() already extract from a
// transcript line's assistant content array — no new I/O, per verify/V3.1-PLAN.md's Stage 4 note
// ("consumes Stage 1's output"). Input here is one tool_use content item: { name, input }.
//
// Real fixtures (captured from this campaign's own subagent transcripts, this machine — never
// reconstructed from memory, per the established Stage 4a norm):
//   Read  {"file_path":"/Users/Able/keralora/docs/05-IMPLEMENTATION-PLAN.md","offset":"1","limit":"100"}
//   Edit  {"file_path":"/Users/Able/keralora/apps/web/next.config.ts", ...}
//   Bash  {"command":"rm -rf /tmp/opsdash-v3-test/screens"}  (a real file-touching Bash command
//         from this project's own verify run — used for the "bash-file" bucket below)

/** Direct file-op tools — path comes straight off a known input field. */
const DIRECT_TOOLS = {
  Read: (input) => input && input.file_path,
  Edit: (input) => input && input.file_path,
  Write: (input) => input && input.file_path,
  NotebookEdit: (input) => input && input.notebook_path,
};

const DIRECT_OP = { Read: "read", Edit: "edit", Write: "write", NotebookEdit: "edit" };

/** Returns the last whitespace-separated, quote-stripped token of `command` — used for `sed -i`,
 * whose arg count differs between GNU (`sed -i 'expr' file`) and macOS/BSD (`sed -i '' 'expr'
 * file`, an extra empty-backup-suffix arg) — the file is reliably the LAST token in both dialects,
 * where a fixed argument-position regex is not. */
function lastToken(command) {
  const parts = command.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  return last ? last.replace(/^["']|["']$/g, "") : null;
}

// Bash commands that touch a specific file/dir target, in the order checked. Each entry is either
// `[regex, op]` (group 1 of a successful match is the path) or `[regex, op, extractor]` (a custom
// extractor for shapes a fixed capture group can't handle — see sed -i above). Deliberately
// conservative: a command not matching any of these yields "not recognized as file-touching",
// never a guessed path — a wrong guess is worse than an honest null (the sanitize-first discipline
// this codebase already holds elsewhere: false positives are the unsafe failure mode here).
const BASH_FILE_PATTERNS = [
  [/\brm\s+(?:-\w+\s+)*(\S+)/, "delete"],
  [/\bmv\s+\S+\s+(\S+)/, "move"],
  [/\bcp\s+(?:-\w+\s+)*\S+\s+(\S+)/, "copy"],
  [/\btouch\s+(\S+)/, "create"],
  [/\bmkdir\s+(?:-\w+\s+)*(\S+)/, "create"],
  [/>>?\s*(\S+)\s*$/, "write"], // shell redirection, e.g. `echo x > file` or `cmd >> log`
  [/\btee\s+(?:-\w+\s+)*(\S+)/, "write"],
  [/\bsed\s+-i\b/, "edit", (_m, command) => lastToken(command)], // sed -i [''] 'expr' file
];

/** Recognizes a file-touching tool_use. Returns `{ op, path }` or `null` — never throws. `op` is
 * one of "read" | "edit" | "write" | "delete" | "move" | "copy" | "create" for a Bash-detected
 * touch (a richer verb than the 3-way Edit/Write/Read split, since Bash can do things those tools
 * can't). Bash commands with no recognized file-touching shape return null (most Bash calls are NOT
 * file operations — `ls`, `git status`, a test run — and must not be misclassified as one). */
export function recognizeFileTouch(toolUse) {
  if (!toolUse || typeof toolUse !== "object") return null;
  const { name, input } = toolUse;
  if (!name) return null;

  if (Object.prototype.hasOwnProperty.call(DIRECT_TOOLS, name)) {
    const path = DIRECT_TOOLS[name](input);
    if (!path || typeof path !== "string") return null;
    return { op: DIRECT_OP[name], path };
  }

  if (name === "Bash") {
    const command = input && typeof input.command === "string" ? input.command : "";
    if (!command) return null;
    for (const [re, op, extractor] of BASH_FILE_PATTERNS) {
      const m = command.match(re);
      if (!m) continue;
      const path = extractor ? extractor(m, command) : m[1] && m[1].replace(/^["']|["']$/g, "");
      if (path) return { op, path };
    }
    return null;
  }

  return null;
}
