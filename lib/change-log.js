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

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { sanitizeForWrite } from "./hygiene.js";
import { nowIso } from "./schema.js";
import { acquireWorkspaceLock } from "./workspace-lock.js";

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

// One constant-size marker per workspace records an unrecoverable gap without
// storing conversation text. Never remove it just because a later write works.
export function auditGapPath(cwd) {
  return join(cwd, ".dsh", "trivium-changes.incomplete");
}

function markAuditGap(cwd) {
  const file = auditGapPath(cwd);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(file, "wx");
    closeSync(fd);
    return true;
  } catch (err) {
    return err?.code === "EEXIST";
  }
}

function auditIncomplete(cwd) {
  try { statSync(auditGapPath(cwd)); return true; }
  catch (err) { if (err?.code === "ENOENT") return false; throw err; }
}

function redact(text) {
  const value = String(text || "");
  if (!value) return "";
  const gate = sanitizeForWrite(value);
  return gate.ok ? value : REDACTED;
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function normalizeRow(row) {
  const reason = String(row?.reason || "").trim();
  const entry = {
    at: String(row?.at || nowIso()),
    reason: Object.values(CHANGE_REASONS).includes(reason) ? reason : CHANGE_REASONS.rejected,
    // Callers normally provide opaque IDs; reject any sensitive-looking input
    // here too, so an accidentally embedded value is not written in plaintext.
    opId: row?.opId ? (redact(row.opId) === REDACTED ? digest(row.opId) : String(row.opId)) : "",
    nodeId: Number.isFinite(Number(row?.nodeId)) ? Number(row.nodeId) : null,
    byId: Number.isFinite(Number(row?.byId)) ? Number(row.byId) : null,
    action: String(row?.action || "").slice(0, 24),
    type: String(row?.type || "").slice(0, 24),
    preview: redact(row?.preview).slice(0, 120),
    detail: redact(row?.detail).slice(0, 120),
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
  // A losing database writer also records lock-busy, so the main workspace
  // lock cannot protect the audit file. Serialize append + trim separately.
  const lock = acquireWorkspaceLock(cwd, { file: `${file}.lock` });
  if (!lock.ok) return { ok: false, written: 0, code: "audit-lock-busy", gapMarked: markAuditGap(cwd) };
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, list.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    return trim(file);
  } catch (err) {
    return { ok: false, written: 0, code: "audit-write-failed", gapMarked: markAuditGap(cwd), error: String(err?.message || err) };
  } finally {
    lock.release();
  }
}

function trim(file) {
  const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
  // The marker is metadata, not one of the retained entries. Carry the prior
  // count forward when it ages out, otherwise repeated trims hide old loss.
  let previousDropped = 0;
  const records = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { /* keep malformed rows for diagnosis */ }
    if (row?.reason === "trim") {
      const count = Number(row.dropped);
      if (Number.isFinite(count) && count > 0) previousDropped += count;
    } else records.push(line);
  }
  if (records.length <= CHANGE_LOG_LIMIT) return { ok: true, written: 0, trimmed: 0 };
  const drop = records.length - CHANGE_LOG_LIMIT;
  const kept = records.slice(drop);
  const marker = JSON.stringify({ at: nowIso(), reason: "trim", dropped: previousDropped + drop });
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
  const requested = Number(limit);
  const cap = Number.isFinite(requested) ? Math.max(1, Math.min(Math.floor(requested), CHANGE_LOG_LIMIT)) : 50;
  const file = changesPath(cwd);
  try {
    const incomplete = auditIncomplete(cwd);
    let raw;
    try { raw = readFileSync(file, "utf8"); }
    catch (err) {
      if (err?.code === "ENOENT") return { entries: [], trimmed: 0, total: 0, limit: cap, incomplete, ok: true };
      throw err;
    }
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    let trimmed = 0;
    const entries = [];
    const seen = new Set();
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { throw new Error("invalid change log row"); }
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid change log row");
      if (row?.reason === "trim") { trimmed += Number(row.dropped || 0); continue; }
      // One operation is recorded once, even if the same window is reprocessed.
      if (row?.opId) {
        if (seen.has(row.opId)) continue;
        seen.add(row.opId);
      }
      entries.push(row);
    }
    entries.reverse();
    return { ok: true, entries: entries.slice(0, cap), total: entries.length, trimmed, limit: cap, incomplete };
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
export function rowsForExtract({ result, sessionId = "", turns = [], sourceOf = () => null, at = nowIso() } = {}) {
  const rows = [];
  const sid = String(sessionId || "");
  // Stable across replay of the same window, distinct across later windows.
  // Store only the digest: a window may contain a rejected credential.
  const windowKey = Array.isArray(turns) && turns.length
    ? digest(JSON.stringify(turns.map((turn) => [turn?.role || "", turn?.messageId || "", turn?.seq ?? null, turn?.at || "", turn?.text || ""])))
    : "";
  const op = (...parts) => digest(JSON.stringify([sid, windowKey, ...parts]));
  for (const item of result?.applied || []) {
    const source = sourceOf(item.id) || null;
    rows.push({
      at,
      reason: item.action === "merge" ? CHANGE_REASONS.merged : CHANGE_REASONS.written,
      // Replaying a successful insert can report a merge for the same node;
      // that is still one applied decision for this extraction window.
      opId: op("applied", item.id),
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
        opId: op("sup", item.from, item.to),
        nodeId: item.to,
        byId: item.from,
        detail: item.label || "",
      });
    } else if (item?.pending) {
      rows.push({
        at,
        reason: CHANGE_REASONS.pendingReview,
        opId: op("pending", item.from),
        nodeId: item.from,
        detail: item.reason || "",
      });
    }
  }
  (result?.skipped || []).forEach((item, index) => {
    rows.push({
      at,
      reason: CHANGE_REASONS.rejected,
      opId: op("rej", item.reason, index),
      type: item.type,
      preview: item.preview,
      detail: item.reason,
    });
  });
  (result?.adjusted || []).forEach((item, index) => {
    rows.push({
      at,
      reason: CHANGE_REASONS.dateAdjusted,
      opId: op("date", index, item.preview),
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
