#!/usr/bin/env node
/**
 * D1：记忆能不能让「更狠的压缩」变得可行（预注册见 docs/next-memory/D1-PLAN.md）。
 *
 * 不做单轮注入对比（那已经在 D0 里做完，结论是注入只会加 token）。这里测的是：
 * 压缩掉早期约定之后，谁还能答对；以及在答对的前提下，整个会话累计花了多少 token。
 *
 * 用法：
 *   node scripts/bench-d1.mjs                # 离线装配自检（0 元）
 *   node scripts/bench-d1.mjs --run --budget=3
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { grade } from "./quality-fixtures.mjs";
import { createModelLedger } from "./model-ledger.mjs";

const args = new Map(process.argv.slice(2).map((s) => { const at = s.indexOf("="); return at < 0 ? [s, true] : [s.slice(0, at), s.slice(at + 1)]; }));
const RUN = args.has("--run");
const BUDGET = Number(args.get("--budget") || 3);
const MODEL = String(args.get("--model") || "deepseek-flash");
const ONLY_ARMS = String(args.get("--arms") || "").split(",").filter(Boolean);
const out = resolve(String(args.get("--out") || `.tmp/d1/d1-${RUN ? "online" : "audit"}.json`));
const REPO = resolve(import.meta.dirname, "..");

assert.ok(BUDGET > 0 && BUDGET <= 3, "预算必须在 (0, 3] 元");
assert.equal(existsSync(out), false, "输出路径必须是新的；不覆盖已付费证据");
mkdirSync(dirname(out), { recursive: true });
if (RUN) assert.ok(process.env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY 缺失");

const root = mkdtempSync(join(tmpdir(), "d1-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
process.env.DSH_HOME = join(root, "dsh-home");
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ recallMode: "auto", chipsEnabled: false, extractEnabled: false, gitSidecarEnabled: false }), "utf8");

const store = await import(pathToFileURL(join(REPO, "lib/store.js")).href);
const settings = await import(pathToFileURL(join(REPO, "lib/settings.js")).href);
const { estimateTokens } = await import(pathToFileURL(join(REPO, "lib/tokens.js")).href);
const plugin = await import(pathToFileURL(join(REPO, "lib/index.js")).href);

settings.writeUiSettings({ recallMode: "auto", chipsEnabled: false, extractEnabled: false, gitSidecarEnabled: false });

const handlers = new Map();
const ctx = {
  logger: () => ({ warn() {}, info() {}, error() {} }),
  inject(_deps, fn) { fn(ctx); },
  on(name, fn) { handlers.set(name, fn); return () => {}; },
  effect(fn) { fn(); return () => {}; },
  tools: { register: () => () => {} },
};
plugin.apply(ctx, {});
const preStep = handlers.get("agent/pre-step");
assert.equal(typeof preStep, "function", "agent/pre-step 必须注册");

/* ---------- 会话脚本（6 个，事实与问题互不相同） ---------- */
const SESSIONS = [
  {
    id: "s1",
    facts: ["技术视频首选标签为 DEMO-71。", "发布前必须执行 CHECK-71 校验。", "本工作区通道为 A-71。"],
    ask1: { q: '技术视频首选标签是什么？返回 {"tag":字符串或null}。', gold: { tag: "DEMO-71" } },
    ask2: { q: '发布前必须执行哪项校验、本工作区通道是什么？返回 {"check":字符串或null,"channel":字符串或null}。', gold: { check: "CHECK-71", channel: "A-71" } },
  },
  {
    id: "s2",
    facts: ["订单号前缀固定为 ORD-42。", "退款必须走 RMA-42 流程。", "客服邮箱是 help42@example.com。"],
    ask1: { q: '订单号前缀是什么？返回 {"prefix":字符串或null}。', gold: { prefix: "ORD-42" } },
    ask2: { q: '退款必须走哪个流程、客服邮箱是什么？返回 {"flow":字符串或null,"email":字符串或null}。', gold: { flow: "RMA-42", email: "help42@example.com" } },
  },
  {
    id: "s3",
    facts: ["默认超时设为 45 秒。", "重试次数上限为 3 次。", "降级开关名为 SAFE-45。"],
    ask1: { q: '默认超时是多少秒？返回 {"timeout":数字或null}。', gold: { timeout: 45 } },
    ask2: { q: '重试次数上限与降级开关名分别是什么？返回 {"retries":数字或null,"switch":字符串或null}。', gold: { retries: 3, switch: "SAFE-45" } },
  },
  {
    id: "s4",
    facts: ["测试环境数据库名为 qa_pool。", "测试账号是 qa-bot。", "测试入口端口是 9443。"],
    ask1: { q: '测试环境数据库名是什么？返回 {"db":字符串或null}。', gold: { db: "qa_pool" } },
    ask2: { q: '测试账号与测试入口端口分别是什么？返回 {"user":字符串或null,"port":数字或null}。', gold: { user: "qa-bot", port: 9443 } },
  },
  {
    id: "s5",
    facts: ["素材目录是 assets/raw。", "导出格式统一为 WebP。", "缩略图宽度固定 320 像素。"],
    ask1: { q: '素材目录在哪里？返回 {"dir":字符串或null}。', gold: { dir: "assets/raw" } },
    ask2: { q: '导出格式与缩略图宽度分别是什么？返回 {"format":字符串或null,"width":数字或null}。', gold: { format: "WebP", width: 320 } },
  },
  {
    id: "s6",
    facts: ["审批人是 Lin。", "审批阈值是 5000 元。", "超标后走 ESC-5000 升级。"],
    ask1: { q: '审批人是谁？返回 {"approver":字符串或null}。', gold: { approver: "Lin" } },
    ask2: { q: '审批阈值与超标升级流程分别是什么？返回 {"threshold":数字或null,"escalation":字符串或null}。', gold: { threshold: 5000, escalation: "ESC-5000" } },
  },
];

const TURN_COUNT = Number(args.get("--turns") || 5);
assert.ok(TURN_COUNT === 5 || TURN_COUNT === 10, "轮数只允许 5（D1）或 10（D1b，预注册见 D1-PLAN §7）");

const TURNS = (s, n = TURN_COUNT) => [
  { kind: "seed", text: `先记三条约定：${s.facts.join(" ")} 收到回 ok 即可。` },
  { kind: "noise", text: "先别管这些，把今天的进度用一句话整理一下。" },
  { kind: "ask1", ...s.ask1 },
  ...Array.from({ length: n - 4 }, (_, k) => ({ kind: "filler", text: `继续推进第 ${k + 1} 项，回一句当前状态即可。` })),
  { kind: "ask2", ...s.ask2 },
];

/* 压缩：第 4 轮起，历史只留最近 1 轮；摘要只保留 F1，F2/F3 明说不保留。 */
const compactSummary = (s) => `此前对话已压缩。保留：${s.facts[0]} 其余早期约定（第 2、3 条）未保留。`;

const ARMS = [
  { id: "none-full", memory: null, compact: false },
  { id: "none-compact", memory: null, compact: true },
  { id: "trivium-compact", memory: "trivium", compact: true },
  { id: "plain-compact", memory: "plain", compact: true },
];

/* ---------- 计费账本 ---------- */
const report = {
  protocol: "D1-R2-SIMULATION", variant: TURN_COUNT === 10 ? "D1b" : "D1", plan: "docs/next-memory/D1-PLAN.md", model: MODEL,
  thinking: "disabled", temperature: 0, maxTokens: 600, sessions: SESSIONS.length, turns: TURN_COUNT,
  budgetCny: BUDGET, pricesCnyPerMillion: { input: 2, cached: 0.04, output: 8 },
  status: "running", estimatedCny: 0, reservedOrChargedCny: 0, calls: [], cells: [], sessionsOut: [],
};
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
const paidCall = createModelLedger({report,save,budget:BUDGET,model:MODEL});
async function call(messages,label) {
  assert.ok(RUN,"offline audit cannot call a model");
  const r=await paidCall({model:MODEL,messages,temperature:0,thinking:{type:"disabled"},max_tokens:600,stream:false},label);
  return {...r,answer:String(r.message.content||"")};
}

const userMsg = (text, id) => ({ role: "user", id, source: { kind: "user" }, content: [{ type: "text", text }] });
const SYSTEM = "你是项目助手。只根据对话与记忆材料回答，信息缺失就如实说缺失。需要 JSON 时只输出 JSON。";

try {
  for (const arm of ARMS) {
    if (ONLY_ARMS.length && !ONLY_ARMS.includes(arm.id)) continue;
    for (const session of SESSIONS) {
      const ws = join(root, `${arm.id}-${session.id}`);
      mkdirSync(ws, { recursive: true });
      const db = arm.memory === "trivium" ? await store.openWorkspaceDb(ws) : null;
      if (db) for (const [i, text] of session.facts.entries()) store.insertNode(db, { type: "decision", name: `${session.id}-fact${i + 1}`, text });
      const corpus = arm.memory === "plain"
        ? `已确认的约定（同库完整投影）：\n${session.facts.map((t) => `- ${t}`).join("\n")}`
        : "";

      let history = [];
      const mapInbox = [];
      const liveSession = { id: `${arm.id}-${session.id}`, header: { cwd: ws } };
      const agent = { session: liveSession, inject: m => mapInbox.push({role:"user", content:(m.content||[]).map(c=>c.text||"").join("\n")}) };
      const sessionRow = { arm: arm.id, session: session.id, compact: arm.compact, turns: [], promptTokens: 0, completionTokens: 0, injectedTokens: 0, cost: 0, passed: 0, asked: 0 };
      for (const [i, turn] of TURNS(session, TURN_COUNT).entries()) {
        const compacted = arm.compact && i >= 3;
        const base = compacted ? [userMsg(compactSummary(session), `${session.id}-sum`), ...history.slice(-2)] : history;
        const messages = [{ role: "system", content: SYSTEM }, ...base.map((m) => ({ role: m.role, content: m.content }))];
        const additions=[];
        if(compacted && arm.memory === "trivium") handlers.get("session/event")?.(liveSession,{type:"compaction/end",data:{},seq:i});
        // ask 轮用的是 q 字段，不是 text；漏掉会让 content=undefined，provider 直接 422
        const promptText = turn.text ?? turn.q;

        let injected = "";
        if (arm.memory === "trivium" && preStep) {
          const decision = await preStep(
            { agent, messages: [userMsg(promptText, `${session.id}-t${i}`)] },
            async () => ({ kind: "enter", messages: [] }),
          );
          injected = (decision.messages || []).flatMap((m) => m.content || []).map((x) => x.text || "").join("\n");
          additions.push(...mapInbox.splice(0));
          if (injected.trim()) additions.push({ role: "user", content: `记忆材料：\n${injected}` });
        } else if (arm.memory === "plain" && corpus) {
          injected = corpus;
          additions.push({ role: "user", content: corpus });
        }
        additions.push({ role: "user", content: promptText });
        messages.push(...additions);

        const historyTokens = estimateTokens(JSON.stringify(messages));
        const cell = { arm: arm.id, session: session.id, turn: i, kind: turn.kind, requestMessages: messages, historyTokens, injectedTokens: estimateTokens(injected) };
        if (RUN) {
          const res = await call(messages, `${arm.id}/${session.id}/t${i}`);
          cell.answer = res.answer;
          cell.usage = res.usage;
          cell.cost = res.costOffpeak;
          cell.costPeak = res.cost;
          if (turn.gold) {
            cell.grade = grade(res.answer, turn.gold);
            if (cell.grade.pass) sessionRow.passed += 1;
          }
          // 只作为「返工」代理指标，不参与判分：模型要求用户重复/承认没信息
          if (/未提供|没有提供|请提供|无法得知|不确定|已压缩/.test(res.answer)) sessionRow.asked += 1;
          sessionRow.promptTokens += res.usage.prompt_tokens;
          sessionRow.completionTokens += res.usage.completion_tokens;
          sessionRow.cost += res.costOffpeak;
          console.log(`${arm.id} ${session.id} t${i} (${turn.kind}): hist=${historyTokens} inj=${cell.injectedTokens} ${cell.grade ? (cell.grade.pass ? "pass" : "FAIL") : "-"} CNY=${report.estimatedCny.toFixed(4)}`);
          history = [...base, ...additions, { role: "assistant", content: res.answer }];
        } else {
          console.log(`${arm.id} ${session.id} t${i} (${turn.kind}): hist=${historyTokens} inj=${cell.injectedTokens}`);
          history = [...base, ...additions, { role: "assistant", content: "(offline)" }];
        }
        sessionRow.injectedTokens += cell.injectedTokens;
        report.cells.push(cell); save();
      }
      report.sessionsOut.push(sessionRow); save();
      if (db) { handlers.get("session/disposed")?.(liveSession); store.closeAll(); }
    }
  }
  report.status = RUN ? "complete" : "audit-complete";
  if (RUN) {
    const byArm = {};
    for (const row of report.sessionsOut) {
      byArm[row.arm] ??= { sessions: 0, promptTokens: 0, completionTokens: 0, injectedTokens: 0, cost: 0, passed: 0, asked: 0 };
      const a = byArm[row.arm];
      a.sessions += 1; a.promptTokens += row.promptTokens; a.completionTokens += row.completionTokens;
      a.injectedTokens += row.injectedTokens; a.cost += row.cost; a.passed += row.passed; a.asked += row.asked;
    }
    report.summary = byArm;
  }
  save();
  console.log(JSON.stringify({ status: report.status, cells: report.cells.length, calls: report.calls.length, estimatedCny: report.estimatedCny, summary: report.summary }, null, 2));
} catch (err) {
  report.status = "stopped"; report.error = String(err.message || err); save(); throw err;
} finally {
  try { store.closeAll(); } catch { /* ignore */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* sqlite 句柄 */ }
}
