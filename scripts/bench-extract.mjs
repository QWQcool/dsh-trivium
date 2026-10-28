#!/usr/bin/env node
/**
 * C2d：抽取成本基线（零模型调用）。
 *
 * 只回答两个问题，分开测量、分开标注：
 *   A. 单次抽取的提示词有多大 —— 用真实的 `distill()` + 桩 llmCall 实测，不是估算。
 *   B. 一天会触发多少次抽取 —— 离散事件模拟（**模拟，不是实测**），因为真实计时器
 *      是 setTimeout(12000)，等到 40 条消息要等几十分钟。
 *
 * 不请求模型、不写用户 .dsh。
 * 用法：node scripts/bench-extract.mjs [--messages=40] [--seed=20261029]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "../lib/tokens.js";
import { distill } from "../lib/extract.js";
import { openWorkspaceDb, closeAll } from "../lib/store.js";

const args = new Map(
  process.argv.slice(2).map((raw) => {
    const [k, v = "true"] = raw.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const MESSAGES = Math.max(4, Number(args.get("messages") || 40));
const SEED = Number(args.get("seed") || 20261029);

function lcg(s) {
  let state = s >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
const rand = lcg(SEED);

/* ---------- A. 单次抽取的提示词规模（真实 distill） ---------- */

const FAKE_REPLY = "[]";
const samples = [];

async function measurePrompt(totalMessages) {
  const root = mkdtempSync(join(tmpdir(), `bench-extract-${totalMessages}-`));
  const db = await openWorkspaceDb(root);
  const turns = [];
  for (let i = 0; i < totalMessages; i++) {
    const isUser = i % 2 === 0;
    turns.push({
      role: isUser ? "user" : "assistant",
      // 真实会话里用户更短、助手更长；长度写死便于跨版本比较
      text: isUser
        ? `第 ${i} 条：这个方案我倾向于先跑基线再改，别直接上召回策略。`.repeat(2)
        : `第 ${i} 条回复：先写测量脚本，固定种子与版本，再决定是否动阈值。`.repeat(2),
      turn: Math.floor(i / 2),
    });
  }
  let prompt = "";
  let calls = 0;
  await distill({
    db,
    turns,
    sessionId: "bench-session",
    log: { warn: () => {} },
    llmCall: async (p) => {
      calls += 1;
      prompt = String(p || "");
      return FAKE_REPLY;
    },
  });
  closeAll();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 句柄可能未释放 */ }
  return {
    messages: totalMessages,
    llmCalls: calls,
    promptChars: prompt.length,
    promptTokens: estimateTokens(prompt),
    // 输出侧按"若干候选 JSON"估：真实调用由模型决定，这里只给量级参照
    assumedOutputTokens: 200,
  };
}

for (const n of [6, 20, MESSAGES]) samples.push(await measurePrompt(n));

/* ---------- B. 一天触发多少次（离散事件模拟，非实测） ---------- */

/**
 * 时间轴模型：一天 MESSAGES 条用户消息，成簇发送。
 * 簇内相邻消息间隔 20–40 s（人在读/打字），簇间 4–10 min（去干别的事）。
 * 每个用户消息后紧跟一条助手回复（间隔 3–8 s）。
 */
function timeline(n, seed) {
  const r = lcg(seed);
  const events = [];
  let t = 0;
  let i = 0;
  while (i < n) {
    const burst = 2 + Math.floor(r() * 3); // 每簇 2–4 条
    for (let k = 0; k < burst && i < n; k++, i++) {
      t += k === 0 ? 3000 : 20000 + r() * 20000;
      events.push({ at: t, kind: "user" });
      t += 3000 + r() * 5000;
      events.push({ at: t, kind: "assistant" });
    }
    t += 240000 + r() * 360000; // 4–10 分钟
  }
  return events;
}

/**
 * 两种触发策略。P1 是现状（12 s 静默就抽），P2 是建议值（60 s 或累积 6 条，二者取或）。
 * 冷却期都为 0 与 300 s 各跑一次，看冷却本身贡献多少。
 */
function simulate(events, { idleMs, minMessages, cooldownMs }) {
  let fired = 0;
  let dirtySince = null; // 有未抽取内容的起始时间
  let pendingMessages = 0;
  let lastFire = -Infinity;
  let lastEventAt = 0;
  for (const e of events) {
    const gap = e.at - lastEventAt;
    // 事件到来：先结算"上一轮静默"是否已经达到阈值
    if (dirtySince !== null && gap >= idleMs && lastEventAt - lastFire >= cooldownMs) {
      fired += 1;
      lastFire = lastEventAt;
      dirtySince = null;
      pendingMessages = 0;
    }
    lastEventAt = e.at;
    if (e.kind === "user") {
      if (dirtySince === null) dirtySince = e.at;
      pendingMessages += 1;
      if (pendingMessages >= minMessages && e.at - lastFire >= cooldownMs) {
        fired += 1;
        lastFire = e.at;
        dirtySince = null;
        pendingMessages = 0;
      }
    }
  }
  // 收尾：一天结束时若还有未抽内容，会再抽一次
  if (dirtySince !== null) fired += 1;
  return fired;
}

const events = timeline(MESSAGES, SEED);

/* ---------- 输出 ---------- */

const mid = samples.find((s) => s.messages === 20) || samples[0];
const big = samples[samples.length - 1];
const perCallTokens = big.promptTokens + big.assumedOutputTokens;

const policies = [
  { name: "P1 现状：静默 12 s", idleMs: 12000, minMessages: 9999, cooldownMs: 0 },
  { name: "P1+冷却：12 s + 5 min 冷却", idleMs: 12000, minMessages: 9999, cooldownMs: 300000 },
  { name: "P2 建议：静默 60 s", idleMs: 60000, minMessages: 9999, cooldownMs: 0 },
  { name: "P2+批量：60 s 或累积 6 条", idleMs: 60000, minMessages: 6, cooldownMs: 300000 },
  { name: "P2+批量，且 5 min 冷却", idleMs: 60000, minMessages: 6, cooldownMs: 0 },
];

const rows = policies.map((p) => {
  const fires = simulate(events, p);
  return {
    policy: p.name,
    firesPerDay: fires,
    promptTokens: fires * big.promptTokens,
    totalTokens: fires * perCallTokens,
    savedVsP1: null,
  };
});
const base = rows[0].totalTokens || 1;
for (const r of rows) r.savedVsP1 = `${Math.round((1 - r.totalTokens / base) * 100)}%`;

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  node: process.version,
  seed: SEED,
  messagesPerDay: MESSAGES,
  measurement: {
    promptSize: "真实 distill() + 桩 llmCall，estimateTokens 计数（不是供应商计费值）",
    triggerCount: "离散事件模拟，不是实测；真实计时器为 setTimeout(12000)",
    outputTokens: "按每次 200 估算，仅用于量级对比",
  },
  promptSamples: samples,
  perCall: { promptTokens: big.promptTokens, assumedOutputTokens: big.assumedOutputTokens, total: perCallTokens },
  triggerSimulation: rows,
  note20: mid ? `20 条消息时单次提示词 ${mid.promptTokens} token` : null,
}, null, 2));
