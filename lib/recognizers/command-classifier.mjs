// v3.1 Stage 4 (the sensing layer) — Bash command classification. Categorizes a Bash tool_use
// command string into a verb family for feed narration + red-flag detection, per
// verify/V3.1-SPEC.md §3 ("Command classification: Bash verb families — test / build / lint / git
// / db / deploy — classified from the command string, config-driven regex families (editable in
// Settings, the recognition engine is the moat, keep it configurable)").
//
// Shape mirrors lib/recognizers/test-results.mjs deliberately (a FAMILIES array + one classify
// function) — each category is one entry, addable without touching the matching logic. NOT YET
// wired to Settings-editable patterns, same honestly-scoped follow-up test-results.mjs itself
// notes — that UI wiring lands once the recognizer set is proven correct against real commands.
//
// Every regex family below was checked against REAL Bash tool_use commands captured from this
// project's own build campaign (~/.claude/projects/-Users-Able-keralora/…/subagents/*.jsonl, this
// machine) — see test/recognizers/command-classifier.test.mjs for the literal captured fixtures
// (pnpm test/build/lint runs, git status/log, drizzle db:migrate, pnpm add, rm -rf).
//
// DESTRUCTIVE is checked FIRST, deliberately, ahead of every other category: a command that is
// BOTH e.g. a git operation AND destructive (`git clean -fd`, `git reset --hard`) must red-flag as
// destructive, not get filed under the calmer "git" bucket — safety classification outranks verb
// classification when they conflict.
const FAMILIES = [
  {
    name: "destructive",
    re: /\brm\s+-\w*r\w*f|\brm\s+-\w*f\w*r|\bgit\s+(?:clean\s+-\w*f|reset\s+--hard|push\s+--force(?!-with-lease))|\bdrop\s+(?:table|database)\b|\btruncate\s+table\b|\bdd\s+if=/i,
  },
  { name: "test", re: /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?test(?::\S+)?\b|\bvitest\b|\bplaywright\s+test\b|\bpytest\b|\bnode\s+--test\b/i },
  { name: "build", re: /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?build\b|\btsc\b.*--noEmit|\bnext\s+build\b/i },
  { name: "lint", re: /\b(?:pnpm|npm|yarn)\s+(?:run\s+)?lint\b|\bbiome\s+check\b|\beslint\b/i },
  { name: "db", re: /\bdrizzle-kit\b|\bdb:(?:generate|migrate|seed|push)\b|\bpsql\b|\bprisma\s+(?:migrate|db)\b/i },
  { name: "install", re: /\b(?:pnpm|npm|yarn)\s+(?:add|install|i)\b/i },
  { name: "deploy", re: /\bvercel\s+(?:deploy|--prod)\b|\bwrangler\s+(?:publish|deploy)\b|\bdocker\s+push\b/i },
  { name: "git", re: /\bgit\s+\w+/i },
];

/** Classifies a Bash command string into one verb family. Returns the family name — always a
 * string, never null (unlike the other recognizers): every command is SOME kind of command, and
 * "other" is a real, useful bucket for feed narration (not a failure to recognize). Empty/missing
 * input returns "other" for the same reason. Never throws. "other" is deliberately NOT one of the
 * FAMILIES entries (it would be a nonsensical always-match regex exposed to future Settings
 * editing) — it is this function's own fallback when nothing in FAMILIES matched. */
export function classifyCommand(command) {
  const text = typeof command === "string" ? command : "";
  for (const fam of FAMILIES) {
    if (fam.re.test(text)) return fam.name;
  }
  return "other";
}

export { FAMILIES };
