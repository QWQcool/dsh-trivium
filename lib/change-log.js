/**
 * Bounded change log for memory writes.
 *
 * Every write decision the plugin makes is recorded once, with a stable reason
 * code, the node and (when known) the source event. The log is:
 *   - bounded: a fixed number of entries, oldest trimmed first, and a trim marker
 *     so the UI can say "beyond retention" instead of pretending completeness;
 *   - redacted before it is written: a value that fails the write gate never
 *     reaches the file, so hiding it in the UI is not the safety boundary;
 *   - never injected into model context: it is a management surface only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeForWrite } from "./hygiene.js";
import { nowIso } from "./schema.js";

/** Entries kept per workspace. Older ones are trimmed, never silently lost. */
export const CHANGE_LOG_LIMIT = 200;

/** Stable reason codes. Display text is chosen by the client, not stored here. */
export const CHANGE_REASONS = Object.freeze({
  written: "written",
  merged: "merged",
  superseded: "superseded",
  rejected: "rejected",
  dateAdjusted: "date-adjusted",
  pendingReview: "pending-review",
  supersedeFailed: "supersede-failed",
  replayTimeout: "replay-timeout",
  lockBusy: "lock-busy",
});

const REDACTED = "<redacted>";

export function changesPath(cwd) {
  return join(cwd, ".dsh", "trivium-changes.jsonl");
}

function redact(text) {
  const value = String(text || "");
  if (!value) return "";
  const gate = sanitizeForWrite(value);
  return gate.ok ? value : REDACTED;
}

function normalizeRow(row) {
  const reason = String(row?.reason || "").trim();
  const entry = {
    at: String(row?.at || nowIso()),
    reason: Object.values(CHANGE_REASONS).includes(reason) ? reason : CHANGE_REASONS.rejected,
    opId: String(row?.opId || ""),
    nodeId: Number.isFinite(Number(row?.nodeId)) ? Number(row.nodeId) : null,
    byId: Number.isFinite(Number(row?.byId)) ? Number(row.byId) : null,
    action: String(row?.action || "").slice(0, 24),
    type: String(row?.type || "").slice(0, 24),
    preview: redact(row?.preview).slice(0, 120),
    detail: String(row?.detail || "").slice(0, 120),
    source: row?.source && typeof row.source === "object"
      ? {
        role: String(row.source.role || "unknown"),
        messageId: row.source.messageId ? String(row.source.messageId) : null,
        seq: Number.isFinite(Number(row.source.seq)) ? Number(row.source.seq) : null,
        quoteMatch: String(row.source.quoteMatch || "none"),
      }
      : null,
  };
  return entry;
}

/**
 * Append entries, then trim to the limit.
 *
 * A trim writes a marker so a reader can distinguish "nothing happened" from
 * "older records were removed". Failures are reported to the caller, which must
 * not claim the audit is complete when it is not.
 */
export function noteChanges(cwd, rows = []) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map(normalizeRow);
  if (!list.length) return { ok: true, written: 0, trimmed: 0 };
  const file = changesPath(cwd);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, list.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    return trim(file);
  } catch (err) {
    return { ok: false, written: 0, error: String(err?.message || err) };
  }
}

function trim(file) {
  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= CHANGE_LOG_LIMIT) return { ok: true, written: 0, trimmed: lines.length };
  const drop = lines.length - CHANGE_LOG_LIMIT;
  const kept = lines.slice(drop);
  const marker = JSON.stringify({ at: nowIso(), reason: "trim", dropped: drop });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, [marker, ...kept].join("\n") + "\n", "utf8");
  renameSync(tmp, file);
  return { ok: true, written: kept.length, trimmed: drop };
}

/**
 * Read the newest entries first. `trimmed` reports how many records fell out of
 * retention so the UI can say so; it is never presented as a complete history.
 */
export function readChanges(cwd, { limit = 50 } = {}) {
  const file = changesPath(cwd);
  if (!existsSync(file)) return { entries: [], trimmed: 0, total: 0, ok: true };
  try {
    const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
    let trimmed = 0;
    const entries = [];
    const seen = new Set();
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row?.reason === "trim") { trimmed += Number(row.dropped || 0); continue; }
      // One operation is recorded once, even if the same window is reprocessed.
      if (row?.opId) {
        if (seen.has(row.opId)) continue;
        seen.add(row.opId);
      }
      entries.push(row);
    }
    entries.reverse();
    const cap = Math.max(1, Math.min(Number(limit) || 50, CHANGE_LOG_LIMIT));
    return { ok: true, entries: entries.slice(0, cap), total: entries.length, trimmed, limit: cap };
  } catch (err) {
    return { ok: false, entries: [], trimmed: 0, total: 0, error: String(err?.message || err) };
  }
}

/**
 * Map one extraction result onto log rows.
 *
 * `sourceOf(nodeId)` lets the caller attach the stored provenance without this
 * module importing the store. Every row carries an `opId` so reprocessing the
 * same window does not duplicate the same decision.
 */
export function rowsForExtract({ result, sessionId = "", sourceOf = () => null, at = nowIso() } = {}) {
  const rows = [];
  const sid = String(sessionId || "");
  for (const item of result?.applied || []) {
    const source = sourceOf(item.id) || null;
    rows.push({
      at,
      reason: item.action === "merge" ? CHANGE_REASONS.merged : CHANGE_REASONS.written,
      opId: `${sid}:${item.action}:${item.id}`,
      nodeId: item.id,
      action: item.action,
      type: item.type,
      preview: item.text,
      source,
    });
  }
  for (const item of result?.superseded || []) {
    if (item?.to) {
      rows.push({
        at,
        reason: CHANGE_REASONS.superseded,
        opId: `${sid}:sup:${item.from}:${item.to}`,
        nodeId: item.to,
        byId: item.from,
        detail: item.label || "",
      });
    } else if (item?.pending) {
      rows.push({
        at,
        reason: CHANGE_REASONS.pendingReview,
        opId: `${sid}:pending:${item.from}`,
        nodeId: item.from,
        detail: item.reason || "",
      });
    }
  }
  (result?.skipped || []).forEach((item, index) => {
    rows.push({
      at,
      reason: CHANGE_REASONS.rejected,
      opId: `${sid}:rej:${item.reason}:${index}`,
      type: item.type,
      preview: item.preview,
      detail: item.reason,
    });
  });
  (result?.adjusted || []).forEach((item, index) => {
    rows.push({
      at,
      reason: CHANGE_REASONS.dateAdjusted,
      opId: `${sid}:date:${index}:${item.preview}`,
      type: item.type,
      preview: item.preview,
      detail: (item.removed || []).join(","),
    });
  });
  return rows;
}

/** Bilingual display text; the client picks one, the log stays language-free. */
export const CHANGE_LABELS = Object.freeze({
  written: { en: "Written", zh: "已写入" },
  merged: { en: "Merged", zh: "已合并" },
  superseded: { en: "Superseded", zh: "已替代" },
  rejected: { en: "Refused", zh: "已拒绝" },
  "date-adjusted": { en: "Date adjusted", zh: "日期已调整" },
  "pending-review": { en: "Needs review", zh: "待确认" },
  "supersede-failed": { en: "Replace failed", zh: "替代失败" },
  "replay-timeout": { en: "Recovery timed out", zh: "恢复超时" },
  "lock-busy": { en: "Another session is writing", zh: "另一会话正在写入" },
});
