/** Per-session memory chips. Pins inject into the next turn of the current session. */

import { listEpisodeRecords } from "./episode.js";
import { clipToTokenBudget, estimateTokens } from "./tokens.js";
import { pinsOf, writePins } from "./settings.js";
import { suggestedNeighborIds } from "./store.js";

export const PIN_TOKEN_BUDGET = 300;
export const CHIP_TYPES = Object.freeze(["preference", "decision", "entity"]);

const CHIP_SET = new Set(CHIP_TYPES);

function l0Of(payload) {
  return String(payload?.text || payload?.name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function chipMatches(row, q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return true;
  return [row.name, row.text, row.type, row.l0].some((s) => String(s || "").toLowerCase().includes(needle));
}

function episodeSuggestText(db, sessionId) {
  const rows = listEpisodeRecords(db, sessionId);
  const tail = rows.find((e) => e.kind === "tail");
  const lastCheck = [...rows].reverse().find((e) => e.kind === "checkpoint");
  const tailText = String(tail?.summary || tail?.text || "").trim();
  if (tailText && tailText !== "当前" && tailText !== "分叉") return tailText;
  return String(lastCheck?.summary || lastCheck?.text || tailText || "").trim();
}

function suggestedChipIdSet(db, sessionId) {
  const sid = String(sessionId || "");
  if (!sid) return new Set();
  const text = episodeSuggestText(db, sid);
  if (!text) return new Set();
  const ids = new Set();
  for (const nid of suggestedNeighborIds(db, text)) {
    const payload = db.get(Number(nid))?.payload || {};
    if (payload.status === "archived") continue;
    if (!CHIP_SET.has(payload.type)) continue;
    ids.add(Number(nid));
  }
  return ids;
}

function parentSessionOf(db, sessionId) {
  const rows = listEpisodeRecords(db, sessionId);
  const tail = rows.find((e) => e.kind === "tail");
  for (const e of tail?.edges || []) {
    if (e.label !== "forks_from") continue;
    const payload = db.get(Number(e.targetId ?? e.target_id))?.payload;
    if (payload?.sessionId) return String(payload.sessionId);
  }
  return "";
}

export function listChips(db, { q, sessionId } = {}) {
  const suggested = suggestedChipIdSet(db, sessionId);
  const rows = [];
  for (const id of db.allNodeIds?.() || []) {
    const payload = db.get(id)?.payload || {};
    if (payload.status === "archived") continue;
    if (!CHIP_SET.has(payload.type)) continue;
    const row = {
      id: Number(id),
      type: payload.type,
      name: payload.name || "",
      text: payload.text || "",
      l0: l0Of(payload),
      updatedAt: payload.updatedAt || payload.createdAt || "",
      suggested: suggested.has(Number(id)),
    };
    if (!chipMatches(row, q)) continue;
    rows.push(row);
  }
  return rows.sort((a, b) => {
    if (a.suggested !== b.suggested) return a.suggested ? -1 : 1;
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

export function livePinIds(db, sessionId) {
  const ids = pinsOf(sessionId);
  return ids.filter((id) => {
    const payload = db.get(Number(id))?.payload;
    return payload && payload.status !== "archived" && CHIP_SET.has(payload.type);
  });
}

export function prunePins(db, sessionId) {
  const ids = pinsOf(sessionId);
  const kept = livePinIds(db, sessionId);
  if (kept.length !== ids.length) writePins(sessionId, kept);
  return kept;
}

export function buildPinInject(db, sessionId, budget = PIN_TOKEN_BUDGET) {
  const ids = prunePins(db, sessionId);
  if (!ids.length) return { text: "", tokens: 0, clipped: false, ids: [] };
  const lines = ["dsh-trivium pins (L0 only; use ctx_read for full text):"];
  const used = [];
  for (const id of ids) {
    const payload = db.get(Number(id))?.payload;
    if (!payload) continue;
    lines.push(`- [${payload.type}#${id}] ${l0Of(payload)}`);
    used.push(Number(id));
  }
  const full = lines.join("\n");
  const cap = Math.max(1, Number(budget) || PIN_TOKEN_BUDGET);
  const text = clipToTokenBudget(full, cap);
  return {
    text,
    tokens: estimateTokens(text),
    clipped: estimateTokens(full) > cap,
    ids: used,
  };
}

export function setSessionPins(db, sessionId, ids) {
  writePins(sessionId, ids);
  return buildPinInject(db, sessionId);
}

export function readSessionPins(db, sessionId) {
  return buildPinInject(db, sessionId);
}

/** Copy live (unarchived chip-type) pin ids. Child stays empty unless this is called. */
export function copyPins(db, fromSessionId, toSessionId) {
  const ids = livePinIds(db, fromSessionId);
  writePins(toSessionId, ids);
  return ids;
}

/**
 * POST /pins body. inherit defaults false — `{ sessionId, ids }` still replaces.
 * inherit true copies live ids from inheritFrom (or graph parent), then merges ids if given.
 */
export function applyPinsUpdate(db, body = {}) {
  const sessionId = String(body.sessionId || "");
  if (body.inherit === true) {
    const from = String(body.inheritFrom || body.parentSessionId || parentSessionOf(db, sessionId) || "");
    const copied = from && from !== sessionId ? copyPins(db, from, sessionId) : livePinIds(db, sessionId);
    if (Array.isArray(body.ids)) {
      const merged = [...new Set([...copied, ...body.ids.map(Number).filter((id) => Number.isFinite(id))])];
      return setSessionPins(db, sessionId, merged);
    }
    return readSessionPins(db, sessionId);
  }
  return setSessionPins(db, sessionId, Array.isArray(body.ids) ? body.ids : []);
}
