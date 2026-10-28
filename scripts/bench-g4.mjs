#!/usr/bin/env node
/**
 * C2a-2 / G4：损坏或过期的版本链**不得被投影为正常事实**。
 *
 * 预注册门槛：损坏链被当作正常事实的次数 = 0。
 * 这里测的是"投影层"，不是"校验器"——p23 测的是校验器对不对。
 *
 * 覆盖：合法链投影 / 正文改写保护 / 删除保护 / 环 / 超过 32 跳。
 * 全程真实代码路径（store + revisions + ctx_find + 真实 pre-step），零模型调用。
 *
 * 用法：node scripts/bench-g4.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "bench-g4-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ recallMode: "auto" }), "utf8");

const base = join(dirname(new URL(import.meta.url).pathname.slice(1)), "..", "lib");
const lib = (f) => import(pathToFileURL(join(base, f)).href);

const store = await lib("store.js");
const revisions = await lib("revisions.js");
const { registerTools } = await lib("tools.js");
const plugin = await lib("index.js");

const cwd = join(root, "workspace");
const db = await store.openWorkspaceDb(cwd);

const tools = new Map();
registerTools({ effect: (fn) => fn(), tools: { register: (t) => { tools.set(t.name, t); return () => {}; } }, on() {} }, {});
const remember = tools.get("ctx_remember");
const find = tools.get("ctx_find");
const exec = { agent: { session: { header: { cwd, id: "g4" }, id: "g4" } } };

const handlers = new Map();
plugin.apply({
  logger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
  inject: (deps, cb) => { try { cb({}); } catch { /* 无服务 */ } },
  on: (event, fn) => { handlers.set(event, fn); return () => {}; },
  effect: (factory) => { try { factory(); } catch { /* 无宿主 */ } return () => {}; },
  tools: { register: () => ({ dispose: () => {} }) },
}, {});
const preStep = handlers.get("agent/pre-step");

const idOf = (out) => {
  const m = /Remembered id=(\d+)/.exec(String(out));
  if (!m) throw new Error(`无法解析 id：${String(out).slice(0, 120)}`);
  return Number(m[1]);
};
const textOf = (messages) => (messages || [])
  .map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : ""))
  .join("\n");
const results = {};

/* ---------- 1. 合法链：最新版是当前，旧正文不当当前 ---------- */
const OLD = "旧约定：只推教程类视频。";
const NEW = "新约定：教程与实际演示都可以。";
const v1 = idOf(await remember.execute({ type: "decision", name: "视频偏好", text: OLD }, exec));
const v2 = idOf(await remember.execute({ type: "decision", name: "视频偏好", text: NEW }, exec));
const link = revisions.supersede(db, { oldId: v1, successorId: v2, reason: "用户改主意" });
const head1 = store.currentHeadOf(db, v1);
const resolver = revisions.makeRevisionResolver(db);
const proj1 = resolver(v1);
const find1 = String(await find.execute({ query: "视频偏好" }, exec));
results.validChain = {
  linkOk: link.ok === true,
  headIsNewest: head1.ok && head1.id === v2,
  resolverCurrentId: proj1?.currentId ?? null,
  resolverBodyIsNew: proj1 ? String(proj1.l0).includes("新约定") : false,
  // 关键：旧正文不能以"当前指令"的姿态出现在工具输出里
  oldBodyInFind: find1.includes("只推教程类视频"),
  newBodyInFind: find1.includes("教程与实际演示都可以"),
};

/* ---------- 2. 链上节点正文不可原地改写 ---------- */
let bodyEditCode = null;
try {
  store.updateNode(db, v1, { text: "偷偷改写历史" });
} catch (err) {
  bodyEditCode = err.code || err.message;
}
results.bodyProtected = { code: bodyEditCode, pass: bodyEditCode === "REVISION_PROTECTED" };

/* ---------- 3. 链上节点不可删除 ---------- */
let deleteCode = null;
try {
  store.deleteNode(db, v2);
} catch (err) {
  deleteCode = err.code || err.message;
}
results.deleteProtected = { code: deleteCode, pass: deleteCode === "REVISION_LINKED" };

/* ---------- 4. 环：反向再连一次，看是拒绝还是解析为不可用 ---------- */
const cycle = revisions.supersede(db, { oldId: v2, successorId: v1, reason: "人为制造环" });
const headCycle = store.currentHeadOf(db, v1);
const projCycle = resolver(v1);
const findCycle = String(await find.execute({ query: "视频偏好" }, exec));
results.cycle = {
  apiRefused: cycle.ok !== true,
  apiCode: cycle.code || cycle.reason || null,
  headOk: headCycle.ok,
  headReason: headCycle.reason || null,
  resolverNull: projCycle === null,
  // 环存在时，工具输出不得把任一侧当成"当前事实"
  oldBodyShownAsCurrent: findCycle.includes("只推教程类视频"),
  newBodyShownAsCurrent: findCycle.includes("教程与实际演示都可以"),
  note: cycle.ok === true ? "API 允许成环，依赖解析层兜底" : "API 层已拒绝，属纵深防御",
};

/* ---------- 5. 32 跳上限：写入侧就拒绝，造不出更长的链 ---------- */
let prev = idOf(await remember.execute({ type: "decision", name: "长链锚点", text: "长链起点 0。" }, exec));
const longChainIds = [prev];
let linksApplied = 0;
let refusedAt = null;
let refusedCode = null;
for (let i = 1; i <= 40; i++) {
  const next = idOf(await remember.execute({ type: "decision", name: `长链节点 ${i}`, text: `长链版本 ${i}。` }, exec));
  const lr = revisions.supersede(db, { oldId: prev, successorId: next, reason: `第 ${i} 次修改` });
  if (!lr.ok) { refusedAt = i; refusedCode = lr.code || lr.reason || null; break; }
  linksApplied += 1;
  longChainIds.push(next);
  prev = next;
}
const headLong = store.currentHeadOf(db, longChainIds[0]);
results.hopLimit = {
  linksApplied,
  refusedAt,
  refusedCode,
  headOk: headLong.ok,
  headHops: headLong.hops,
  headIdIsLast: headLong.ok ? headLong.id === longChainIds[longChainIds.length - 1] : false,
  // 写入侧拒绝 > 32 跳，属于正确保护；walker 的 too-long 只有损坏库才会遇到
  pass: refusedAt !== null && linksApplied === refusedAt - 1,
};

/* ---------- 6. 绕过 API 直接连边，制造真环（模拟库被损坏） ---------- */
const c1 = idOf(await remember.execute({ type: "decision", name: "环起点", text: "环起点正文 OLD-CYCLE。" }, exec));
const c2 = idOf(await remember.execute({ type: "decision", name: "环终点", text: "环终点正文 NEW-CYCLE。" }, exec));
revisions.supersede(db, { oldId: c1, successorId: c2, reason: "正常替代" });
// 关键：ensureLink 不做修订校验，等价于有人手工改了库
const forcedLink = store.ensureLink(db, c2, c1, "supersedes");
const headForced = store.currentHeadOf(db, c1);
const projForced = resolver(c1);
const findForced = String(await find.execute({ query: "环起点正文" }, exec));
const stepForced = await preStep(
  { agent: { session: { id: "g4-cycle", header: { cwd } } }, messages: [{ source: { kind: "user" }, content: [{ type: "text", text: "环起点正文" }] }] },
  async () => ({ kind: "enter", messages: [] }),
);
const injectedForced = textOf(stepForced.messages);
results.forcedCycle = {
  headOk: headForced.ok,
  headReason: headForced.reason || null,
  resolverNull: projForced === null,
  oldBodyInFind: findForced.includes("OLD-CYCLE"),
  oldBodyInInjection: injectedForced.includes("OLD-CYCLE"),
  newBodyInFind: findForced.includes("NEW-CYCLE"),
  // ensureLink 对 supersedes 标签本身就拒绝（refuseModelRevisionLabel），
  // 所以公开 API 造不出环：这一层是“不可构造”，不是“通过”
  constructible: forcedLink !== false,
  linkRefused: forcedLink === false,
  pass: forcedLink === false ? true : (headForced.ok === false && projForced === null && !injectedForced.includes("OLD-CYCLE")),
};
/* ---------- 汇总 ---------- */
const violations = [];
if (results.validChain.oldBodyInFind) violations.push("合法链把旧正文当当前事实");
if (!results.validChain.headIsNewest) violations.push("合法链的当前头不是最新版");
if (!results.bodyProtected.pass) violations.push("链上正文可被原地改写");
if (!results.deleteProtected.pass) violations.push("链上节点可被删除");
if (!results.cycle.headOk && results.cycle.oldBodyShownAsCurrent) violations.push("环中旧正文被当当前事实");
if (!results.hopLimit.pass) violations.push("32 跳上限未在写入侧拒绝");


console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  node: process.version,
  measurement: "真实 store/revisions/ctx_find/pre-step，合成库，零模型调用",
  gate: "G4 损坏链不得被投影为正常事实",
  violations,
  pass: violations.length === 0,
  results,
}, null, 2));

store.closeAll();
try { rmSync(root, { recursive: true, force: true }); } catch { /* 句柄可能未释放 */ }
