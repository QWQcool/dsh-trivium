#!/usr/bin/env node
/**
 * D2 抽取成本专项：D1 的「检索侧省 token」能不能活下来，取决于写入侧的账单。
 *
 * 注意与 `bench-extract.mjs` 的区别：那个是 C2d 的调度/规模基线（零模型调用，模拟触发频率）；
 * 本脚本是**真实调用模型**测提取成本，三种策略跑同一批会话：
 *   per-turn  —— 每个用户轮抽一次（当前默认路径的形状）
 *   batch     —— 整个会话一次调用（批量抽取的下界）
 *   rules     —— 只用规则候选，零模型调用
 *
 *   node scripts/bench-extract-cost.mjs --run --budget=2
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PRICING, priceBoth, windowAt } from "./pricing.mjs";

const args = new Map(process.argv.slice(2).map((s) => { const at = s.indexOf("="); return at < 0 ? [s, true] : [s.slice(0, at), s.slice(at + 1)]; }));
const RUN = args.has("--run");
const BUDGET = Number(args.get("--budget") || 2);
const MODEL = String(args.get("--model") || "deepseek-flash");
const out = resolve(String(args.get("--out") || `.tmp/c4/extract-${RUN ? "online" : "audit"}.json`));
const REPO = resolve(import.meta.dirname, "..");
assert.ok(BUDGET > 0 && BUDGET <= 2, "预算必须在 (0, 2] 元");
assert.equal(existsSync(out), false, "输出路径必须是新的");
mkdirSync(dirname(out), { recursive: true });
if (RUN) assert.ok(process.env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY 缺失");

const extract = await import(pathToFileURL(join(REPO, "lib/extract.js")).href);

const SESSIONS = [
  { id: "s1", facts: ["技术视频首选标签为 DEMO-71。", "发布前必须执行 CHECK-71 校验。", "本工作区通道为 A-71。"], codes: ["DEMO-71", "CHECK-71", "A-71"] },
  { id: "s2", facts: ["订单号前缀固定为 ORD-42。", "退款必须走 RMA-42 流程。", "客服邮箱是 help42@example.com。"], codes: ["ORD-42", "RMA-42", "help42@example.com"] },
  { id: "s3", facts: ["默认超时设为 45 秒。", "重试次数上限为 3 次。", "降级开关名为 SAFE-45。"], codes: ["45", "3", "SAFE-45"] },
];

/** Same five-user-turn shape as D1, so the extraction prompt sees a realistic transcript. */
const transcriptOf = (s) => [
  { role: "user", text: `先记三条约定：${s.facts.join(" ")} 收到回 ok 即可。`, turn: 0 },
  { role: "assistant", text: "ok", turn: 0 },
  { role: "user", text: "先别管这些，把今天的进度用一句话整理一下。", turn: 1 },
  { role: "assistant", text: "今天推进了约定确认与进度整理。", turn: 1 },
  { role: "user", text: "继续推进第 1 项，回一句当前状态即可。", turn: 2 },
  { role: "assistant", text: "第 1 项进行中。", turn: 2 },
  { role: "user", text: "继续推进第 2 项，回一句当前状态即可。", turn: 3 },
  { role: "assistant", text: "第 2 项进行中。", turn: 3 },
  { role: "user", text: "继续推进第 3 项，回一句当前状态即可。", turn: 4 },
  { role: "assistant", text: "第 3 项进行中。", turn: 4 },
];

const table = PRICING[MODEL] || PRICING["deepseek-flash"];
const report = {
  protocol: "D2-EXTRACT", model: MODEL, sessions: SESSIONS.length,
  priceSource: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  prices: { peak: table.peak, offpeak: table.offpeak },
  costBasis: "offpeak", budgetCny: BUDGET, reserved: 0, calls: [], rows: [], status: "running", estimatedCny: 0,
};
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");

async function chat(prompt, maxTokens = 400, label = "extract") {
  assert.ok(RUN, "离线模式不发请求");
  const body = { model: MODEL, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: maxTokens, thinking: { type: "disabled" }, stream: false };
  const reserve = (Buffer.byteLength(JSON.stringify(body), "utf8") + 4096) * table.peak.inputMiss * 1e-6 + maxTokens * table.peak.output * 1e-6;
  assert.ok(report.reserved + reserve <= BUDGET, "预算不足：未发请求");
  report.reserved += reserve;
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(90_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`provider HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const json = await resp.json();
  const u = json.usage;
  if (!u || !Number.isFinite(u.prompt_tokens)) throw new Error("缺少 usage");
  const both = priceBoth(u, String(json.model || MODEL));
  report.estimatedCny += both.offpeak;
  report.calls.push({ label, arm: label.split("/")[0], model: json.model, usage: u, costPeak: both.peak, costOffpeak: both.offpeak, window: windowAt() });
  save();
  return { text: String(json.choices?.[0]?.message?.content || ""), usage: u, costOffpeak: both.offpeak };
}

const found = (candidates, codes) => codes.filter((c) => candidates.some((x) => JSON.stringify(x).includes(c))).length;

try {
  for (const s of SESSIONS) {
    const turns = transcriptOf(s);
    const row = { session: s.id, strategies: {} };

    /* rules-only：零调用，直接看规则候选 */
    const rules = extract.filterCandidates(extract.ruleCandidates(turns), {});
    row.strategies.rules = { calls: 0, promptTokens: 0, completionTokens: 0, costOffpeak: 0, candidates: rules.length, factsFound: found(rules, s.codes) };

    /* 每轮一次：与「turn 结束触发」同形 */
    const perTurn = { calls: 0, promptTokens: 0, completionTokens: 0, costOffpeak: 0, candidates: 0, factsFound: 0 };
    const merged = [];
    for (const t of turns.filter((x) => x.role === "user")) {
      const prompt = extract.buildExtractPrompt([t, { role: "assistant", text: "ack", turn: t.turn }]);
      perTurn.calls += 1;
      if (!RUN) continue;
      const res = await chat(prompt, 400, `perTurn/${s.id}/t${t.turn}`);
      const cands = extract.filterCandidates(extract.parseModelJson(res.text), {});
      perTurn.promptTokens += res.usage.prompt_tokens;
      perTurn.completionTokens += res.usage.completion_tokens;
      perTurn.costOffpeak += res.costOffpeak;
      merged.push(...cands);
    }
    perTurn.candidates = merged.length;
    perTurn.factsFound = found(merged, s.codes);
    row.strategies.perTurn = perTurn;

    /* 整会话一次：批量抽取的下界 */
    const batchPrompt = extract.buildExtractPrompt(turns);
    const batch = { calls: 1, promptTokens: 0, completionTokens: 0, costOffpeak: 0, candidates: 0, factsFound: 0, promptChars: batchPrompt.length };
    if (RUN) {
      const res = await chat(batchPrompt, 400, `batch/${s.id}`);
      const cands = extract.filterCandidates(extract.parseModelJson(res.text), {});
      batch.promptTokens = res.usage.prompt_tokens;
      batch.completionTokens = res.usage.completion_tokens;
      batch.costOffpeak = res.costOffpeak;
      batch.candidates = cands.length;
      batch.factsFound = found(cands, s.codes);
    }
    row.strategies.batch = batch;

    report.rows.push(row); save();
    console.log(`${s.id} rules=${row.strategies.rules.factsFound}/3 perTurn=${perTurn.factsFound}/3 batch=${batch.factsFound}/3 (${batch.promptChars} chars prompt)`);
  }

  const sum = (k) => report.rows.reduce((n, r) => n + (r.strategies[k].costOffpeak || 0), 0);
  const tokens = (k) => report.rows.reduce((n, r) => n + (r.strategies[k].promptTokens || 0), 0);
  report.summary = {
    sessions: report.rows.length,
    perTurn: { costOffpeak: sum("perTurn"), promptTokens: tokens("perTurn"), calls: report.rows.reduce((n, r) => n + r.strategies.perTurn.calls, 0) },
    batch: { costOffpeak: sum("batch"), promptTokens: tokens("batch"), calls: report.rows.length },
    rules: { costOffpeak: 0, promptTokens: 0, calls: 0, factsFound: report.rows.reduce((n, r) => n + r.strategies.rules.factsFound, 0) },
    perTurnFacts: report.rows.reduce((n, r) => n + r.strategies.perTurn.factsFound, 0),
    batchFacts: report.rows.reduce((n, r) => n + r.strategies.batch.factsFound, 0),
  };
  report.status = RUN ? "complete" : "audit-complete";
  save();
  console.log(JSON.stringify(report.summary, null, 2));
} catch (err) {
  report.status = "stopped"; report.error = String(err.message || err); save(); throw err;
}
