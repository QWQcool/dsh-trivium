/**
 * Two operator switches, checked where they are decided rather than in the UI.
 *
 * 1. `toolRecovery` — rule extraction of "X failed then succeeded" rows. The
 *    rule fires on any failed + succeeded pair inside one turn, so routine
 *    debugging leaves rows that carry no reusable fact. Default stays ON so an
 *    existing store keeps the behaviour it had before the switch existed; the
 *    point of the test is that turning it off removes the rows and nothing else.
 *
 * 2. `turnTokenBudget` — the per-turn injection allowance. The engine default is
 *    300 tokens, which fits an anchor plus one neighbour and defers the rest;
 *    the switch only has to be honoured, bounded and backwards compatible.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { ruleCandidates } from "../lib/extract.js";
import { TURN_ADDITIONAL_BUDGET } from "../lib/context-budget.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p92-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "trivium.json");
process.env.DSH_HOME = join(root, "home");

const { readUiSettings, toolRecoveryOf, turnBudgetOf, writeUiSettings } = await import("../lib/settings.js");

let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
  console.log("ok  " + message);
}

/* -------------------------------------------------- tool recovery extraction */

/* One window with both shapes: a durable preference and a trivial recovery. */
const window = [
  { role: "user", text: "记住，本仓库鉴权走 header X。", turn: 1 },
  { role: "tool", name: "grep", ok: false, text: "no match", turn: 2 },
  { role: "tool", name: "grep", ok: true, text: "2 matches", turn: 2 },
];
const recoveryOf = (cands) =>
  cands.filter((c) => c.type === "experience" && /failed then succeeded$/.test(c.text));

check(recoveryOf(ruleCandidates(window)).length === 1, "the recovery row is produced by default");
check(
  ruleCandidates(window).some((c) => c.type === "preference" && /鉴权/.test(c.text)),
  "the default rule set still writes the durable preference",
);

const off = ruleCandidates(window, { toolRecovery: false });
check(recoveryOf(off).length === 0, "toolRecovery:false writes no recovery row");
check(
  off.some((c) => c.type === "preference" && /鉴权/.test(c.text)),
  "toolRecovery:false keeps every other candidate in the same window",
);
check(
  off.length === ruleCandidates(window).length - 1,
  "toolRecovery:false removes exactly the recovery row",
);
check(
  recoveryOf(ruleCandidates(window, { toolRecovery: true })).length === 1,
  "an explicit toolRecovery:true is the same as the default",
);

/* An explicit false must survive a round trip through the settings file. */
check(toolRecoveryOf({}) === true, "a missing key means the historical behaviour (on)");
check(toolRecoveryOf({ toolRecovery: false }) === false, "an explicit false is off");
check(toolRecoveryOf({ toolRecovery: true }) === true, "an explicit true is on");

writeUiSettings({ toolRecovery: false });
check(toolRecoveryOf() === false, "the switch is persisted, not only accepted");
writeUiSettings({ toolRecovery: true });
check(toolRecoveryOf() === true, "turning it back on is persisted too");

/* ------------------------------------------------------ per-turn allowance */

check(turnBudgetOf({}) === TURN_ADDITIONAL_BUDGET, "a missing budget is the engine default");
check(turnBudgetOf({ turnTokenBudget: "" }) === TURN_ADDITIONAL_BUDGET, "a blank budget is the engine default");
check(turnBudgetOf({ turnTokenBudget: null }) === TURN_ADDITIONAL_BUDGET, "a null budget is the engine default");
check(turnBudgetOf({ turnTokenBudget: "nope" }) === TURN_ADDITIONAL_BUDGET, "an unparsable budget is the engine default");
check(turnBudgetOf({ turnTokenBudget: 600 }) === 600, "an explicit budget is honoured");
check(turnBudgetOf({ turnTokenBudget: "600" }) === 600, "a numeric string is honoured");
check(turnBudgetOf({ turnTokenBudget: 600.9 }) === 600, "a fractional budget is floored");
check(turnBudgetOf({ turnTokenBudget: -5 }) === 0, "a negative budget clamps to zero");
check(turnBudgetOf({ turnTokenBudget: 999999 }) === 2000, "an oversized budget clamps to the cap");
check(turnBudgetOf({ turnTokenBudget: 0 }) === 0, "an explicit zero is a real budget, not the default");

writeUiSettings({ turnTokenBudget: 600 });
check(turnBudgetOf(JSON.parse(readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8"))) === 600,
  "the budget is persisted, not only accepted");
writeUiSettings({ turnTokenBudget: 999999 });
check(turnBudgetOf(JSON.parse(readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8"))) === 2000,
  "the persisted value is clamped as well");
writeUiSettings({ turnTokenBudget: "nope" });
check(turnBudgetOf(JSON.parse(readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8"))) === 2000,
  "an unparsable write leaves the stored value alone");

/* The other switches must survive a patch that only touches the new keys. */
writeUiSettings({ recallMode: "anchor" });
writeUiSettings({ toolRecovery: false });
const kept = JSON.parse(readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8"));
check(kept.recallMode === "anchor", "a toolRecovery patch does not reset the recall mode");
check(kept.turnTokenBudget === 2000, "a toolRecovery patch does not reset the budget");

/* ------------------------------------------------------ HTTP preview budget */

// The preview must use the same live allowance as the status/turn endpoints,
// including zero. A hub with long neighbours makes a larger cap observable in
// the selected records, rather than only in the returned budget number.
const { registerMemoryApi } = await import("../lib/server.js");
const { closeAll, ensureLink, insertNode, openWorkspaceDb } = await import("../lib/store.js");
let handler;
registerMemoryApi({ webServer: { register(entry) { handler = entry.handler; return () => {}; } } }, {
  liveOptions: readUiSettings,
  status: {},
});
const server = http.createServer((req, res) => handler(req, res));

try {
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ recallMode: "anchor" }));
  const cwd = join(root, "workspace");
  const db = await openWorkspaceDb(cwd);
  const anchor = insertNode(db, { type: "entity", name: "AuthGateway", text: "AuthGateway 是统一鉴权入口。" });
  for (let i = 0; i < 6; i++) {
    const id = insertNode(db, {
      type: "decision",
      name: `鉴权发布约定 ${i + 1}`,
      text: `AuthGateway 发布约定 ${i + 1}：所有生产请求必须通过统一入口校验身份。发布前先检查灰度环境的回归结果，并由值班人员确认监控指标正常。更新策略时应保留原有配置以便回退，记录审批人与上线时间。发现异常后先停止扩大流量，再根据请求日志判断影响范围，完成修复后重新执行回归验证。团队需要在交接文档中说明本次变更的适用场景和后续检查方式。`,
    });
    ensureLink(db, id, anchor, "about");
  }
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const base = `http://127.0.0.1:${server.address().port}/api/dsh-trivium`;
  const query = `?cwd=${encodeURIComponent(cwd)}`;
  const request = async (path, body) => {
    const response = await fetch(base + path + query, body === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    check(response.status === 200 && json.ok === true, `${path} succeeds through the real HTTP handler`);
    return json;
  };
  let defaultCount = 0;
  for (const budget of [undefined, 0, 900]) {
    if (budget !== undefined) writeUiSettings({ turnTokenBudget: budget });
    const expected = budget ?? TURN_ADDITIONAL_BUDGET;
    const status = await request("/status");
    const turn = await request("/turn");
    const preview = await request("/recall-preview", { query: "AuthGateway", mode: "anchor" });
    check(status.turnTokenBudget === expected && turn.budget === expected && preview.budget === expected,
      `status, turn and preview share the ${budget === undefined ? "default " : ""}${expected} budget`);
    if (expected === 0) {
      check(preview.records.length === 0 && preview.tokens === 0 && !preview.text.recall && !preview.text.pins,
        "a zero budget previews no injected records or text");
    } else {
      check(preview.records.length > 0 && preview.tokens > 0 && preview.tokens <= expected,
        `the preview selects records within its ${expected} budget`);
      if (budget === undefined) defaultCount = preview.records.length;
      else check(preview.records.length > defaultCount && preview.tokens > TURN_ADDITIONAL_BUDGET,
        "a 900-token preview admits neighbours that the default cap defers");
    }
  }
} finally {
  await new Promise((done) => server.close(done));
  closeAll();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nP92 switches passed (${checks} checks)`);
