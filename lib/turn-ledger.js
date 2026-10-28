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

import { resolve } from "node:path";
import { fingerprintOf, turnKeyOf } from "./context-budget.js";
import { isStalePayload } from "./until.js";

/** Keep the fact table bounded; older deliveries stop mattering eventually. */
const DELIVERED_FACT_LIMIT = 2048;

const sessions = new Map();

function stateOf(sessionId) {
  const key = String(sessionId || "");
  let state = sessions.get(key);
  if (!state) {
    state = {
      sessionId: key,
      turnKey: "",
      // Workspace this session reads from; node ids are per database, so a
      // correction must not cross workspaces.
      cwd: "",
      delivered: new Set(),
      // Last corrections actually handed to the host, for the settings panel.
      sentCorrections: [],
      /*
       * What this session was actually shown, per node: body, state and the
       * fingerprint it was shown under. A later write consults this table to
       * decide whether the model needs a correction notice.
       */
      deliveredFacts: new Map(),
      spent: 0,
      mapText: "",
      mapTurnKey: "",
      corrections: [],
      correctionBlockedReason: null,
      generation: 0,
    };
    sessions.set(key, state);
  }
  return state;
}

/** Bind a session to the workspace whose node ids it was shown. */
export function setSessionWorkspace(sessionId, cwd) {
  const state = stateOf(sessionId);
  const next = String(cwd || "").trim();
  if (next) state.cwd = resolve(next);
  return state.cwd;
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
  const changeKey = String(correction.changeKey || fingerprintOf(id,
    `${correction.l0 || ""}|${correction.note || ""}|${correction.currentId ?? ""}`, correction));
  const index = state.corrections.findIndex((c) => Number(c.id) === id);
  if (index >= 0 && state.corrections[index].changeKey === changeKey) return state.corrections;
  const next = { ...correction, id, correction: true, changeKey, queuedAt: Date.now() };
  // The latest state replaces a notice that has not landed yet (for example,
  // supersede followed by revoke). Queuing both would send a stale instruction.
  if (index >= 0) state.corrections[index] = next;
  else state.corrections.push(next);
  if (state.corrections.length > 20) state.corrections = state.corrections.slice(-20);
  return state.corrections;
}

export function pendingCorrections(sessionId) {
  return [...stateOf(sessionId).corrections];
}

export function setCorrectionBlockedReason(sessionId, reason = null) {
  stateOf(sessionId).correctionBlockedReason = reason === "channels-off" || reason === "budget" ? reason : null;
}

/** Expiry has no write event. Inspect only facts this session really received. */
export function refreshExpiredFacts(sessionId, payloadOf, now = new Date()) {
  const state = stateOf(sessionId);
  for (const fact of state.deliveredFacts.values()) {
    const payload = payloadOf(fact.id);
    if (!payload || payload.type !== "decision" || payload.status === "archived" || !isStalePayload(payload, now)) continue;
    noteFactChanged(fact.id, {
      cwd: state.cwd,
      type: payload.type,
      l0: String(payload.text || payload.name || "").replace(/\s+/g, " ").trim().slice(0, 200),
      until: String(payload.until || payload.untilAt || ""),
      stale: true,
      note: "这条决策已自然到期；后续不要继续把它当作有效约定。",
    });
  }
}

/**
 * Pending and recently delivered corrections, grouped by session.
 *
 * The panel is not tied to one session, so it asks per workspace and shows the
 * short session id. A session that never received a fact never appears.
 */
export function correctionSessions(cwd = "", { injectionEnabled = true } = {}) {
  const want = cwd ? resolve(String(cwd)) : "";
  const out = [];
  for (const state of sessions.values()) {
    if (want && state.cwd && state.cwd !== want) continue;
    if (!state.corrections.length && !state.sentCorrections.length) continue;
    const blockedReason = !injectionEnabled ? "channels-off"
      : state.correctionBlockedReason === "channels-off" ? null : state.correctionBlockedReason;
    out.push({
      sessionId: state.sessionId,
      cwd: state.cwd,
      blockedReason: state.corrections.length ? blockedReason : null,
      pending: state.corrections.map((c) => ({
        id: c.id,
        note: String(c.l0 || ""),
        queuedAt: c.queuedAt || null,
        blockedReason,
      })),
      sent: [...state.sentCorrections].slice(-10),
    });
  }
  return out;
}

/**
 * A fact changed after a session was shown it. Queue a short correction for
 * every session that actually received this node — "delivered once, never
 * again" is the wrong answer here, because the model would keep using stale
 * text for the rest of the conversation.
 *
 * `detail` describes the node **after** the write: type/l0/until/stale/archived
 * plus a short note. If the injected content is unchanged (for example only an
 * alias was edited), nothing is queued.
 */
export function noteFactChanged(id, detail = {}) {
  const targetId = Number(id);
  if (!Number.isFinite(targetId)) return 0;
  const record = {
    id: targetId,
    type: String(detail.type || ""),
    l0: String(detail.l0 || "").slice(0, 200),
    until: String(detail.until || ""),
    stale: detail.stale === true,
    archived: detail.archived === true,
  };
  const nextFingerprint = fingerprintOf(targetId, record.l0, record);
  const writeCwd = detail.cwd ? resolve(String(detail.cwd)) : "";
  let queued = 0;
  for (const state of sessions.values()) {
    if (writeCwd && state.cwd && state.cwd !== writeCwd) continue;
    const fact = state.deliveredFacts.get(targetId);
    if (!fact) continue;
    if (!detail.force && (fact.notifiedFingerprint || fact.fingerprint) === nextFingerprint) continue;
    const note = String(detail.note || "内容或状态已更新");
    queueCorrection(state.sessionId, {
      id: targetId,
      type: record.type || fact.type || "decision",
      l0: note,
      note: "",
      correction: true,
      currentId: Number.isFinite(Number(detail.currentId)) ? Number(detail.currentId) : targetId,
      factFingerprint: nextFingerprint,
      changeKey: `${nextFingerprint}:${detail.currentId ?? targetId}:${note}`,
    });
    queued += 1;
  }
  return queued;
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
      channel: String(r.channel || "recall"),
      type: String(r.type || ""),
      l0: String(r.l0 || ""),
      until: String(r.until || ""),
      stale: r.stale === true,
      archived: r.archived === true,
      correction: r.channel === "correction" || r.correction === true,
      changeKey: String(r.changeKey || ""),
      factFingerprint: String(r.factFingerprint || ""),
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
  const deliveredCorrections = new Set();
  for (const record of reservation.records) {
    if (record.fingerprint) state.delivered.add(record.fingerprint);
    if (record.correction) {
      // Consumed only now: an over-budget correction stays pending for the
      // next turn instead of being silently dropped.
      deliveredCorrections.add(`${record.id}:${record.changeKey}`);
      const fact = state.deliveredFacts.get(record.id);
      if (fact && record.factFingerprint) fact.notifiedFingerprint = record.factFingerprint;
      state.sentCorrections.push({
        id: record.id,
        note: String(record.l0 || ""),
        at: new Date().toISOString(),
      });
      if (state.sentCorrections.length > 20) state.sentCorrections.shift();
      continue;
    }
    if (!record.fingerprint) continue;
    state.deliveredFacts.set(record.id, {
      id: record.id,
      type: record.type,
      l0: record.l0,
      fingerprint: record.fingerprint,
      until: record.until,
      stale: record.stale,
      archived: record.archived,
    });
  }
  while (state.deliveredFacts.size > DELIVERED_FACT_LIMIT) {
    state.deliveredFacts.delete(state.deliveredFacts.keys().next().value);
  }
  if (deliveredCorrections.size) {
    state.corrections = state.corrections.filter((c) => !deliveredCorrections.has(`${Number(c.id)}:${c.changeKey || ""}`));
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
  // The rebuilt context will carry current state, so old delivery records are
  // no longer a reason to send a correction.
  state.deliveredFacts = new Map();
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
