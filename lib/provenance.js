/**
 * Provenance: where a memory came from.
 *
 * The plugin only ever has the fields it actually recorded. There is no host
 * API that can turn a node id back into a message, so this module never
 * reconstructs a session, an author or a quote — a record without `source`
 * reports "not recorded" instead of guessing.
 *
 * Everything here is a projection for the management UI; none of it is injected
 * into model context and none of it leaves the current workspace.
 */

import { listEpisodeRecords } from "./episode.js";

/** Short preview cap for a stored quote, in code points. */
export const QUOTE_PREVIEW_MAX = 240;

export const SOURCE_KINDS = Object.freeze(["manual", "extract", "chip", "import", "tool"]);

/** Existing writes carried `via`; map them onto the newer `kind`. */
const KIND_BY_VIA = Object.freeze({
  "chip-add": "chip",
  "workbuddy-import": "import",
  "external-import": "import",
  extract: "extract",
  tool: "tool",
  manual: "manual",
});

const SESSION_SEEN = new Set();

/** Called on every session we observe, so a recent one can be reported as live. */
export function noteObservedSession(sessionId) {
  const id = String(sessionId || "").trim();
  if (id) SESSION_SEEN.add(id);
  if (SESSION_SEEN.size > 200) {
    const first = SESSION_SEEN.values().next().value;
    SESSION_SEEN.delete(first);
  }
}

export function resetObservedSessions() {
  SESSION_SEEN.clear();
}

/**
 * Plain text for display: control characters and bidi overrides removed.
 *
 * HTML/script markup is deliberately NOT stripped here — the client renders
 * this as a text node, so it cannot execute, and losing it would hide what the
 * user actually stored. Write-time hygiene still applies before anything is
 * saved.
 */
export function plainText(value, max = QUOTE_PREVIEW_MAX) {
  const raw = String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function str(value, max = 200) {
  const raw = plainText(value, max);
  return raw;
}

/**
 * Project a stored `source`. Optional fields may be missing; nothing is inferred.
 *
 * @returns `{ recorded: false }` when the payload carries no locatable source.
 */
export function normalizeSource(source) {
  if (!source || typeof source !== "object") return { recorded: false };
  const via = str(source.via, 40);
  const rawKind = str(source.kind, 24).toLowerCase();
  const kind = SOURCE_KINDS.includes(rawKind) ? rawKind : KIND_BY_VIA[via] || "";
  const sessionId = str(source.sessionId, 120);
  const messageId = str(source.messageId ?? source.eventSeq ?? "", 120);
  const quote = plainText(source.quote);
  const capturedAt = str(source.capturedAt, 40);
  const importPath = str(source.importPath, 400);
  const rawSeq = source.seq ?? (typeof source.eventSeq === "number" ? source.eventSeq : null);
  const seq = rawSeq === null || rawSeq === undefined || rawSeq === "" || !Number.isFinite(Number(rawSeq)) ? null : Number(rawSeq);
  const at = str(source.at, 40);
  const rawRole = str(source.role, 16).toLowerCase();
  const role = ["user", "assistant", "tool"].includes(rawRole) ? rawRole : "unknown";
  const rawMatch = str(source.quoteMatch, 12).toLowerCase();
  const quoteMatch = ["exact", "partial", "none"].includes(rawMatch) ? rawMatch : quote ? "unknown" : "none";
  const recorded = Boolean(kind || sessionId || messageId || quote || capturedAt || importPath || via || seq !== null);
  if (!recorded) return { recorded: false };
  return {
    recorded: true,
    kind,
    via,
    sessionId,
    messageId,
    // A locator is only "known" when the host gave us one; older records say so.
    locatorKnown: Boolean(messageId) || seq !== null,
    seq,
    at,
    role,
    quote,
    quoteMatch,
    // Nothing can re-open the original message from here; never pretend otherwise.
    hostText: "unavailable",
    capturedAt,
    importPath,
  };
}

/**
 * Is this session still reachable from this workspace?
 *
 * The plugin has two honest signals: an episode node recorded for that session
 * in this workspace, or having observed the session in this process. Anything
 * else is reported as unverifiable rather than assumed alive.
 */
export function sessionStateOf(db, sessionId) {
  const sid = String(sessionId || "");
  if (!sid) return "unknown";
  try {
    if (listEpisodeRecords(db, sid).length) return "seen";
  } catch {
    // an unreadable episode index must not turn into a false positive
  }
  return SESSION_SEEN.has(sid) ? "seen" : "unknown";
}

/**
 * `status`: `missing` (nothing recorded), `recorded` (locatable), or
 * `unavailable` (fields exist but the session cannot be confirmed).
 */
export function provenanceOf(db, id) {
  const node = db.get(Number(id));
  if (!node) return null;
  const source = normalizeSource(node.payload?.source);
  if (!source.recorded) {
    return {
      ok: true,
      id: Number(id),
      status: "missing",
      message: "此条目没有可定位的来源。",
      jump: false,
      jumpReason: "",
      source: null,
    };
  }
  const state = source.sessionId ? sessionStateOf(db, source.sessionId) : "unknown";
  const unavailable = Boolean(source.sessionId) && state !== "seen";
  const locatorKnown = source.locatorKnown === true;
  return {
    ok: true,
    id: Number(id),
    status: unavailable ? "unavailable" : "recorded",
    message: unavailable
      ? "会话已不可用，保留现有摘录。"
      : locatorKnown
        ? "已记录源事件（会话 / 消息标识 / 源时间）；宿主未提供跳转接口。"
        : "来源已记录，但宿主未提供可定位的消息标识，已保留摘录。",
    locatorKnown,
    sessionState: state,
    // No deep link is invented: the host exposes no session locator here.
    jump: false,
    jumpReason: "host has no session locator API",
    quotePreviewMax: QUOTE_PREVIEW_MAX,
    source,
  };
}
