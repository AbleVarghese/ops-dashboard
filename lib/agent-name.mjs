// Shared agentId -> friendly-name derivation (SSOT — transcripts.mjs and the feed watchers both need it).
const HASH_RE = /^(.*)-([0-9a-f]{16})$/;

/** "abuild-rbac2-14f719a974a6d67f" -> "build-rbac2"; hash-only ids stay as-is. */
export function deriveAgentName(agentId, fallbackFileName) {
  if (!agentId) return fallbackFileName.replace(/^agent-a/, "").replace(/\.jsonl$/, "");
  const stripped = agentId.startsWith("a") ? agentId.slice(1) : agentId;
  const m = stripped.match(HASH_RE);
  return m ? m[1] : stripped;
}
