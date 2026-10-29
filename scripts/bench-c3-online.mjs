#!/usr/bin/env node
/**
 * C3-online：端到端臂实验（真实模型，计费按 provider usage，不用插件估算值）。
 *
 * 三个臂，回答"记忆到底有没有用"这个问题的最核心三角：
 *   A nomem    —— 无记忆（只有问题）
 *   C default  —— 当前默认：**不自动注入**，模型自己决定调 ctx_find / ctx_read（工具循环）
 *   E plain    —— 对照：同样的关键事实以普通文本塞进 system（隔离"有这张图"vs"有这段字"）
 *
 * 判据是字符串断言（必须出现 / 必须不出现），不是模型自评。
 * 成本：按 provider 返回的 usage 累计，并给出人民币估算；超过 --budget 立即停止。
 *
 * 用法：
 *   node scripts/bench-c3-online.mjs --arms=nomem,default --scenarios=S01,S02 --budget=2
 *   node scripts/bench-c3-online.mjs --arms=nomem,default,plain --budget=15 --out=.tmp/c-3/online.json
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const args = new Map(
  process.argv.slice(2).map((raw) => {
    const [k, v = "true"] = raw.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const ARMS = String(args.get("arms") || "nomem,default").split(",");
const ONLY = args.get("scenarios") ? String(args.get("scenarios")).split(",") : null;
const BUDGET_CNY = Number(args.get("budget") || 2);
const MAX_ROUNDS = Number(args.get("rounds") || 3);
const REPEATS = Math.max(1, Number(args.get("repeats") || 1));
const AUDIT_ONLY = args.has("audit-only");
if (!Number.isFinite(BUDGET_CNY) || BUDGET_CNY <= 0 || BUDGET_CNY > 15) throw new Error("本实验预算必须在 (0, 15] 元内");
if (ARMS.some((arm) => !["nomem", "default", "plain"].includes(arm))) throw new Error("Unknown experiment arm");
// 历史假定单价，未实时核验；只用于估算，不是供应商账单。
// 新付费实验须先核对当前模型价格和每请求上界；本轮只跑 audit-only。
const PRICE_IN = 2 / 1_000_000;
const PRICE_OUT = 8 / 1_000_000;

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY && !AUDIT_ONLY) throw new Error("缺少 DEEPSEEK_API_KEY");
const MODEL = process.env.C3_MODEL || "deepseek-chat";

const root = mkdtempSync(join(tmpdir(), "c3-online-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ recallMode: "off" }), "utf8");

const lib = (f) => import(new URL(`../lib/${f}`, import.meta.url).href);
const store = await lib("store.js");
const revisions = await lib("revisions.js");
const { registerTools } = await lib("tools.js");

const tools = new Map();
registerTools({ effect: (fn) => fn(), tools: { register: (t) => { tools.set(t.name, t); return () => {}; } }, on() {} }, {});
const remember = tools.get("ctx_remember");
const find = tools.get("ctx_find");
const read = tools.get("ctx_read");

const execFor = (cwd) => ({ agent: { session: { header: { cwd, id: `c3-${cwd}` }, id: `c3-${cwd}` } } });
const plant = async (cwd, fact) => String(await remember.execute(fact, execFor(cwd)));

/* ---------------- 场景（含判定串） ---------------- */

const SCENARIOS = {
  S01: {
    name: "单条偏好",
    setup: async (cwd) => {
      await plant(cwd, { type: "preference", name: "视频口味", text: "推荐技术视频时，我喜欢先看实际演示。" });
      await plant(cwd, { type: "preference", name: "饮食", text: "我不吃香菜。" });
    },
    question: "推荐技术视频时，按我的偏好应该怎么选？",
    expect: ["实际演示"],
    forbid: ["香菜"],
    plain: "用户偏好：推荐技术视频时先看实际演示。",
  },
  S02: {
    name: "决策更替",
    setup: async (cwd) => {
      const v1 = (await plant(cwd, { type: "decision", name: "视频约定", text: "只推教程类视频。" })).match(/id=(\d+)/)[1];
      const v2 = (await plant(cwd, { type: "decision", name: "视频约定", text: "教程与实际演示都可以推。" })).match(/id=(\d+)/)[1];
      const db = await store.openWorkspaceDb(cwd);
      assert.notEqual(v1, v2, "S02 fixture versions must have different ids");
      assert.equal(revisions.supersede(db, { oldId: Number(v1), successorId: Number(v2), reason: "改主意" }).ok, true);
    },
    question: "现在推荐视频的约定是什么？",
    expect: ["都可以"],
    forbid: ["只推教程"],
    // 解释历史时会合法提到旧约定，字符串判据无法区分"提到"与"当成当前"，降级为人工复核
    strictForbid: false,
    plain: "当前约定（已替代旧版）：教程与实际演示都可以推。",
  },
  S03: {
    name: "过期决策",
    setup: async (cwd) => {
      await plant(cwd, { type: "decision", name: "发版窗口", text: "周五不发版。", until: "2020-01-01" });
    },
    question: "这周可以发版吗？如果历史上有过限制请说明它是否已过期。",
    expect: ["过期"],
    forbid: [],
    plain: "历史决策：周五不发版（有效期至 2020-01-01，已过期）。",
  },
  S04: {
    name: "跨工作区同名",
    setup: async (cwd) => {
      await plant(cwd, { type: "preference", name: "上线规范", text: "发布前先跑验收脚本（A 版）。" });
    },
    question: "上线规范是什么？",
    expect: ["验收脚本"],
    forbid: ["B 通道"],
    plain: "上线规范：发布前先跑验收脚本（A 版）。",
  },
  S05: {
    name: "需读正文",
    setup: async (cwd) => {
      await plant(cwd, { type: "experience", name: "发布流程", text: "发布前要跑 run-all.mjs 全量回归，再执行上线。" });
    },
    question: "发布前具体要做什么？",
    expect: ["run-all"],
    forbid: [],
    plain: "发布流程：发布前要跑 run-all.mjs 全量回归，再执行上线。",
  },
  S06: {
    name: "无关记忆",
    setup: async (cwd) => {
      for (let i = 0; i < 8; i++) await plant(cwd, { type: "entity", name: `无关实体 ${i}`, text: `与算术无关的记录 ${i}。` });
    },
    question: "1+1 等于几？",
    expect: ["2"],
    forbid: ["无关实体"],
    plain: "（本场景无相关记忆）",
  },
  S07: {
    name: "预算压力",
    setup: async (cwd) => {
      for (let i = 1; i <= 6; i++) {
        await plant(cwd, { type: "decision", name: `联调约定 ${i}`, text: `第 ${i} 条联调约定：先跑基线再改召回；本条关注${["环境隔离","版本固定","种子记录","失败样本","回滚方案","验收门槛"][i - 1]}。` });
      }
    },
    question: "我们有哪些联调约定？尽量多列。",
    expect: ["基线"],
    forbid: [],
    plain: ["环境隔离", "版本固定", "种子记录", "失败样本", "回滚方案", "验收门槛"].map((focus, i) => `第 ${i + 1} 条联调约定：先跑基线再改召回；本条关注${focus}。`).join("\n"),
  },
  S08: {
    name: "归档不复活",
    setup: async (cwd) => {
      const out = await plant(cwd, { type: "decision", name: "旧发布约定", text: "每周三固定发版（已作废）。" });
      const id = Number(/id=(\d+)/.exec(out)[1]);
      const db = await store.openWorkspaceDb(cwd);
      store.archiveNode(db, id);
      await plant(cwd, { type: "decision", name: "现行发布约定", text: "发布改为按需，随时可发。" });
    },
    question: "当前发布约定是什么？",
    expect: ["按需"],
    forbid: ["每周三"],
    plain: "当前发布约定：按需发布，随时可发。",
  },
  S09: {
    name: "换述复合",
    setup: async (cwd) => {
      await plant(cwd, { type: "preference", name: "口味-演示", text: "我喜欢有实际演示的内容。" });
      await plant(cwd, { type: "preference", name: "约束-时段", text: "晚上十点以后不要推长视频。" });
    },
    question: "按我的偏好和约束，晚上该给我推什么？",
    expect: ["演示", "长视频"],
    forbid: [],
    plain: "用户偏好：喜欢有实际演示的内容。约束：晚上十点以后不要推长视频。",
  },
  S10: {
    name: "显式问历史",
    setup: async (cwd) => {
      const a = await plant(cwd, { type: "decision", name: "缓存策略", text: "早期方案：全量刷新缓存。" });
      const b = await plant(cwd, { type: "decision", name: "缓存策略", text: "现在方案：按 key 增量失效。" });
      const db = await store.openWorkspaceDb(cwd);
      const oldId = Number(/id=(\d+)/.exec(a)[1]), successorId = Number(/id=(\d+)/.exec(b)[1]);
      assert.notEqual(oldId, successorId, "S10 fixture versions must have different ids");
      assert.equal(revisions.supersede(db, { oldId, successorId, reason: "命中率太低" }).ok, true);
    },
    question: "我们为什么从全量刷新缓存改成增量失效？",
    expect: ["增量"],
    forbid: [],
    plain: "缓存策略历史：早期全量刷新，因命中率太低改为按 key 增量失效。",
  },
};

/* ---------------- 模型调用 ---------------- */

let spent = 0;
const usageLog = [];
let currentTrial = null;
function saveUsage(status) {
  const receipt = { status, budgetCny: BUDGET_CNY, estimatedCny: spent, pricesCnyPerMillion: { uncachedInput: 2, cachedInput: 0.5, output: 8 }, trial: currentTrial, calls: usageLog };
  if (args.get("out")) {
    mkdirSync(dirname(args.get("out")), { recursive: true });
    writeFileSync(`${args.get("out")}.usage.json`, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  }
  return receipt;
}
function stopForBudget() {
  console.error(JSON.stringify(saveUsage("budget-exhausted")));
  throw new Error("实验估算预算已到上限，不再发起模型请求；usage 已保留");
}

async function callModel(messages, { tools: toolDefs, toolChoice } = {}) {
  if (AUDIT_ONLY) throw new Error("audit-only mode must never request a model");
  if (spent >= BUDGET_CNY) stopForBudget();
  const body = { model: MODEL, messages, temperature: 0, stream: false, max_tokens: 500 };
  if (toolDefs?.length) body.tools = toolDefs;
  if (toolChoice) body.tool_choice = toolChoice;
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const u = json.usage || {};
  const cached = Number(u.prompt_cache_hit_tokens || 0);
  const miss = Number(u.prompt_tokens || 0) - cached;
  spent += miss * PRICE_IN + cached * PRICE_IN * 0.25 + Number(u.completion_tokens || 0) * PRICE_OUT;
  usageLog.push({ ...currentTrial, model: json.model || MODEL, prompt: u.prompt_tokens || 0, cached, completion: u.completion_tokens || 0 });
  saveUsage("running");
  if (spent >= BUDGET_CNY) stopForBudget();
  return json.choices?.[0]?.message || {};
}

const TOOL_DEFS = ["ctx_find", "ctx_read"].map((name) => {
  const t = tools.get(name);
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
});

/** 清掉 provider 把工具调用/安全分类当正文吐出来的噪声。 */
function sanitize(text) {
  let out = String(text || "");
  // 形如 <｜｜DSML｜｜ calls> … </｜｜DSML｜｜ calls> 的整段工具标记
  out = out.replace(/<｜｜DSML｜｜[\s\S]*?<\/｜｜DSML｜｜\s*calls>/g, "");
  out = out.replace(/<｜｜DSML｜｜[\s\S]*$/g, "");
  out = out.replace(/<ds_safety>[\s\S]*?<\/ds_safety>/g, "");
  return out.trim();
}

async function runToolLoop(cwd, question) {
  const messages = [
    { role: "system", content: "你是一个有长期记忆助手的编码助理。需要回忆用户约定时，先调用工具检索，再回答。不要编造没检索到的内容。" },
    { role: "user", content: question },
  ];
  let toolCalls = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;
    const msg = await callModel(messages, last ? { tools: TOOL_DEFS, toolChoice: "none" } : { tools: TOOL_DEFS });
    if (!msg.tool_calls?.length) {
      const clean = sanitize(msg.content);
      if (clean.length >= 8) return { answer: clean, toolCalls };
      // 内容是工具调用标记或空：补一轮，明确要求直接给结论
      const forced = await callModel(
        [...messages, { role: "user", content: "请直接给出结论，不要输出任何工具调用标记。" }],
        { tools: TOOL_DEFS, toolChoice: "none" },
      );
      return { answer: sanitize(forced.content), toolCalls };
    }
    messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      toolCalls += 1;
      let out;
      try {
        const ars = JSON.parse(call.function?.arguments || "{}");
        out = call.function.name === "ctx_read"
          ? String(await read.execute(ars, execFor(cwd)))
          : String(await find.execute(ars, execFor(cwd)));
      } catch (err) {
        out = `tool error: ${err.message}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: out.slice(0, 1500) });
    }
  }
  return { answer: "（达到最大轮数仍未给出答案）", toolCalls };
}

/* ---------------- 执行 ---------------- */

const workspaceFor = (rep, id, arm) => join(root, `rep-${rep}`, id, arm);

// A zero-call audit of fixture identity and obvious false positives. This does
// not replace blind human grading, and does not recalculate historical runs.
if (AUDIT_ONLY) {
  try {
    const paths = [];
    for (let rep = 0; rep < 2; rep++) for (const id of Object.keys(SCENARIOS)) for (const arm of ["nomem", "default", "plain"]) paths.push(workspaceFor(rep, id, arm));
    assert.equal(new Set(paths).size, 60, "scenarios, arms and repetitions must not share a store");
    const fixtures = [];
    for (const id of ["S01", "S02", "S10"]) {
      for (const arm of ["default", "plain"]) {
        const cwd = workspaceFor(0, id, arm);
        await SCENARIOS[id].setup(cwd);
        const db = await store.openWorkspaceDb(cwd);
        assert.equal(store.nodeCountOf(db), 3, `${id}/${arm} must contain only its two facts and workspace root`);
        fixtures.push({ id, arm, nodeCount: store.nodeCountOf(db) });
        store.closeAll();
      }
    }
    const adversarial = [
      ["S02", "教程与实际演示并非都可以推荐，仍然只有教程。"],
      ["S07", "不知道之前的约定，建议先建立一份基线。"],
      ["S10", "你提到了增量失效，但我不知道修改原因。"],
    ].map(([id, answer]) => {
      const sc = SCENARIOS[id];
      return { id, answer, legacyPass: sc.expect.every((word) => answer.includes(word)) && !(sc.strictForbid !== false && sc.forbid.some((word) => answer.includes(word))), semanticPass: false };
    });
    assert.ok(adversarial.every((row) => row.legacyPass), "the audit must expose the legacy rubric's false positives");
    const audit = { mode: "audit-only", modelCalls: 0, uniqueWorkspacePaths: new Set(paths).size, fixtures, adversarial, conclusion: "keyword matches are not answer accuracy; old online claims require regrading and a controlled rerun" };
    if (args.get("out")) { mkdirSync(dirname(args.get("out")), { recursive: true }); writeFileSync(args.get("out"), JSON.stringify(audit, null, 2) + "\n", "utf8"); }
    console.log(JSON.stringify(audit, null, 2));
  } finally { store.closeAll(); rmSync(root, { recursive: true, force: true }); }
  process.exit(0);
}

const ids = Object.keys(SCENARIOS).filter((id) => !ONLY || ONLY.includes(id));
const results = [];

try {
for (let rep = 0; rep < REPEATS; rep += 1) {
for (const id of ids) {
  const sc = SCENARIOS[id];
  for (const arm of ARMS) {
    if (spent > BUDGET_CNY) {
      results.push({ id, arm, rep, skipped: `预算用尽（已花 ¥${spent.toFixed(3)}）` });
      continue;
    }
    const cwd = workspaceFor(rep, id, arm);
    await sc.setup(cwd);
    currentTrial = { rep, id, arm };
    const before = spent;
    let answer = "";
    let toolCalls = 0;
    if (arm === "nomem") {
      const msg = await callModel([
        { role: "system", content: "你是一个编码助理。不知道的事情要说不确定。" },
        { role: "user", content: sc.question },
      ]);
      answer = sanitize(msg.content);
    } else if (arm === "plain") {
      const msg = await callModel([
        { role: "system", content: `你可以参考以下已知信息：\n${sc.plain}` },
        { role: "user", content: sc.question },
      ]);
      answer = sanitize(msg.content);
    } else {
      const out = await runToolLoop(cwd, sc.question);
      answer = out.answer;
      toolCalls = out.toolCalls;
    }
    const expectOk = sc.expect.every((s) => answer.includes(s));
    const forbidHit = sc.forbid.filter((s) => answer.includes(s));
    const forbidBlocks = sc.strictForbid !== false && forbidHit.length > 0;
    results.push({
      id, name: sc.name, arm, rep,
      expect: sc.expect, expectOk,
      forbid: sc.forbid, forbidHit,
      toolCalls,
      pass: expectOk && !forbidBlocks,
      forbidNeedsReview: !forbidBlocks && forbidHit.length > 0,
      costCny: +(spent - before).toFixed(4),
      answer,
    });
    process.stderr.write(`[c3] r${rep} ${id} ${arm} pass=${expectOk && !forbidHit.length} ¥${(spent - before).toFixed(4)}\n`);
  }
}
}

const totals = {
  promptTokens: usageLog.reduce((n, u) => n + u.prompt, 0),
  cachedTokens: usageLog.reduce((n, u) => n + u.cached, 0),
  completionTokens: usageLog.reduce((n, u) => n + u.completion, 0),
  calls: usageLog.length,
  costCny: +spent.toFixed(4),
};
const byArm = {};
for (const r of results) {
  if (r.skipped) continue;
  byArm[r.arm] = byArm[r.arm] || { pass: 0, total: 0, cost: 0, toolCalls: 0 };
  byArm[r.arm].total += 1;
  byArm[r.arm].pass += r.pass ? 1 : 0;
  byArm[r.arm].cost = +(byArm[r.arm].cost + r.costCny).toFixed(4);
  byArm[r.arm].toolCalls += r.toolCalls || 0;
}

const report = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  node: process.version,
  budgetCny: BUDGET_CNY,
  measurement: "真实模型调用；token 取 provider usage；人民币为脚本假定单价估算而非账单；字符串 pass 仅是启发式匹配，必须人工复核，不能当答对率；temperature=0",
  totals,
  byArm,
  results,
};
console.log(JSON.stringify(report, null, 2));
if (args.get("out")) {
  mkdirSync(dirname(args.get("out")), { recursive: true });
  writeFileSync(args.get("out"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

saveUsage("completed");
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
