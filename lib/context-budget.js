/**
 * Unified per-turn context budget.
 *
 * Chips (pins) and recall used to clip to 300 tokens each, so one turn could
 * carry 600 and the same node could appear twice. This module owns a single
 * decision: which structured records go into this turn, in what order, and
 * what the exact text will be. It never re-parses a clipped string.
 *
 * Only `estimateTokens` is used for accounting — it is a CJK/ASCII heuristic,
 * not a model tokenizer, so every surface must label its numbers as estimates.
 */

import { estimateTokens, clipToTokenBudget } from "./tokens.js";

/** Session map: once per session, labels only. */
export const MAP_TOKEN_BUDGET = 400;

/** One user turn: pins + corrections + recall share this, headers included. */
export const TURN_ADDITIONAL_BUDGET = 300;

/** Why a candidate did not make it. Kept short so it can be shown as a tag. */
export const DROP_REASONS = Object.freeze({
  invalid: "invalid",
  archived: "archived",
  dirty: "dirty",
  stale: "stale",
  empty: "empty",
  duplicateNode: "duplicate-node",
  duplicateTurn: "duplicate-in-turn",
  alreadyInMap: "already-in-map",
  noCurrent: "no-current",
  overBudget: "over-budget",
});

const PIN_HEADER = "dsh-trivium pins (summary; ctx_read for full text):";
const RECALL_HEADER = (form) =>
  `dsh-trivium ${form || "recall"} (summary; ctx_read for full text):`;
const CORRECTION_HEADER =
  "dsh-trivium memory corrections: replace earlier facts with these:";

const MIN_MAP_MATCH_CHARS = 12;

let turnSeq = 0;
const objectTurnKeys = new WeakMap();

function usableTurnValue(value) {
  if (value === undefined || value === null) return "";
  const raw = String(value).trim();
  return raw ? raw : "";
}

/**
 * Stable identity for one user turn.
 *
 * Host ids only — never `Date.now()`, the query text, or a pre-step counter.
 * A tool loop calls pre-step several times for one user message; that reuses
 * the same message object, so the identity stays put. Two messages with
 * identical text but different host ids are two turns.
 *
 * @param messages - messages that make up the upcoming turn.
 * @returns `uid:<host id>`, `obj:<n>` for hosts that expose no id, or "".
 */
export function turnKeyOf(messages = []) {
  const users = (messages || []).filter((m) => m?.source?.kind === "user");
  const last = users[users.length - 1];
  if (!last) return "";
  for (const candidate of [
    last.id,
    last.messageId,
    last.seq,
    last.source?.messageId,
    last.source?.id,
    last.source?.seq,
    last.source?.turn,
    last.turn,
  ]) {
    const value = usableTurnValue(candidate);
    if (value) return `uid:${value}`;
  }
  let token = objectTurnKeys.get(last);
  if (!token) {
    token = `obj:${++turnSeq}`;
    objectTurnKeys.set(last, token);
  }
  return token;
}

function normaliseText(value, max = 200) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Injection body cap. One record must not eat the whole 300-token turn budget,
 * but the old head-only clip silently dropped the tail — which is exactly where
 * "最终验收命令为 X" and other conclusions live (C4 S05: a 500-char fact was
 * injected as background noise and the command never arrived).
 *
 * Decision (2026-10-29): keep the ends, and give the tail the larger share.
 * The middle is what a summary can afford to lose; a full read still needs
 * ctx_read, this only guarantees the fact does not become unusable without it.
 */
export const L0_MAX_CHARS = 200;
const L0_TAIL_SHARE = 0.55;

/** Head + `…` + tail, never longer than `max`. Pure, so it is unit-testable. */
export function preserveEnds(value, max = L0_MAX_CHARS, tailShare = L0_TAIL_SHARE) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const tailLen = Math.min(max - 1, Math.max(1, Math.floor(max * tailShare)));
  const headLen = Math.max(0, max - 1 - tailLen);
  return `${text.slice(0, headLen)}…${text.slice(-tailLen)}`;
}

/** Identity of the entire fact, separate from its bounded displayed summary. */
export function bodyKeyOf(text) {
  let hash = 2166136261;
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  return `${value.length}:${hash.toString(36)}`;
}

function normalisePath(path) {
  if (!Array.isArray(path)) return [];
  return path.map((p) => normaliseText(p, 60)).filter(Boolean).slice(0, 2);
}

/**
 * One structured candidate. Producers (pins.js, store.js) already know the
 * payload; they must hand over fields, not a rendered string.
 */
function shapeCandidate(raw, channel) {
  if (!raw) return null;
  const id = Number(raw.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    channel,
    bodyKey: String(raw.bodyKey || ""),
    type: normaliseText(raw.type, 24) || "unknown",
    l0: preserveEnds(raw.l0 ?? raw.text ?? raw.name, L0_MAX_CHARS),
    until: normaliseText(raw.until, 32),
    stale: raw.stale === true,
    archived: raw.archived === true || raw.status === "archived",
    dirty: raw.dirty === true,
    path: normalisePath(raw.path),
    historical: raw.historical === true,
    supersededBy: Number.isFinite(Number(raw.supersededBy)) ? Number(raw.supersededBy) : null,
    matchedHistory: raw.matchedHistory || null,
    note: normaliseText(raw.note, 120),
    correction: raw.correction === true,
    changeKey: String(raw.changeKey || ""),
    factFingerprint: String(raw.factFingerprint || ""),
    fingerprint: "",
  };
}

/**
 * Cheap stable content fingerprint: node id, normalised L0 **and the state the
 * model was shown**. id+L0 alone meant a deadline or archive flag could change
 * without the next pre-step noticing, because the fingerprint still matched.
 */
export function fingerprintOf(id, l0, record = {}) {
  const state = [
    record.bodyKey || "",
    record.type || "",
    record.until || "",
    record.stale === true ? "s" : "",
    record.archived === true ? "a" : "",
    record.correction === true ? "c" : "",
    record.correction === true ? record.changeKey || "" : "",
  ].join("|");
  let hash = 5381;
  const s = `${String(l0 || "")}\u0000${state}`;
  for (let i = 0; i < s.length; i += 1) hash = ((hash * 33) ^ s.charCodeAt(i)) >>> 0;
  return `${id}:${hash.toString(36)}`;
}

function lineFor(record) {
  if (record.channel === "correction") {
    return `- [${record.type}#${record.id}] ${record.l0}`;
  }
  const flags = [];
  if (record.stale) flags.push(record.until ? `stale until=${record.until}` : "stale");
  if (record.historical) flags.push(record.supersededBy ? `superseded->#${record.supersededBy}` : "superseded");
  if (record.matchedHistory) {
    flags.push(`matched_history=#${record.matchedHistory.from} → current=#${record.matchedHistory.current}`);
  }
  if (record.note) flags.push(record.note);
  const suffix = flags.length ? ` ${flags.join(" ")}` : "";
  const body = record.channel === "pin" ? record.l0 : withPath(record);
  return `- [${record.type}#${record.id}${suffix}] ${body}`;
}

function withPath(record) {
  if (!record.path.length) return record.l0;
  return `${record.l0} (${record.path.join(" | ")})`;
}

function blockTextOf(records, channel, form) {
  if (!records.length) return "";
  const header =
    channel === "pin" ? PIN_HEADER : channel === "correction" ? CORRECTION_HEADER : RECALL_HEADER(form);
  return `${header}\n${records.map((r) => r.line).join("\n")}`;
}

/**
 * Render the current selection. Pins and recall stay separate messages (the
 * client labels them differently) but they are measured together against the
 * one shared budget.
 */
export function renderContextRecords(plan, { form = "recall" } = {}) {
  const pinRecords = plan.records.filter((r) => r.channel === "pin");
  const correctionRecords = plan.records.filter((r) => r.channel === "correction");
  const recallRecords = plan.records.filter((r) => r.channel !== "pin" && r.channel !== "correction");
  const pinText = blockTextOf(pinRecords, "pin", form);
  const correctionText = blockTextOf(correctionRecords, "correction", form);
  const recallText = blockTextOf(recallRecords, "recall", form);
  const pinTokens = pinText ? estimateTokens(pinText) : 0;
  const correctionTokens = correctionText ? estimateTokens(correctionText) : 0;
  const recallTokens = recallText ? estimateTokens(recallText) : 0;
  const total = pinTokens + correctionTokens + recallTokens;
  return {
    pins: { text: pinText, tokens: pinTokens },
    corrections: { text: correctionText, tokens: correctionTokens },
    recall: { text: recallText, tokens: recallTokens },
    total,
    estimatedTokens: total,
  };
}

function measure(records, form) {
  return renderContextRecords({ records }, { form }).total;
}

/**
 * Budget normalisation.
 *
 * An explicit 0 means "send nothing". It must never be turned back into the
 * default 300 by `Number(budget) || DEFAULT`; only a missing value is default.
 */
function normaliseBudget(value) {
  if (value === undefined || value === null || value === "") return TURN_ADDITIONAL_BUDGET;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/**
 * Copy the current node's own fields onto the record.
 *
 * Without this, a hit on an old version only had its id swapped, so the model
 * saw the new id with the superseded body — the exact defect in REVIEW P1-2.
 */
function applyProjection(record, resolved, { remapped = false } = {}) {
  if (resolved.type !== undefined && resolved.type !== null && String(resolved.type).trim()) {
    record.type = normaliseText(resolved.type, 24) || record.type;
  }
  // Same cap and the same end-preserving rule: a revision projection must not
  // quietly restore the head-only clip the candidate shaping just removed.
  if (resolved.bodyKey !== undefined) record.bodyKey = String(resolved.bodyKey);
  if (resolved.l0 !== undefined) record.l0 = preserveEnds(resolved.l0, L0_MAX_CHARS);
  if (resolved.until !== undefined) record.until = normaliseText(resolved.until, 32);
  if (resolved.stale !== undefined) record.stale = resolved.stale === true;
  if (resolved.archived !== undefined) record.archived = resolved.archived === true;
  if (resolved.dirty !== undefined) record.dirty = resolved.dirty === true;
  if (Array.isArray(resolved.path)) record.path = normalisePath(resolved.path);
  // A search path describes the candidate node; it cannot be reused for a
  // different (current) node, so it is dropped instead of being faked.
  else if (remapped) record.path = [];
}

/**
 * Turn one round of candidates into the exact records to inject.
 *
 * Order is corrections → pins → recall. Correct already-delivered facts before
 * repeating pinned content; recall only gets what is left. A record that does not
 * fit is dropped with `over-budget` instead of being clipped mid-record.
 *
 * @param pins - structured pin candidates, user order.
 * @param recall - structured recall candidates, ranked.
 * @param corrections - short staleness/supersession notices for this turn.
 * @param resolveCurrent - optional `(id) => ({id, payload, archived, stale})`;
 *   M2 plugs the supersedes chain in here. Without it nothing is remapped.
 * @param delivered - fingerprints already delivered in this turn.
 * @param mapText - the short map text when it arrived in this same turn.
 */
export function selectContextRecords({
  pins = [],
  recall = [],
  corrections = [],
  budget = TURN_ADDITIONAL_BUDGET,
  form = "recall",
  now,
  resolveCurrent = null,
  delivered = null,
  mapText = "",
} = {}) {
  const cap = normaliseBudget(budget);
  const at = now instanceof Date ? now : new Date();
  const deliveredSet = delivered instanceof Set ? delivered : new Set();
  const mapBlob = String(mapText || "");
  const dropped = [];
  const deferred = [];
  const byId = new Map();
  const ordered = [];

  const drop = (candidate, reason, channel) =>
    dropped.push({ id: bestId(candidate), channel, reason });

  const accept = (raw, channel) => {
    const record = shapeCandidate(raw, channel);
    if (!record) {
      drop(raw, DROP_REASONS.invalid, channel);
      return;
    }

    /*
     * A correction is a short notice that a fact the model was already given
     * changed. It is deliberately NOT a recall candidate: it must survive the
     * archived/stale filters (those describe the fact and would drop the
     * notice), must not be remapped (the note names the new id itself), and its
     * body is the notice, never the old or new full text.
     */
    if (record.correction) {
      if (!record.l0) {
        drop(record, DROP_REASONS.empty, channel);
        return;
      }
      record.channel = "correction";
      record.channels = ["correction"];
      record.fingerprint = fingerprintOf(record.id, record.l0, record);
      record.line = lineFor(record);
      if (deliveredSet.has(record.fingerprint)) {
        drop(record, DROP_REASONS.duplicateTurn, record.channel);
        return;
      }
      if (mapBlob && mapCoversRecord(mapBlob, record.l0)) {
        drop(record, DROP_REASONS.alreadyInMap, record.channel);
        return;
      }
      const key = `correction:${record.id}`;
      if (byId.has(key)) {
        drop(record, DROP_REASONS.duplicateNode, record.channel);
        return;
      }
      byId.set(key, record);
      ordered.push(record);
      return;
    }

    const originalId = record.id;
    let targetId = originalId;
    if (record.channel !== "pin" && typeof resolveCurrent === "function") {
      let resolved = null;
      try {
        resolved = resolveCurrent(record.id);
      } catch {
        resolved = null;
      }
      if (resolved === null || resolved === undefined) {
        drop(record, DROP_REASONS.noCurrent, channel);
        return;
      }
      const nextId = Number(resolved.currentId ?? resolved.id ?? record.id);
      if (!Number.isFinite(nextId)) {
        drop(record, DROP_REASONS.noCurrent, channel);
        return;
      }
      const remapped = nextId !== originalId;
      // The successor is gone, archived or expired: do not resurrect the old
      // node, and do not inject the dead chain either.
      if (remapped) {
        if (resolved.archived === true || resolved.stale === true) {
          drop(record, resolved.archived === true ? DROP_REASONS.archived : DROP_REASONS.stale, channel);
          return;
        }
        record.matchedHistory = { from: originalId, current: nextId };
        targetId = nextId;
        record.id = nextId;
      }
      // Body, type, deadline and state all come from the node that will be
      // rendered. The matched candidate only supplies the history pointer.
      applyProjection(record, resolved, { remapped });
    } else if (record.channel !== "pin" && record.stale) {
      // Recall never injects expired nodes; pinned chips may be stale (the user
      // chose them) and carry a `stale until=` flag instead.
      drop(record, DROP_REASONS.stale, channel);
      return;
    }

    if (!record.l0) {
      drop(record, DROP_REASONS.empty, channel);
      return;
    }
    if (record.archived) {
      drop(record, DROP_REASONS.archived, channel);
      return;
    }
    if (record.dirty) {
      drop(record, DROP_REASONS.dirty, channel);
      return;
    }
    if (record.channel !== "pin" && record.stale) {
      drop(record, DROP_REASONS.stale, channel);
      return;
    }

    const existing = byId.get(targetId);
    if (existing) {
      if (!existing.channels.includes(record.channel)) existing.channels.push(record.channel);
      // A node already present keeps its first (higher-priority) rendering.
      drop(record, DROP_REASONS.duplicateNode, channel);
      return;
    }

    record.channel = record.channel === "pin" ? "pin" : channel;
    record.channels = [record.channel];
    record.fingerprint = fingerprintOf(record.id, record.l0, record);
    record.line = lineFor(record);
    if (deliveredSet.has(record.fingerprint)) {
      drop(record, DROP_REASONS.duplicateTurn, record.channel);
      return;
    }
    if (mapBlob && mapCoversRecord(mapBlob, record.l0)) {
      drop(record, DROP_REASONS.alreadyInMap, record.channel);
      return;
    }
    byId.set(targetId, record);
    ordered.push(record);
  };

  // Correct already-seen facts before repeating the user's pin selection.
  // Otherwise fixed pins can consume the same budget every turn indefinitely.
  for (const correction of corrections) accept(correction, "correction");
  for (const pin of pins) accept(pin, "pin");
  for (const hit of recall) accept(hit, "recall");

  // Greedy fill in priority order: a later, shorter record may still fit after
  // a long one is rejected, so keep trying instead of stopping at the first miss.
  const kept = [];
  for (const record of ordered) {
    const attempt = [...kept, record];
    if (measure(attempt, form) <= cap) kept.push(record);
    else if (record.channel === "pin") {
      // An explicit pin that cannot fit is deferred, not silently mixed in.
      drop(record, DROP_REASONS.overBudget, record.channel);
      deferred.push({ id: record.id, channel: record.channel, reason: DROP_REASONS.overBudget });
    } else {
      drop(record, DROP_REASONS.overBudget, record.channel);
      deferred.push({ id: record.id, channel: record.channel, reason: DROP_REASONS.overBudget });
    }
  }

  /*
   * Give every kept record its real cost. The marginal (prefix) cost is what the
   * text grows by when this record is appended, so `sum(tokens) === total` by
   * construction and the ledger never has to guess. Header and wrapper cost is
   * charged to the first record of each block, which is why it is not divided
   * evenly: that would make the numbers look nicer and be wrong.
   */
  let previous = 0;
  for (let i = 0; i < kept.length; i += 1) {
    const cumulative = measure(kept.slice(0, i + 1), form);
    kept[i].tokens = Math.max(0, cumulative - previous);
    previous = cumulative;
  }

  const rendered = renderContextRecords({ records: kept }, { form });
  return {
    budget: cap,
    tokens: rendered.total,
    estimatedTokens: rendered.total,
    records: kept,
    dropped,
    deferred,
    at: at.toISOString(),
  };
}

function bestId(candidate) {
  const id = Number(candidate?.id);
  return Number.isFinite(id) ? id : null;
}

/**
 * Cross-stage duplicate: the map is labels only, so an identical long body is
 * the same fact and must not be repeated. A short label match is not "full
 * text already in context" and still gets its summary.
 */
function mapCoversRecord(mapText, l0) {
  const body = normaliseText(l0, 400);
  if (body.length < MIN_MAP_MATCH_CHARS) return false;
  return mapText.includes(body);
}

/** Clip one already-selected block; used by the debug/UI surface, not injection. */
export function clipBlock(text, budget = TURN_ADDITIONAL_BUDGET) {
  return clipToTokenBudget(text, budget);
}
