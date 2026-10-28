#!/usr/bin/env node
/**
 * C2a：注入层与正确性硬门槛（零模型调用）。
 *
 * 三条硬门槛按 C 批的预注册要求必须是 0，不是"平均很低"：
 *   G1 跨工作区泄漏 = 0
 *   G2 同轮注入不突破既定预算（芯片/更正/召回共用 300；短地图 400 单独算）
 *   G3 过时事实必须被标为 stale，且 include_stale=false 时不可召回
 *
 * 全部走真实插件路径：registerTools 拿四工具、plugin.apply 拿宿主钩子、真实 pre-step。
 * 只用合成库与临时 DSH_TRIVIUM_SETTINGS，不碰用户 .dsh。
 *
 * 用法：node scripts/bench-injection.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "bench-inject-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
// 让 pre-step 真的注入：autoRecall 打开。这是测量条件，不是默认行为。
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ recallMode: "auto" }), "utf8");

const lib = (f) => import(pathToFileURL(join(dirname(new URL(import.meta.url).pathname.slice(1)), "..", "lib", f)).href);

const { estimateTokens } = await lib("tokens.js");
const { registerTools } = await lib("tools.js");
const plugin = await lib("index.js");

const A = join(root, "workspace-a");
const B = join(root, "workspace-b");
const B_MARKER = "B-ONLY-MARKER-7f3a";

/* 工具面：真实 registerTools */
const tools = new Map();
registerTools({ effect: (fn) => fn(), tools: { register: (t) => { tools.set(t.name, t); return () => {}; } }, on() {} }, {});
const remember = tools.get("ctx_remember");
const find = tools.get("ctx_find");
const execA = { agent: { session: { header: { cwd: A, id: "sess-a" }, id: "sess-a" } } };
const execB = { agent: { session: { header: { cwd: B, id: "sess-b" }, id: "sess-b" } } };

/* 宿主钩子：真实 plugin.apply */
const handlers = new Map();
plugin.apply({
  logger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
  inject: (deps, cb) => { try { cb({}); } catch { /* 无服务时忽略 */ } },
  on: (event, fn) => { handlers.set(event, fn); return () => {}; },
  effect: (factory) => { try { factory(); } catch { /* 无宿主时注册可能抛 */ } return () => {}; },
  tools: { register: () => ({ dispose: () => {} }) },
}, {});

const preStep = handlers.get("agent/pre-step");
if (typeof preStep !== "function") throw new Error("agent/pre-step 未注册");

const userMsg = (text) => ({ source: { kind: "user" }, content: [{ type: "text", text }] });
const textOf = (messages) => (messages || [])
  .map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : ""))
  .join("\n");

/* ---------- 合成数据 ---------- */
await remember.execute({ type: "preference", name: "上线规范", text: "发布前先跑验收脚本，再发布。A 工作区的版本。", }, execA);
await remember.execute({ type: "preference", name: "上线规范", text: `发布流程走 B 通道，${B_MARKER}。`, }, execB);
await remember.execute({ type: "decision", name: "冻结窗口", text: "旧部署冻结约定：周五不发版。", until: "2020-01-01" }, execA);
await remember.execute({ type: "entity", name: "验收脚本", text: "run-all.mjs 全量跑一遍。", }, execA);

/* ---------- G1：跨工作区泄漏 ---------- */
const queries = ["上线规范", "发布", "冻结窗口", B_MARKER, "B 通道", "验收脚本"];
let leaks = 0;
const leakDetail = [];
for (const q of queries) {
  const out = await find.execute({ query: q }, execA);
  if (String(out).includes(B_MARKER)) {
    leaks += 1;
    leakDetail.push({ via: "ctx_find", query: q });
  }
  const decision = await preStep(
    { agent: { session: { id: "sess-a", header: { cwd: A } } }, messages: [userMsg(q)] },
    async () => ({ kind: "enter", messages: [] }),
  );
  const injected = textOf(decision.messages);
  if (injected.includes(B_MARKER)) {
    leaks += 1;
    leakDetail.push({ via: "pre-step", query: q });
  }
}

/* ---------- G2：同轮预算 ---------- */
/*
 * 同一轮的判定只看宿主 id 或**消息对象身份**（turnKeyOf：工具循环里宿主会复用同一条
 * 用户消息对象）。所以这里必须复用同一个 msg 对象，否则测出来的是"每步"而不是"每轮"。
 */
let turnMax = 0;
let turnCumulative = 0;
const turnBlocks = [];
const session = { id: "sess-budget", header: { cwd: A } };
const sameTurnMsg = userMsg("上线规范 验收脚本 冻结窗口 同一轮多步");
for (let step = 0; step < 4; step++) {
  const decision = await preStep(
    { agent: { session }, messages: [sameTurnMsg] },
    async () => ({ kind: "enter", messages: [] }),
  );
  const injected = textOf(decision.messages);
  const tokens = estimateTokens(injected);
  turnCumulative += tokens;
  turnMax = Math.max(turnMax, tokens);
  turnBlocks.push({ step, tokens, cumulative: turnCumulative });
}

/* ---------- G3：过时事实 ---------- */
const staleFind = String(await find.execute({ query: "冻结窗口" }, execA));
const staleExcluded = String(await find.execute({ query: "冻结窗口", include_stale: false }, execA));
const staleMarked = /stale/i.test(staleFind);
const staleHidden = staleExcluded === "No memory hits.";

await plugin.dispose?.().catch?.(() => {});
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  measurement: "真实插件路径（registerTools + plugin.apply + 真实 pre-step），合成库，零模型调用",
  gates: {
    G1_crossWorkspaceLeak: { value: leaks, threshold: 0, pass: leaks === 0, detail: leakDetail },
    G2_sameTurnBudget: {
      maxTokensPerStep: turnMax,
      cumulativeTokensInTurn: turnCumulative,
      threshold: 300,
      pass: turnCumulative <= 300,
      perStep: turnBlocks,
    },
    G3_staleFact: { marked: staleMarked, excludedWhenAsked: staleHidden, pass: staleMarked && staleHidden },
  },
};
console.log(JSON.stringify(report, null, 2));

try {
  const store = await lib("store.js");
  store.closeAll();
} catch { /* 忽略 */ }
try { rmSync(root, { recursive: true, force: true }); } catch { /* 句柄可能未释放 */ }
