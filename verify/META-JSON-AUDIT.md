# v3.1 Stage 1 — real `meta.json` shape audit (read before assuming, per the correctness law)

Ran a full scan of every `subagents/*.meta.json` file under `~/.claude/projects/` on this machine
before writing `lib/agent-evidence.mjs` — the correctness law explicitly requires reading the real
data shape before building a classifier around an assumed schema.

## Method

```js
// scanned every *.meta.json under ~/.claude/projects/, parsed each, recorded the sorted key set
// and a count of files per distinct key-combination
```

## Result

**8,208 files scanned. 0 parse errors.**

Union of every key ever observed, across all 8,208 files:

```
agentType, color, command, customAgentType, description, isFork, isUltraplan, model, name,
parentAgentId, permissionMode, planModeRequired, remoteTaskType, sessionId, spawnDepth, spawnMode,
spawnedAt, taskId, taskKind, teamName, title, toolUseId, worktreeBranch, worktreePath
```

**Finding 1 — no status/completion field exists, anywhere, ever.** None of `status`,
`idleReason`, `completedAt`, `killedAt`, `exitReason`, `terminated`, or any similar name appears in
any file's actual keys (a grep hit on "status" turned out to be the substring inside a free-text
`description` field — "Map docs, decisions, current status" — not a real field, confirmed by
reading the file). This directly corrects an assumption in the original directive ("the
subagents/*.meta.json files ... may include authoritative status"). `meta.json` is spawn-time
metadata only — useful as evidence-string CONTEXT (a "spawn brief": what this agent was asked to
do, which model, which team), never as a liveness or completion signal.

**Finding 2 — subagents share their orchestrator's OS process.** Every file carrying a `taskKind`
key has the value `"in_process_teammate"` (32/32 sampled with that key present). This means
subagents are multiplexed within ONE orchestrator process, not separate OS processes each with
their own PID. A per-subagent "process table" cross-check (the correctness law's 4th ground-truth
source) is therefore not a real, available signal on this machine's actual data — there is no PID
to check per subagent. Scoped honestly in `lib/agent-evidence.mjs`'s `processMatch` field
(`scope: "session-level-only"`) rather than faking a check that cannot be meaningful at the
subagent level.

## Distinct key-combinations observed (most common first)

| Count | Keys |
|---|---|
| 4332 | `agentType` |
| 1815 | `agentType, spawnDepth` |
| 756 | `agentType, description` |
| 484 | `agentType, description, toolUseId` |
| 304 | `agentType, description, spawnDepth, toolUseId` |
| 148 | `agentType, color, description, model, name, permissionMode, planModeRequired, spawnDepth, taskKind, teamName` |
| ... | (24 total combinations; the full breakdown is reproducible — see the scan method above) |

The richest, most-complete shape (148 files) is exactly what a modern spawned teammate agent (via
the Agent/Task tool with a name+color+model) produces — this is the shape `lib/agent-evidence.mjs`
targets for `spawnMeta`, degrading gracefully (already-tested) when a file has fewer fields, is
missing entirely, or is malformed.

## Consequence for the v3.1 taxonomy design

The 8-state classifier's evidence sources are, honestly, **3 real sources plus 1 context-only
source** — not 4 equally-weighted cross-checkable sources as originally specified:

- **Real evidence**: transcript tail (last ~2 entries), file mtime/quietMs, control.json requests.
- **Context only, never a liveness signal**: `meta.json` spawn metadata (agentType/description/
  model/team) — feeds evidence STRINGS ("spawned to: `<description>`"), not state classification.
- **Reinterpreted**: "process table" cross-check is session-level (is the orchestrator's own
  process alive), not per-subagent — genuinely useful for ORPHANED detection at the SESSION level,
  just not the per-agent granularity the original spec implied.

`verify/V3.1-SPEC.md` §2 is updated to reflect this corrected source list.
