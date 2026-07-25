// Tracks how long each Kanban card has sat in its CURRENT column, and how long the board has been
// polled overall — the "how-long" half of the owner's W-record ask (verify/OWNER-CRITIQUE-v3.3:
// "who+model, current action, how-long + per-column dwell, why/mission line" on every card).
//
// getKanbanBoard() (lib/kanban.mjs) is STATELESS — it re-derives every card fresh from STATUS.md +
// live agent liveness on every call, with no memory of "when did this card enter this column." That
// statelessness is correct for column ASSIGNMENT (always re-derive from the current source of
// truth, never trust a cached column) but wrong for DWELL (a duration is inherently about the past,
// which a stateless re-derivation can't know). This module is the minimal, single-purpose stateful
// layer that bridges the two: one Map per project, keyed by card id, holding only
// { column, enteredAt } — nothing else. board-state.mjs calls applyDwell() once per buildBoardState()
// so every consumer (server.mjs's local path AND the hub-merge path) sees dwell without hand-rolling
// it twice (structural-prevention.md Law 1 — one implementation, not two).
//
// Honest boundary: dwell state lives in process memory only, keyed by projectKey. A server restart
// resets every card's dwell clock to "just entered" (enteredAt = now) rather than replaying history
// it never persisted — stated plainly rather than faked with a fabricated timestamp. This matches
// the general shape of every other in-memory liveness clock this codebase already keeps (e.g.
// lib/hub.mjs's collectors Map) — not a new class of risk.
const dwellByProject = new Map(); // projectKey -> Map<cardId, { column, enteredAt: ms }>

/** Enriches `board.cards` with `dwellMs` (time since the card last changed column, per THIS
 * process's observation) and `columnEnteredAt` (ISO string). Mutates nothing on `board` itself —
 * returns a new board object with new card objects, so callers holding a reference to the old board
 * (tests, other consumers) never see it change under them. Safe to call every poll tick; cheap
 * (one Map lookup/set per card). */
export function applyDwell(projectKey, board) {
  if (!board || !Array.isArray(board.cards)) return board;
  let tracked = dwellByProject.get(projectKey);
  if (!tracked) {
    tracked = new Map();
    dwellByProject.set(projectKey, tracked);
  }
  const now = Date.now();
  const seen = new Set();
  const cards = board.cards.map((card) => {
    seen.add(card.id);
    const prev = tracked.get(card.id);
    const changed = !prev || prev.column !== card.column;
    const enteredAt = changed ? now : prev.enteredAt;
    // fromColumn: the column this card was in just before its most recent transition — null for a
    // card seen for the very first time (nothing to transition FROM yet), honestly, not guessed.
    const fromColumn = changed ? (prev ? prev.column : null) : prev.fromColumn ?? null;
    tracked.set(card.id, { column: card.column, enteredAt, fromColumn });
    return { ...card, dwellMs: now - enteredAt, columnEnteredAt: new Date(enteredAt).toISOString(), fromColumn };
  });
  // Prune cards that no longer exist (removed from STATUS.md/tasks.json) so this Map doesn't grow
  // unboundedly over a long-running server's lifetime.
  for (const id of [...tracked.keys()]) if (!seen.has(id)) tracked.delete(id);
  return { ...board, cards };
}

/** Test-only escape hatch — clears all tracked dwell state so tests don't leak timing across runs. */
export function resetDwellState() {
  dwellByProject.clear();
}
