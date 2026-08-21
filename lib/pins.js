/** Per-session memory chips. Pins inject into the next turn of the current session. */

import { listEpisodeRecords } from "./episode.js";
import { clipToTokenBudget, estimateTokens } from "./tokens.js";
import { pinsOf, writePins } from "./settings.js";
import { archiveNode, deleteNode, suggestedNeighborIds } from "./store.js";
import { applyCandidates, DECISION_CUES, EXPLICIT_LINE_CHARS, firstEntityName } from "./extract.js";
import { clip } from "./schema.js";
import { parseUntilFromText } from "./until.js";

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

/** Markdown is only markup. Strip fences, emphasis, links, headings, list markers. */
export function stripMarkdownMarkup(text) {
  let s = String(text || "");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/_([^_]+)_/g, "$1");
  s = s.replace(/^#{1,6}\s+/gm, "");
  s = s.replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/gm, "");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * One submit → one chip. Long paste stays one node; markdown is stripped, not split.
 */
export function splitChipDraft(text) {
  const body = stripMarkdownMarkup(String(text || "").replace(/\r\n/g, "\n"));
  return body ? [body] : [];
}

function candidateFromChipLine(body) {
  const text = stripMarkdownMarkup(body);
  if (!text) return null;
  const name = firstEntityName(text);
  if (DECISION_CUES.test(text)) {
    return {
      skip: null,
      candidates: [
        {
          type: "decision",
          name,
          text: clip(text, EXPLICIT_LINE_CHARS),
          until: parseUntilFromText(text),
          linkName: name,
          linkLabel: "decided",
          quote: clip(text, 120),
          via: "chip-add",
        },
      ],
    };
  }
  return {
    skip: null,
    candidates: [
      {
        type: "preference",
        name,
        text: clip(text, EXPLICIT_LINE_CHARS),
        linkName: name,
        linkLabel: "about",
        quote: clip(text, 120),
        via: "chip-add",
      },
    ],
  };
}

export function addChipsFromText(db, text, { sessionId = "", pin = true } = {}) {
  const lines = splitChipDraft(text);
  if (!lines.length) return { ok: false, message: "空内容", ids: [], skipped: 0 };
  const candidates = [];
  for (const line of lines) {
    const parsed = candidateFromChipLine(line);
    if (!parsed) continue;
    candidates.push(...parsed.candidates);
  }
  if (!candidates.length) {
    return { ok: false, message: "没有可写入的条目", ids: [], skipped: 0 };
  }
  const applied = applyCandidates(db, candidates, { sessionId, via: "chip-add" });
  const ids = [...new Set(applied.map((a) => Number(a.id)).filter((id) => Number.isFinite(id)))];
  if (pin && sessionId && ids.length) {
    const merged = [...new Set([...livePinIds(db, sessionId), ...ids])];
    setSessionPins(db, sessionId, merged);
  }
  return {
    ok: ids.length > 0,
    message: ids.length ? `已写入 ${ids.length} 条` : "没有新节点",
    ids,
    applied: applied.length,
    skipped: Math.max(0, lines.length - ids.length),
  };
}

export function batchChipAction(db, { action, ids, sessionId = "" } = {}) {
  const verb = action === "delete" ? "delete" : "archive";
  const list = [...new Set((ids || []).map(Number).filter((id) => Number.isFinite(id)))];
  let count = 0;
  for (const id of list) {
    const ok = verb === "delete" ? deleteNode(db, id) : archiveNode(db, id);
    if (ok) count += 1;
  }
  if (sessionId) prunePins(db, sessionId);
  return { ok: count > 0 || list.length === 0, action: verb, count, ids: list };
}
