/**
 * 0.6.0 maintenance gate.
 *
 *   PKG-22   the read-only checker and the deadline cleaner ship in the package
 *   TURN-22  a rebuilt message object with the same id stays the same user turn
 *   UNTIL-22 dry-run lists; --apply clears only deadlines that appear in the body
 *   UNTIL-23 --all clears explicit deadlines too
 *
 * The two CLIs are driven as real child processes, so a broken shebang, a bad
 * relative import or a package.json `files` omission fails here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { closeAll, insertNode, openWorkspaceDb } from "../lib/store.js";
import { turnKeyOf } from "../lib/context-budget.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scripts = join(ROOT, "scripts");
const settings = join(mkdtempSync(join(tmpdir(), "dsh-trivium-p22-")), "settings.json");
process.env.DSH_TRIVIUM_SETTINGS = settings;

let checks = 0;
function check(value, label) {
  checks += 1;
  assert.ok(value, label);
  console.log(`ok  ${label}`);
}
function equal(actual, expected, label) {
  checks += 1;
  assert.equal(actual, expected, label);
  console.log(`ok  ${label}`);
}

function run(script, args) {
  const out = spawnSync(process.execPath, [join(scripts, script), ...args], {
    encoding: "utf8",
    env: { ...process.env, DSH_TRIVIUM_SETTINGS: settings },
  });
  return { status: out.status, stdout: out.stdout || "", stderr: out.stderr || "" };
}

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p22-ws-"));
try {
  /* ------------------------------------------------------------- PKG-22 */
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  equal(pkg.bin?.["dsh-trivium-check"], "scripts/check-integrity.mjs", "PKG-22 the checker has a bin entry");
  equal(pkg.bin?.["dsh-trivium-clear-until"], "scripts/clear-expired-until.mjs", "PKG-22 the cleaner has a bin entry");
  check(pkg.files?.includes("scripts/check-integrity.mjs"), "PKG-22 the checker ships in the package");
  check(pkg.files?.includes("scripts/clear-expired-until.mjs"), "PKG-22 the cleaner ships in the package");

  /* ------------------------------------------------------------ TURN-22 */
  const first = { id: "msg-1", source: { kind: "user" }, content: [{ type: "text", text: "同一个问题" }] };
  const rebuilt = { id: "msg-1", source: { kind: "user" }, content: [{ type: "text", text: "同一个问题" }] };
  equal(turnKeyOf([first]), turnKeyOf([rebuilt]), "TURN-22 a rebuilt object with the same id is the same turn");
  const nested = { source: { kind: "user", messageId: "nested-9" } };
  const nestedRebuilt = { source: { kind: "user", messageId: "nested-9" } };
  equal(turnKeyOf([nested]), turnKeyOf([nestedRebuilt]), "TURN-22 a nested source id is used too");
  const anonymous = { source: { kind: "user" } };
  equal(turnKeyOf([anonymous]), turnKeyOf([anonymous]), "TURN-22 the same object stays the same turn");
  check(turnKeyOf([anonymous]) !== turnKeyOf([{ source: { kind: "user" } }]), "TURN-22 two anonymous objects stay separate turns");

  /* ----------------------------------------------------------- UNTIL-22 */
  const db = await openWorkspaceDb(root);
  const prose = insertNode(db, {
    type: "decision",
    name: "正文带日期的旧决策",
    text: "旧版本从正文抓日期：2020-01-01 已经完成复盘。",
    until: "2020-01-01",
  });
  const explicit = insertNode(db, {
    type: "decision",
    name: "显式期限的旧决策",
    text: "这条期限是用户自己填的，正文没有日期。",
    until: "2020-01-01",
  });
  const future = insertNode(db, {
    type: "decision",
    name: "未到期决策",
    text: "正文和期限都指向未来。",
    until: "2999-01-01",
  });
  const none = insertNode(db, { type: "decision", name: "没有期限", text: "正文没有日期，也没有 until。" });
  db.flush();
  closeAll();

  const dry = run("clear-expired-until.mjs", [root, "--json"]);
  equal(dry.status, 0, "UNTIL-22 dry run exits 0");
  const dryReport = JSON.parse(dry.stdout);
  equal(dryReport.staleDecisions, 2, "UNTIL-22 only stale decisions with a deadline are listed");
  equal(dryReport.cleared.length, 0, "UNTIL-22 a dry run clears nothing");
  check(dryReport.rows.some((row) => row.id === prose && row.textMentionsUntil === true), "UNTIL-22 the prose deadline is marked");
  check(dryReport.rows.some((row) => row.id === explicit && row.textMentionsUntil === false), "UNTIL-22 the explicit deadline is not marked");

  const applied = run("clear-expired-until.mjs", [root, "--apply", "--json"]);
  equal(applied.status, 0, "UNTIL-22 apply exits 0");
  equal(JSON.parse(applied.stdout).cleared.length, 1, "UNTIL-22 apply clears only the prose deadline");

  let reopened = await openWorkspaceDb(root);
  equal(String(reopened.get(prose).payload.until || ""), "", "UNTIL-22 the prose deadline is gone");
  equal(String(reopened.get(explicit).payload.until || ""), "2020-01-01", "UNTIL-22 the explicit deadline is kept");
  equal(String(reopened.get(future).payload.until || ""), "2999-01-01", "UNTIL-22 a future deadline is untouched");
  equal(String(reopened.get(none).payload.until || ""), "", "UNTIL-22 a node without a deadline is untouched");
  reopened.flush();
  closeAll();

  const allApplied = run("clear-expired-until.mjs", [root, "--apply", "--all", "--json"]);
  equal(allApplied.status, 0, "UNTIL-23 apply --all exits 0");
  equal(JSON.parse(allApplied.stdout).cleared.length, 1, "UNTIL-23 apply --all clears the remaining explicit deadline");
  reopened = await openWorkspaceDb(root);
  equal(String(reopened.get(explicit).payload.until || ""), "", "UNTIL-23 the explicit deadline is gone");
  reopened.flush();
  closeAll();

  /* ------------------------------------------------------------- PKG-23 */
  const integrity = run("check-integrity.mjs", [root, "--json"]);
  equal(integrity.status, 0, "PKG-23 the shipped checker runs from a child process");
  const integrityReport = JSON.parse(integrity.stdout);
  check(integrityReport.ok === true, "PKG-23 a healthy workspace passes");
  equal(integrityReport.nodes, 5, "PKG-23 the checker sees the workspace root and four decisions");

  console.log(`\nP22 0.6.0 maintenance gate passed (${checks} checks)`);
} finally {
  closeAll();
  rmSync(root, { recursive: true, force: true });
  rmSync(join(settings, ".."), { recursive: true, force: true });
}
