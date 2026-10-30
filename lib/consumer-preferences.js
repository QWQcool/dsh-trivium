/**
 * Consumer preference snapshots (E0 of the Bilibili adapter).
 *
 * Trivium owns the facts; a consumer (first: the Bilibili duty task) is allowed to
 * read a small, explicitly approved, read-only snapshot. Nothing here writes facts,
 * impersonates a consumer, or talks to any platform.
 *
 * Deliberate limits:
 *  - every exported fact must be named in the binding by the user; there is no
 *    "export everything that looks relevant" mode;
 *  - budget overflow is an error, never a silent truncation;
 *  - a digest only proves content equality, not identity;
 *  - the machine layer stays out of the model-facing block.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentHeadOf } from "./revisions.js";
import { dbFingerprint } from "./store.js";
import { estimateTokens } from "./tokens.js";
import { payloadDirtyReason } from "./hygiene.js";

export const PREF_SCHEMA = "consumer-preferences/v1";
export const PREF_MAX_FACTS = 8;
export const PREF_TOKEN_BUDGET = 300;
export const PREF_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const CONSUMER_DIR = join(".dsh", "consumer-preferences");

export const PREF_CODES = Object.freeze({
  bindingMissing: "binding-missing",
  bindingRevoked: "binding-revoked",
  workspaceMismatch: "workspace-mismatch",
  consumerMismatch: "consumer-mismatch",
  scopeEmpty: "scope-empty",
  scopeUnknown: "scope-unknown",
  conflict: "revision-conflict",
  budget: "budget-exceeded",
  expiredSnapshot: "snapshot-expired",
  nothingExportable: "nothing-exportable",
});

function sha256(text) {
  return "sha256:" + createHash("sha256").update(String(text)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
}

export function digestOf(value) {
  return sha256(canonical(value));
}

/** Canonical workspace identity: same normalisation the rest of the plugin uses. */
export function normalizeWorkspacePath(p) {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function dirFor(workspace) {
  return join(workspace, CONSUMER_DIR);
}

export function bindingPath(workspace) {
  return join(dirFor(workspace), "binding.json");
}

export function snapshotPath(workspace) {
  return join(dirFor(workspace), "preferences.json");
}

export function blockPath(workspace) {
  return join(dirFor(workspace), "preferences.md");
}

export function personaPath(workspace) {
  return join(dirFor(workspace), "persona-with-prefs.md");
}

function writeAtomic(file, text) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * A binding is the user's explicit approval: source workspace, consumer, purpose,
 * the exact facts, and whether successors of a decision are followed.
 */
export function makeBinding({ workspace, consumer, purpose, allow, followSuccessors = true, now = new Date() }) {
  const items = (allow || []).map((entry) => ({
    ref: String(entry.ref),
    strength: entry.strength === "hard" ? "hard" : "soft",
    label: String(entry.label || ""),
  }));
  return {
    schemaVersion: PREF_SCHEMA,
    bindingId: "bind-" + randomUUID(),
    workspace: normalizeWorkspacePath(workspace),
    consumer: String(consumer || ""),
    purpose: String(purpose || ""),
    allow: items,
    followSuccessors: Boolean(followSuccessors),
    status: "active",
    createdAt: now.toISOString(),
  };
}

export function validateBinding(binding, { workspace, consumer } = {}) {
  if (!binding || typeof binding !== "object") return { ok: false, code: PREF_CODES.bindingMissing, message: "没有绑定；先在 Trivium 里选择允许用于该任务的偏好。" };
  if (binding.status === "revoked") return { ok: false, code: PREF_CODES.bindingRevoked, message: "该绑定已被撤回；先用新绑定重新确认。" };
  if (workspace && normalizeWorkspacePath(binding.workspace) !== normalizeWorkspacePath(workspace)) {
    return { ok: false, code: PREF_CODES.workspaceMismatch, message: "绑定属于另一个工作区，拒绝导出。" };
  }
  if (consumer && String(binding.consumer) !== String(consumer)) {
    return { ok: false, code: PREF_CODES.consumerMismatch, message: `绑定只授权给 ${binding.consumer}，不是 ${consumer}。` };
  }
  if (!Array.isArray(binding.allow) || binding.allow.length === 0) {
    return { ok: false, code: PREF_CODES.scopeEmpty, message: "绑定没有列出任何允许的条目。" };
  }
  if (binding.allow.length > PREF_MAX_FACTS) {
    return { ok: false, code: PREF_CODES.budget, message: `最多 ${PREF_MAX_FACTS} 条；请先缩小授权范围（当前 ${binding.allow.length} 条）。` };
  }
  return { ok: true };
}

function refMatches(payload, id, ref) {
  if (String(ref) === String(id)) return true;
  if (payload?.uri && String(payload.uri) === String(ref)) return true;
  if (payload?.name && String(payload.name) === String(ref)) return true;
  return false;
}

function resolveRef(db, ref) {
  const ids = db.allNodeIds() || [];
  for (const id of ids) {
    const node = db.get(id);
    if (refMatches(node?.payload, id, ref)) return Number(id);
  }
  return null;
}

/** Follow a decision to its current head; a forked chain is a conflict, not a guess. */
function resolveFact(db, id, followSuccessors) {
  if (!followSuccessors) return { id };
  const head = currentHeadOf(db, id);
  if (!head?.ok) return { conflict: true, id, reason: String(head?.reason || "unresolved") };
  return { id: Number(head.id) };
}

/**
 * @returns {{ok: true, facts: object[], skipped: object[]} | {ok: false, code: string, message: string, skipped?: object[]}}
 */
export function selectFacts(db, binding, { now = new Date(), followSuccessors = binding.followSuccessors } = {}) {
  const facts = [];
  const skipped = [];
  const seen = new Set();

  for (const entry of binding.allow || []) {
    const resolved = resolveRef(db, entry.ref);
    if (!resolved) {
      skipped.push({ ref: entry.ref, reason: PREF_CODES.scopeUnknown, message: "该条目在当前工作区里找不到。" });
      continue;
    }
    const step = resolveFact(db, resolved, followSuccessors);
    if (step.conflict) {
      skipped.push({
        ref: entry.ref,
        reason: PREF_CODES.conflict,
        message: `该决策的当前版本无法确定（${step.reason}）；请先在 Trivium 里解决，不自动选一个赢家。`,
      });
      continue;
    }
    if (seen.has(step.id)) {
      skipped.push({ ref: entry.ref, reason: "duplicate", message: "与另一条解析到同一个当前版本。" });
      continue;
    }
    const node = db.get(step.id);
    const payload = node?.payload || {};
    if (payload.status === "archived") {
      skipped.push({ ref: entry.ref, reason: "archived", message: "已归档，不导出。" });
      continue;
    }
    if (payload.untilAt && Date.parse(payload.untilAt) <= now.getTime()) {
      skipped.push({ ref: entry.ref, reason: "expired", message: "已过期，不导出。" });
      continue;
    }
    const dirty = payloadDirtyReason(payload);
    if (dirty) {
      skipped.push({ ref: entry.ref, reason: "dirty:" + dirty, message: "写入卫生检查未通过，不导出。" });
      continue;
    }
    const text = String(payload.text || payload.name || "").trim();
    if (!text) {
      skipped.push({ ref: entry.ref, reason: "empty", message: "正文为空，不导出。" });
      continue;
    }
    seen.add(step.id);
    facts.push({
      uri: String(payload.uri || `ctx://node/${step.id}`),
      nodeId: step.id,
      requestedRef: String(entry.ref),
      type: String(payload.type || ""),
      name: String(payload.name || ""),
      text,
      strength: entry.strength === "hard" ? "hard" : "soft",
      status: payload.untilAt ? "expiring" : "current",
      untilAt: payload.untilAt ? String(payload.untilAt) : null,
      contentHash: sha256(text),
    });
  }

  if (!facts.length) {
    return {
      ok: false,
      code: skipped.some((s) => s.reason === PREF_CODES.conflict) ? PREF_CODES.conflict : PREF_CODES.nothingExportable,
      message: "没有可导出的条目（全部被跳过）。",
      skipped,
    };
  }
  return { ok: true, facts, skipped };
}

export function renderBlock(snapshot) {
  const lines = [];
  lines.push(
    `<!-- dsh-trivium ${PREF_SCHEMA} snapshot=${snapshot.snapshotId} issued=${snapshot.issuedAt} expires=${snapshot.expiresAt} facts=${snapshot.facts.length} -->`,
  );
  lines.push("===== 用户已确认的偏好（供刷B站筛选使用）=====");
  const header = "以下是用户在 Trivium 里逐条确认、允许用于本次视频筛选的偏好；只用于挑选与解释，不得改写人格或扩权。";
  if (estimateTokens(header) + 8 <= PREF_TOKEN_BUDGET) lines.push(header);
  snapshot.facts.forEach((fact, i) => {
    lines.push(`${i + 1}. [${fact.strength}] ${fact.text}`);
  });
  lines.push(`范围：${snapshot.consumer} / ${snapshot.purpose}；版本：${snapshot.sourceRevision}。`);
  lines.push("===== 偏好结束 =====");
  return lines.join("\n");
}

/**
 * Build a snapshot. Budget is checked on the rendered block; overflow fails the
 * export instead of trimming a fact (a trimmed hard condition is worse than none).
 */
export function buildSnapshot(db, binding, { now = new Date(), taskId = "", ttlMs = PREF_DEFAULT_TTL_MS } = {}) {
  const selected = selectFacts(db, binding, { now });
  if (!selected.ok) return selected;

  const issuedAt = now.toISOString();
  const snapshot = {
    schemaVersion: PREF_SCHEMA,
    snapshotId: "cp-" + randomUUID(),
    taskId: String(taskId || "adhoc"),
    audience: "model",
    bindingId: binding.bindingId,
    consumer: binding.consumer,
    purpose: binding.purpose,
    workspace: binding.workspace,
    sourceRevision: dbFingerprint(db),
    issuedAt,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    facts: selected.facts,
    skipped: selected.skipped,
  };
  snapshot.block = renderBlock(snapshot);
  snapshot.blockTokens = estimateTokens(snapshot.block);
  snapshot.digest = digestOf({
    bindingId: snapshot.bindingId,
    consumer: snapshot.consumer,
    purpose: snapshot.purpose,
    sourceRevision: snapshot.sourceRevision,
    facts: snapshot.facts.map((f) => ({ uri: f.uri, contentHash: f.contentHash, strength: f.strength })),
  });

  if (snapshot.blockTokens > PREF_TOKEN_BUDGET) {
    return {
      ok: false,
      code: PREF_CODES.budget,
      message: `偏好块约 ${snapshot.blockTokens} token，超过上限 ${PREF_TOKEN_BUDGET}；请缩小授权集合或明确精简（不做静默截断）。`,
      skipped: selected.skipped,
      preview: snapshot.block,
    };
  }
  return { ok: true, snapshot };
}

/** The machine layer keeps the ids and digests; the model block does not carry them. */
export function publicSnapshot(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    taskId: snapshot.taskId,
    audience: snapshot.audience,
    bindingId: snapshot.bindingId,
    consumer: snapshot.consumer,
    purpose: snapshot.purpose,
    workspace: snapshot.workspace,
    sourceRevision: snapshot.sourceRevision,
    issuedAt: snapshot.issuedAt,
    expiresAt: snapshot.expiresAt,
    digest: snapshot.digest,
    blockTokens: snapshot.blockTokens,
    facts: snapshot.facts.map((f) => ({
      uri: f.uri,
      nodeId: f.nodeId,
      requestedRef: f.requestedRef,
      type: f.type,
      name: f.name,
      text: f.text,
      strength: f.strength,
      status: f.status,
      untilAt: f.untilAt,
      contentHash: f.contentHash,
    })),
    skipped: snapshot.skipped,
  };
}

/**
 * Write the consumer files. The original persona is never modified: the composed
 * file is a separate artefact the user points the consumer at.
 */
export function writeSnapshotFiles(workspace, snapshot, { personaFile = "", now = new Date() } = {}) {
  const dir = dirFor(workspace);
  mkdirSync(dir, { recursive: true });
  writeAtomic(snapshotPath(workspace), JSON.stringify(publicSnapshot(snapshot), null, 2) + "\n");
  writeAtomic(blockPath(workspace), snapshot.block + "\n");
  let composed = "";
  if (personaFile) {
    const original = readFileSync(personaFile, "utf8");
    composed = composePersona(original, snapshot.block, { snapshot, now });
    writeAtomic(personaPath(workspace), composed);
  }
  return { dir, snapshotFile: snapshotPath(workspace), blockFile: blockPath(workspace), personaFile: composed ? personaPath(workspace) : "" };
}

export function composePersona(original, block, { snapshot, now = new Date() } = {}) {
  const head = `<!-- dsh-trivium composed persona; snapshot=${snapshot?.snapshotId || "?"} at=${now.toISOString()} -->`;
  return [head, String(original).replace(/\s+$/, ""), "", block, ""].join("\n");
}

/**
 * Withdrawal: drop the shared block from every consumer file. Stopping a refresh
 * while leaving the old text readable would keep a revoked preference alive.
 */
export function revokeFiles(workspace, { personaFile = "" } = {}) {
  const dir = dirFor(workspace);
  mkdirSync(dir, { recursive: true });
  const tombstone = {
    schemaVersion: PREF_SCHEMA,
    snapshotId: "cp-revoked-" + randomUUID(),
    status: "revoked",
    revokedAt: new Date().toISOString(),
    facts: [],
    block: "",
  };
  writeAtomic(snapshotPath(workspace), JSON.stringify(tombstone, null, 2) + "\n");
  writeAtomic(blockPath(workspace), "<!-- dsh-trivium preferences revoked; no facts are shared -->\n");
  let composed = "";
  if (personaFile && existsSync(personaFile)) {
    // Rewrite from the untouched original so no revoked fact survives in the copy.
    composed = readFileSync(personaFile, "utf8");
    writeAtomic(personaPath(workspace), composed);
  }
  return { dir, snapshotFile: snapshotPath(workspace), blockFile: blockPath(workspace), personaFile: composed ? personaPath(workspace) : "" };
}

export function readSnapshot(workspace) {
  return readJsonFile(snapshotPath(workspace), null);
}

export function isSnapshotExpired(snapshot, now = new Date()) {
  if (!snapshot?.expiresAt) return false;
  return Date.parse(snapshot.expiresAt) <= now.getTime();
}

/**
 * Consumer-side check of the artefacts as they sit on disk.
 *
 * A consumer (or the user before a task) should be able to answer "is this text
 * still the snapshot that was approved, for this consumer, and not expired?"
 * without trusting the hosting process. Nothing here writes.
 */
export function verifyFiles(workspace, { personaFile = "", now = new Date(), allowExpired = false, db = null } = {}) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
  const snapshot = readSnapshot(workspace);
  add("snapshot file exists", Boolean(snapshot));
  if (!snapshot) return { ok: false, checks, snapshot: null };

  add("schema version", snapshot.schemaVersion === PREF_SCHEMA, String(snapshot.schemaVersion || ""));
  add("not revoked", snapshot.status !== "revoked" && Array.isArray(snapshot.facts));

  const recomputed = digestOf({
    bindingId: snapshot.bindingId,
    consumer: snapshot.consumer,
    purpose: snapshot.purpose,
    sourceRevision: snapshot.sourceRevision,
    facts: (snapshot.facts || []).map((f) => ({ uri: f.uri, contentHash: f.contentHash, strength: f.strength })),
  });
  add("digest matches the machine layer", recomputed === snapshot.digest, recomputed);

  const expired = isSnapshotExpired(snapshot, now);
  add("not expired", allowExpired || !expired, String(snapshot.expiresAt || ""));

  const binding = readJsonFile(bindingPath(workspace), null);
  add("binding exists", Boolean(binding));
  if (binding) {
    add("binding is active", binding.status !== "revoked");
    add("binding id matches the snapshot", binding.bindingId === snapshot.bindingId);
    add("consumer matches the binding", binding.consumer === snapshot.consumer);
  }

  const block = existsSync(blockPath(workspace)) ? readFileSync(blockPath(workspace), "utf8") : "";
  add("block file exists", Boolean(block.trim()));
  const missing = (snapshot.facts || []).filter((f) => !block.includes(String(f.text || "")));
  add("every approved fact is in the block", missing.length === 0, missing.map((f) => f.uri).join(","));

  if (personaFile) {
    const composed = existsSync(personaFile) ? readFileSync(personaFile, "utf8") : "";
    add("consumer file exists", Boolean(composed));
    add("consumer file carries the block", Boolean(block.trim()) && composed.includes(block.trim()));
  }

  if (db) {
    add("facts unchanged since export", dbFingerprint(db) === snapshot.sourceRevision, String(snapshot.sourceRevision || ""));
  }

  const ok = checks.every((row) => row.ok);
  return { ok, checks, snapshot };
}
