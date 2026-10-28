#!/usr/bin/env node
/**
 * C3-offline：10 个 pilot 场景的"材料齐备性"测量（零模型调用）。
 *
 * 只回答三件事，全部是字符串断言，不用模型自评：
 *   1. recalled —— 该给的事实有没有进注入 / ctx_find top-8
 *   2. forbidden —— 不该给的内容出现几次（跨库泄漏、旧版当当前、无关注入）
 *   3. tokens —— 单轮注入的估算 token 是否越 300
 *
 * 场景定义见 docs/next-memory/C3-SCENARIOS.md。
 * 用法：node scripts/bench-c3.mjs [--out=.tmp/c-3/offline.json]
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const args = new Map(
  process.argv.slice(2).map((raw) => {
    const [k, v = "true"] = raw.replace(/^--/, "").split("=");
    return [k, v];
  }),
);

const root = mkdtempSync(join(tmpdir(), "bench-c3-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ recallMode: "auto" }), "utf8");

const libDir = join(dirname(new URL(import.meta.url).pathname.slice(1)), "..", "lib");
const lib = (f) => import(pathToFileURL(join(libDir, f)).href);
const store = await lib("store.js");
const revisions = await lib("revisions.js");
const { estimateTokens } = await lib("tokens.js");
const { registerTools } = await lib("tools.js");
const plugin = await lib("index.js");

const tools = new Map();
registerTools({ effect: (fn) => fn(), tools: { register: (t) => { tools.set(t.name, t); return () => {}; } }, on() {} }, {});
const remember = tools.get("ctx_remember");
const find = tools.get("ctx_find");
const read = tools.get("ctx_read");

const handlers = new Map();
plugin.apply({
  logger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
  inject: (deps, cb) => { try { cb({}); } catch { /* 无服务 */ } },
  on: (event, fn) => { handlers.set(event, fn); return () => {}; },
  effect: (factory) => { try { factory(); } catch { /* 无宿主 */ } return () => {}; },
  tools: { register: () => ({ dispose: () => {} }) },
}, {});
const preStep = handlers.get("agent/pre-step");

const ws = (name) => join(root, name);
const execFor = (cwd, id = `s-${cwd}`) => ({ agent: { session: { header: { cwd, id }, id } } });

const idOf = (out) => {
  const m = /Remembered id=(\d+)/.exec(String(out));
  if (!m) throw new Error(`无法解析 id：${String(out).slice(0, 120)}`);
  return Number(m[1]);
};
const plant = async (cwd, fact) => idOf(await remember.execute(fact, execFor(cwd)));

let seq = 0;
/** 发问并取回注入正文与 token。 */
async function ask(cwd, text) {
  seq += 1;
  const decision = await preStep(
    { agent: { session: { id: `ask-${seq}`, header: { cwd } } }, messages: [{ source: { kind: "user" }, content: [{ type: "text", text }] }] },
    async () => ({ kind: "enter", messages: [] }),
  );
  const injected = (decision.messages || [])
    .map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : ""))
    .join("\n");
  return { injected, tokens: estimateTokens(injected) };
}
const findOut = async (cwd, query, extra = {}) => String(await find.execute({ query, ...extra }, execFor(cwd)));
const count = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);

const scenarios = [];

/* ---------- S01 单条偏好 ---------- */
{
  const cwd = ws("s01");
  await plant(cwd, { type: "preference", name: "视频口味", text: "推荐技术视频时，我喜欢先看实际演示。" });
  await plant(cwd, { type: "preference", name: "饮食", text: "我不吃香菜。" });
  const { injected, tokens } = await ask(cwd, "推荐什么技术视频");
  scenarios.push({
    id: "S01", name: "单条偏好",
    recalled: injected.includes("实际演示"),
    forbidden: count(injected, "香菜"),
    tokens,
    pass: injected.includes("实际演示") && count(injected, "香菜") === 0 && tokens <= 300,
  });
}

/* ---------- S02 决策更替 ---------- */
{
  const cwd = ws("s02");
  const v1 = await plant(cwd, { type: "decision", name: "视频约定", text: "只推教程类视频。" });
  const v2 = await plant(cwd, { type: "decision", name: "视频约定", text: "教程与实际演示都可以推。" });
  const db = await store.openWorkspaceDb(cwd);
  revisions.supersede(db, { oldId: v1, successorId: v2, reason: "用户改主意" });
  const { injected, tokens } = await ask(cwd, "现在推荐视频的约定是什么");
  scenarios.push({
    id: "S02", name: "决策更替",
    recalled: injected.includes("教程与实际演示"),
    forbidden: count(injected, "只推教程类视频"),
    tokens,
    pass: injected.includes("教程与实际演示") && count(injected, "只推教程类视频") === 0,
  });
}

/* ---------- S03 过期决策 ---------- */
{
  const cwd = ws("s03");
  await plant(cwd, { type: "decision", name: "发版窗口", text: "周五不发版。", until: "2020-01-01" });
  const { injected, tokens } = await ask(cwd, "这周能发版吗");
  const withStale = await findOut(cwd, "发版窗口");
  const withoutStale = await findOut(cwd, "发版窗口", { include_stale: false });
  scenarios.push({
    id: "S03", name: "过期决策",
    recalled: withStale.includes("周五不发版"),
    forbidden: 0,
    tokens,
    note: { staleMarked: /stale/i.test(withStale), hiddenWhenAsked: withoutStale === "No memory hits." },
    pass: withStale.includes("周五不发版") && /stale/i.test(withStale) && withoutStale === "No memory hits.",
  });
}

/* ---------- S04 跨工作区同名 ---------- */
{
  const a = ws("s04-a");
  const b = ws("s04-b");
  const MARK = "B-ONLY-C3-MARK";
  await plant(a, { type: "preference", name: "上线规范", text: "发布前先跑验收脚本（A 版）。" });
  await plant(b, { type: "preference", name: "上线规范", text: `发布走 B 通道，${MARK}。` });
  const { injected, tokens } = await ask(a, "上线规范");
  const fin = await findOut(a, "上线规范");
  const leaks = count(injected, MARK) + count(fin, MARK);
  scenarios.push({
    id: "S04", name: "跨工作区同名",
    recalled: injected.includes("A 版") || fin.includes("A 版"),
    forbidden: leaks,
    tokens,
    pass: leaks === 0 && (injected.includes("A 版") || fin.includes("A 版")),
  });
}

/* ---------- S05 需读正文 ---------- */
{
  const cwd = ws("s05");
  const id = await plant(cwd, { type: "experience", name: "发布流程", text: "发布前要跑 run-all.mjs 全量回归，再执行上线。" });
  const fin = await findOut(cwd, "发布前要做什么");
  const detail = String(await read.execute({ id }, execFor(cwd)));
  scenarios.push({
    id: "S05", name: "需读正文",
    recalled: detail.includes("run-all.mjs"),
    forbidden: 0,
    tokens: estimateTokens(detail),
    note: { findHit: fin.includes("run-all.mjs") },
    pass: detail.includes("run-all.mjs") && fin.includes("run-all.mjs"),
  });
}

/* ---------- S06 无关记忆（有害注入） ---------- */
{
  const cwd = ws("s06");
  for (let i = 0; i < 20; i++) {
    await plant(cwd, { type: "entity", name: `无关实体 ${i}`, text: `与算术无关的记录 ${i}` });
  }
  const { injected, tokens } = await ask(cwd, "1+1 等于几");
  scenarios.push({
    id: "S06", name: "无关记忆",
    recalled: null,
    forbidden: injected.trim() ? 1 : 0,
    tokens,
    note: { injectedLength: injected.trim().length, preview: injected.trim().slice(0, 160) },
    pass: injected.trim() === "",
  });
}

/* ---------- S07 预算耗尽 ---------- */
{
  const cwd = ws("s07");
  for (let i = 1; i <= 6; i++) {
    await plant(cwd, {
      type: "decision",
      name: `联调约定 ${i}`,
      // 正文写长一点，制造预算压力
      text: `第 ${i} 条联调约定：先跑基线再改召回策略，记录版本与种子，避免用测试集调参后再声称泛化。`.repeat(2),
    });
  }
  const { injected, tokens } = await ask(cwd, "把刚才几条联调约定一起说一遍");
  const delivered = [1, 2, 3, 4, 5, 6].filter((i) => injected.includes(`第 ${i} 条联调约定`)).length;
  scenarios.push({
    id: "S07", name: "预算耗尽",
    recalled: delivered >= 1,
    forbidden: 0,
    tokens,
    note: { deliveredFacts: delivered },
    pass: tokens <= 300 && delivered >= 1,
  });
}

/* ---------- S08 归档不复活 ---------- */
{
  const cwd = ws("s08");
  const id = await plant(cwd, { type: "decision", name: "旧发布约定", text: "每周三固定发版（已作废）。" });
  const db = await store.openWorkspaceDb(cwd);
  store.archiveNode(db, id);
  const { injected, tokens } = await ask(cwd, "当前发布约定是什么");
  const fin = await findOut(cwd, "当前发布约定");
  const shown = count(injected, "每周三固定发版") + count(fin, "每周三固定发版");
  scenarios.push({
    id: "S08", name: "归档不复活",
    recalled: null,
    forbidden: shown,
    tokens,
    note: { injectedLength: injected.trim().length },
    pass: shown === 0,
  });
}

/* ---------- S09 多轮累积 ---------- */
{
  const cwd = ws("s09");
  await plant(cwd, { type: "preference", name: "口味-演示", text: "我喜欢有实际演示的内容。" });
  await plant(cwd, { type: "preference", name: "约束-时段", text: "晚上十点以后不要推长视频。" });
  const { injected, tokens } = await ask(cwd, "按我的偏好和约束，晚上推荐什么");
  scenarios.push({
    id: "S09", name: "多轮累积",
    recalled: injected.includes("实际演示") && injected.includes("十点"),
    forbidden: 0,
    tokens,
    pass: injected.includes("实际演示") && injected.includes("十点"),
  });
}

/* ---------- S10 显式问历史 ---------- */
{
  const cwd = ws("s10");
  const v1 = await plant(cwd, { type: "decision", name: "缓存策略", text: "早期方案：全量刷新缓存。" });
  const v2 = await plant(cwd, { type: "decision", name: "缓存策略", text: "现在方案：按 key 增量失效。" });
  const db = await store.openWorkspaceDb(cwd);
  revisions.supersede(db, { oldId: v1, successorId: v2, reason: "命中率太低" });
  const { injected, tokens } = await ask(cwd, "上次为什么从全量刷新改成增量失效");
  const fin = await findOut(cwd, "全量刷新 缓存");
  const historyReachable = /matched_history=/.test(fin) || fin.includes("全量刷新") || injected.includes("全量刷新");
  const oldAsCurrent = count(injected, "早期方案") > 0 && count(injected, "现在方案") === 0;
  scenarios.push({
    id: "S10", name: "显式问历史",
    recalled: historyReachable,
    forbidden: oldAsCurrent ? 1 : 0,
    tokens,
    pass: historyReachable && !oldAsCurrent,
  });
}

const passed = scenarios.filter((s) => s.pass).length;
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  measurement: "真实插件路径 + 真实 pre-step + ctx_find/ctx_read，合成库，零模型调用；判据是字符串断言，不是模型自评",
  thresholds: { recalled: "≥8/10", forbiddenTotal: 0, maxInjectedTokens: 300 },
  summary: {
    passed: `${passed}/${scenarios.length}`,
    forbiddenTotal: scenarios.reduce((n, s) => n + (s.forbidden || 0), 0),
    maxTokens: Math.max(...scenarios.map((s) => s.tokens || 0)),
    overBudget: scenarios.filter((s) => (s.tokens || 0) > 300).map((s) => s.id),
  },
  scenarios,
};

console.log(JSON.stringify(report, null, 2));
if (args.get("out")) {
  mkdirSync(dirname(args.get("out")), { recursive: true });
  writeFileSync(args.get("out"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

store.closeAll();
try { rmSync(root, { recursive: true, force: true }); } catch { /* 句柄可能未释放 */ }
