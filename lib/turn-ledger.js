/**
 * Per-turn delivery ledger.
 *
 * The plugin can be asked to plan the same user turn several times (one per
 * tool step). Without a ledger the same pins/recall text is injected again on
 * every step. The ledger records what was actually accepted for this turn, so
 * the second step sees "already delivered" instead of re-sending.
 *
 * Rules this file enforces:
 * - A turn is identified by host ids only (see turnKeyOf); never by clock or text.
 * - Only delivered records are recorded; budget-evicted ones are not.
 * - A failed send leaves nothing behind, so the next attempt can retry.
 * - Compaction clears the turn so necessary context can be rebuilt; a fork is a
 *   different session id and therefore inherits nothing.
 *
 * State is in-memory by design: it describes this process's view of one turn.
 */

import { turnKeyOf } from "./context-budget.js";

const sessions = new Map();

function stateOf(sessionId) {
  const key = String(sessionId || "");
  let state = sessions.get(key);
  if (!state) {
    state = {
      sessionId: key,
      turnKey: "",
      delivered: new Set(),
      spent: 0,
      mapText: "",
      mapTurnKey: "",
      corrections: [],
      generation: 0,
    };
    sessions.set(key, state);
  }
  return state;
}

/**
 * Start (or continue) a turn. A new turn key clears the delivered set and the
 * spent counter; queued corrections survive because they are still pending.
 */
export function beginTurn(sessionId, turnKey) {
  const state = stateOf(sessionId);
  const key = String(turnKey || "");
  if (state.turnKey !== key) {
    state.turnKey = key;
    state.delivered = new Set();
    state.spent = 0;
    state.mapText = "";
    state.mapTurnKey = "";
  }
  return state;
}

export function deliveredOf(sessionId, turnKey) {
  const state = beginTurn(sessionId, turnKey);
  return state.delivered;
}

export function spentOf(sessionId, turnKey) {
  return beginTurn(sessionId, turnKey).spent;
}

/** Budget still available in this turn (never negative). */
export function remainingOf(sessionId, turnKey, budget) {
  const cap = Math.max(0, Number(budget) || 0);
  return Math.max(0, cap - spentOf(sessionId, turnKey));
}

/** Remember the map text when it landed in the same turn as the records. */
export function noteMap(sessionId, turnKey, text) {
  const state = beginTurn(sessionId, turnKey);
  state.mapText = String(text || "");
  state.mapTurnKey = String(turnKey || "");
  return state;
}

export function mapTextOf(sessionId, turnKey) {
  const state = beginTurn(sessionId, turnKey);
  return state.mapTurnKey === String(turnKey || "") ? state.mapText : "";
}

/** Queue a correction (superseded/archived/expired after this turn's send). */
export function queueCorrection(sessionId, correction) {
  const state = stateOf(sessionId);
  const id = Number(correction?.id);
  if (!Number.isFinite(id)) return state.corrections;
  if (state.corrections.some((c) => Number(c.id) === id && c.note === correction.note)) return state.corrections;
  state.corrections.push({ ...correction, id, queuedAt: Date.now() });
  if (state.corrections.length > 20) state.corrections = state.corrections.slice(-20);
  return state.corrections;
}

export function pendingCorrections(sessionId) {
  return [...stateOf(sessionId).corrections];
}

/**
 * Reserve a delivery. The reservation is only a claim; call {@link commit} once
 * the messages were handed to the host, or {@link rollback} if anything threw.
 * `delivered` is deliberately untouched here, so a retry still sees its content.
 *
 * `totalTokens` is the rendered text's real cost (headers included). It is the
 * ledger's source of truth; the per-record numbers are only for the UI. If the
 * caller omits it, the sum of the records is used — never zero.
 */
export function reserve(sessionId, turnKey, records = [], { totalTokens } = {}) {
  const state = beginTurn(sessionId, turnKey);
  const list = (records || []).filter((r) => Number.isFinite(Number(r?.id)));
  const sum = list.reduce((acc, r) => acc + (Number(r.tokens) || 0), 0);
  const declared = Number(totalTokens);
  const total = Number.isFinite(declared) ? Math.max(0, Math.floor(declared)) : sum;
  return {
    sessionId: state.sessionId,
    turnKey: state.turnKey,
    generation: state.generation,
    records: list.map((r) => ({
      id: Number(r.id),
      channel: r.channel || "recall",
      fingerprint: String(r.fingerprint || ""),
      tokens: Number(r.tokens) || 0,
    })),
    tokens: total,
    committed: false,
    rolledBack: false,
  };
}

/**
 * Mark the reservation delivered. Idempotent; ignores stale generations.
 *
 * The booked amount is the reservation total, added once. Looping over records
 * would double-charge if a caller ever passed overlapping records, and it was
 * the code path that silently booked 0 when records had no `tokens`.
 */
export function commit(reservation) {
  if (!reservation || reservation.rolledBack || reservation.committed) return reservation;
  const state = stateOf(reservation.sessionId);
  if (state.turnKey !== reservation.turnKey || state.generation !== reservation.generation) {
    return reservation;
  }
  for (const record of reservation.records) {
    if (record.fingerprint) state.delivered.add(record.fingerprint);
  }
  state.spent += Math.max(0, Number(reservation.tokens) || 0);
  reservation.committed = true;
  return reservation;
}

/** Undo an uncommitted reservation. Nothing was marked, so a retry re-sends. */
export function rollback(reservation) {
  if (!reservation || reservation.committed) return reservation;
  reservation.rolledBack = true;
  return reservation;
}

/**
 * Compaction rebuild: the delivered fingerprints are forgotten so the content
 * can be re-established, but the budget is NOT reset. Compaction happens inside
 * the same user turn, and a free second 300 would break the "cumulative 300"
 * contract. The generation bump still invalidates any in-flight reservation.
 */
export function clearAfterCompaction(sessionId) {
  const state = stateOf(sessionId);
  state.delivered = new Set();
  state.mapText = "";
  state.mapTurnKey = "";
  state.generation += 1;
  return state;
}

export function clearSession(sessionId) {
  sessions.delete(String(sessionId || ""));
}

export function snapshot(sessionId) {
  const state = stateOf(sessionId);
  return {
    sessionId: state.sessionId,
    turnKey: state.turnKey,
    generation: state.generation,
    delivered: [...state.delivered],
    spent: state.spent,
    corrections: state.corrections.map((c) => ({ ...c })),
  };
}

export function resetAll() {
  sessions.clear();
}

export { turnKeyOf };
