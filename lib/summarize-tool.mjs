// Turns a tool_use content block into a short, human-scannable summary line for the live feed.
// Sanitization happens at the call site (feed-transcripts.mjs) so every summary — tool or text —
// goes through the same single sanitize-then-truncate step (no path can skip it).
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable input]";
  }
}

const FILE_PATH_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);

/** Best-effort ≤~70-char (pre-sanitize) description of what a tool call is doing. */
export function summarizeToolInput(toolName, input) {
  const args = input && typeof input === "object" ? input : {};
  if (toolName === "Bash" && typeof args.command === "string") {
    return `Bash: ${args.command}`;
  }
  if (FILE_PATH_TOOLS.has(toolName) && typeof args.file_path === "string") {
    return `${toolName}: ${args.file_path}`;
  }
  if (toolName === "Grep" && typeof args.pattern === "string") {
    return `Grep: ${args.pattern}`;
  }
  if (toolName === "Glob" && typeof args.pattern === "string") {
    return `Glob: ${args.pattern}`;
  }
  if (toolName === "WebFetch" && typeof args.url === "string") {
    return `WebFetch: ${args.url}`;
  }
  if (toolName === "WebSearch" && typeof args.query === "string") {
    return `WebSearch: ${args.query}`;
  }
  if (toolName === "Agent" && typeof args.description === "string") {
    return `Agent: ${args.description}`;
  }
  if (toolName === "SendMessage" && typeof args.to === "string") {
    return `SendMessage -> ${args.to}: ${args.summary || ""}`;
  }
  if (toolName === "TaskUpdate" && args.status) {
    return `TaskUpdate: #${args.id || "?"} -> ${args.status}`;
  }
  return `${toolName}: ${safeStringify(args)}`;
}
