#!/usr/bin/env node
/**
 * Consumer preference snapshot CLI (E0/E1-A).
 *
 *   node scripts/prefs-export.mjs init   --workspace <dir> --allow <id|uri|name>... [--strength soft|hard]
 *                                        [--consumer bili-duty] [--purpose video-curation] [--no-follow]
 *   node scripts/prefs-export.mjs export --workspace <dir> [--task <id>] [--ttl-hours 24] [--persona <file>]
 *   node scripts/prefs-export.mjs revoke --workspace <dir> [--persona <file>]
 *   node scripts/prefs-export.mjs status --workspace <dir>
 *
 * Reads the workspace database read-only. It never writes facts and never talks to
 * a platform; the only outputs are the binding, the snapshot and the persona copy.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openWorkspaceDbReadOnly, closeAll } from "../lib/store.js";
import {
  PREF_CODES,
  PREF_MAX_FACTS,
  bindingPath,
  buildSnapshot,
  dirFor,
  makeBinding,
  normalizeWorkspacePath,
  publicSnapshot,
  readJsonFile,
  revokeFiles,
  validateBinding,
  writeSnapshotFiles,
} from "../lib/consumer-preferences.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (key === "no-follow" || key === "json" || key === "help") {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    if (key === "allow") {
      out.allow = out.allow || [];
      out.allow.push(next);
    } else {
      out[key] = next;
    }
    i += 1;
  }
  return out;
}

function fail(code, message, extra = {}) {
  console.log(JSON.stringify({ ok: false, code, message, ...extra }, null, 2));
  process.exitCode = 2;
}

function need(args, key) {
  const v = typeof args[key] === "string" ? args[key] : "";
  if (!v) fail("usage", `缺少 --${key}`);
  return v;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || "help";

if (cmd === "help" || args.help) {
  console.log(`用法：
  node scripts/prefs-export.mjs init   --workspace <目录> --allow <id/uri/名称>... [--strength soft|hard] [--consumer bili-duty] [--purpose video-curation] [--no-follow]
  node scripts/prefs-export.mjs export --workspace <目录> [--task <id>] [--ttl-hours 24] [--persona <人设文件>]
  node scripts/prefs-export.mjs revoke --workspace <目录> [--persona <人设文件>]
  node scripts/prefs-export.mjs status --workspace <目录>

最多 ${PREF_MAX_FACTS} 条、模型侧偏好块 ≤300 估算 token；超限报错而不是截断。`);
  process.exit(0);
}

const workspace = resolve(need(args, "workspace"));

if (cmd === "init") {
  const allow = (args.allow || []).map((ref) => ({ ref, strength: args.strength === "hard" ? "hard" : "soft" }));
  if (!allow.length) fail("usage", "至少需要一条 --allow");
  const binding = makeBinding({
    workspace,
    consumer: args.consumer || "bili-duty",
    purpose: args.purpose || "video-curation",
    allow,
    followSuccessors: !args["no-follow"],
  });
  mkdirSync(dirFor(workspace), { recursive: true });
  writeFileSync(bindingPath(workspace), JSON.stringify(binding, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, bindingId: binding.bindingId, allow: binding.allow, file: bindingPath(workspace) }, null, 2));
  process.exit(0);
}

const binding = readJsonFile(bindingPath(workspace), null);

if (cmd === "status") {
  const snapshot = readJsonFile(resolve(dirFor(workspace), "preferences.json"), null);
  console.log(JSON.stringify({
    ok: true,
    workspace: normalizeWorkspacePath(workspace),
    binding: binding ? { bindingId: binding.bindingId, status: binding.status, consumer: binding.consumer, purpose: binding.purpose, allow: binding.allow.length } : null,
    snapshot: snapshot ? { snapshotId: snapshot.snapshotId, status: snapshot.status || "active", issuedAt: snapshot.issuedAt, expiresAt: snapshot.expiresAt, facts: snapshot.facts?.length ?? 0, digest: snapshot.digest } : null,
  }, null, 2));
  process.exit(0);
}

if (cmd === "revoke") {
  const personaFile = args.persona ? resolve(args.persona) : "";
  if (binding) {
    binding.status = "revoked";
    binding.revokedAt = new Date().toISOString();
    writeFileSync(bindingPath(workspace), JSON.stringify(binding, null, 2) + "\n", "utf8");
  }
  const files = revokeFiles(workspace, { personaFile });
  console.log(JSON.stringify({ ok: true, revoked: Boolean(binding), ...files }, null, 2));
  process.exit(0);
}

if (cmd === "export") {
  const check = validateBinding(binding, { workspace, consumer: args.consumer || "" });
  // A changed consumer/purpose must be re-approved, not silently reused.
  if (check.ok && (args.purpose ? args.purpose !== binding.purpose : false)) {
    fail(PREF_CODES.consumerMismatch, `绑定用途是 ${binding.purpose}，不是 ${args.purpose}`);
    process.exit();
  }
  if (!check.ok) {
    fail(check.code, check.message);
    process.exit();
  }
  if (!existsSync(dirFor(workspace))) mkdirSync(dirFor(workspace), { recursive: true });
  let db;
  try {
    db = openWorkspaceDbReadOnly(workspace);
  } catch (err) {
    fail("db-open-failed", "无法只读打开工作区数据库：" + String(err?.message ?? err));
    process.exit();
  }
  try {
    const ttlHours = Number(args["ttl-hours"] || 24);
    const built = buildSnapshot(db, binding, {
      taskId: typeof args.task === "string" ? args.task : "",
      ttlMs: Math.max(1, ttlHours) * 3600 * 1000,
    });
    if (!built.ok) {
      fail(built.code, built.message, { skipped: built.skipped || [], preview: built.preview });
      process.exit();
    }
    const files = writeSnapshotFiles(workspace, built.snapshot, { personaFile: args.persona ? resolve(args.persona) : "" });
    const snap = publicSnapshot(built.snapshot);
    console.log(JSON.stringify({
      ok: true,
      snapshotId: snap.snapshotId,
      digest: snap.digest,
      sourceRevision: snap.sourceRevision,
      facts: snap.facts.map((f) => ({ uri: f.uri, strength: f.strength, text: f.text })),
      skipped: snap.skipped,
      blockTokens: snap.blockTokens,
      files,
    }, null, 2));
  } finally {
    try { closeAll(); } catch { /* read-only handle */ }
  }
  process.exit(0);
}

fail("usage", `未知子命令：${cmd}`);
