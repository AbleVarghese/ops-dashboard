// Secret redaction — applied to every feed summary BEFORE truncation, so a secret can never be
// cut in half by the 80-char limit and partially leaked. Errs toward over-redaction: this is a
// dashboard that renders live tool input/output text, so false positives (redacting something
// harmless that merely looks key-shaped) are the safe failure mode; false negatives are not.
const BUILTIN_PATTERNS = [
  // Explicit secret-shaped tokens (checked first — most specific).
  [/sk_[A-Za-z0-9_]{6,}/g, "[REDACTED]"],
  [/whsec_[A-Za-z0-9_]{6,}/g, "[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]"],
  // key/token/password/secret = value (JSON, env-style, or CLI-flag shaped).
  [
    /((?:api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|token|password|passwd|pwd|secret)["']?\s*[:=]\s*)(["'][^"']{3,}["']|[^\s,}"']{4,})/gi,
    "$1[REDACTED]",
  ],
  [/Authorization["']?\s*[:=]\s*["']?[^\s"',}]{4,}/gi, "Authorization: [REDACTED]"],
];

// Config-supplied additive patterns (regex source strings) — Settings tab, "secretStripPatterns".
let extraPatterns = [];

/** Replaces the additive pattern set. Invalid regex sources are skipped, never thrown (config.mjs
 * validates at write time, but this is the belt for the suspenders). */
export function setExtraPatterns(sources) {
  extraPatterns = (Array.isArray(sources) ? sources : [])
    .map((src) => {
      try {
        return [new RegExp(src, "gi"), "[REDACTED]"];
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function allPatterns() {
  return [...BUILTIN_PATTERNS, ...extraPatterns];
}

/** Redacts secret-shaped substrings. Never throws — a sanitize failure must not crash the feed. */
export function sanitize(text) {
  if (typeof text !== "string" || !text) return "";
  let out = text;
  for (const [pattern, replacement] of allPatterns()) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Sanitize, then hard-truncate to maxLen (default 80) — the order the feed spec requires. */
export function sanitizeAndTruncate(text, maxLen = 80) {
  const clean = sanitize(text).replace(/\s+/g, " ").trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}
