#!/usr/bin/env node
/**
 * D3 抽取门控重放：D2「按轮调用 5 次/会话」里有几次其实是填充轮。
 *
 * 零模型调用。用的是 D2 的同一批会话稿与 D2 实测的 per-turn 费用
 * （docs/evidence/2026-10-29-d2-extract-cost.json），所以这里输出的是
 * **计算值**，不是新一轮实测；要新的真账请跑 bench-extract-cost.mjs --run。
 *
 *   node scripts/bench-extract-gate.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "..");
const extract = await import(pathToFileURL(resolve(REPO, "lib/extract.js")).href);
const evidence = JSON.parse(readFileSync(resolve(REPO, "docs/evidence/2026-10-29-d2-extract-cost.json"), "utf8"));

const SESSIONS = [
  { id: "s1", facts: ["技术视频首选标签为 DEMO-71。", "发布前必须执行 CHECK-71 校验。", "本工作区通道为 A-71。"] },
  { id: "s2", facts: ["订单号前缀固定为 ORD-42。", "退款必须走 RMA-42 流程。", "客服邮箱是 help42@example.com。"] },
  { id: "s3", facts: ["默认超时设为 45 秒。", "重试次数上限为 3 次。", "降级开关名为 SAFE-45。"] },
];

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

const measuredPerTurn = evidence.summary?.perTurn?.costOffpeak ?? null;
const measuredCalls = evidence.summary?.perTurn?.calls ?? null;
if (measuredPerTurn === null || !measuredCalls) throw new Error("D2 证据缺少 perTurn 汇总，不能凭空算费用");

const rows = [];
for (const s of SESSIONS) {
  const turns = transcriptOf(s);
  const users = turns.filter((t) => t.role === "user");
  const perTurnCalls = users.filter((t) => extract.shouldExtractBatch([t, { role: "assistant", text: "ack", turn: t.turn }]).call).length;
  const wholeWindow = extract.shouldExtractBatch(turns);
  rows.push({
    session: s.id,
    userTurns: users.length,
    perTurnCallsWithoutGate: users.length,
    perTurnCallsWithGate: perTurnCalls,
    wholeWindowCallsWithGate: wholeWindow.call ? 1 : 0,
    gateReason: wholeWindow.reason,
    fillerTurns: users.filter((t) => extract.isFillerTurn(t.text)).length,
  });
}

const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
const before = measuredPerTurn;
const keptLabels = new Set(SESSIONS.flatMap(s => transcriptOf(s).filter(t => t.role === "user" && extract.shouldExtractBatch([t, { role:"assistant", text:"ack" }]).call).map(t => `perTurn/${s.id}/t${t.turn}`)));
const retained = evidence.calls.filter(c => keptLabels.has(c.label));
if (retained.length !== keptLabels.size) throw Error("Missing retained-call receipts");
const afterPerTurn = retained.reduce((n,c) => n + c.costOffpeak, 0);
const afterWindow = evidence.summary.batch.costOffpeak; // separately measured, never average per-turn cost

console.log("D3 gate replay (calculated from D2 measured usage, no new model calls)\n");
for (const r of rows) console.log(`${r.session}  user=${r.userTurns}  filler=${r.fillerTurns}  perTurn ${r.perTurnCallsWithoutGate}->${r.perTurnCallsWithGate}  window->${r.wholeWindowCallsWithGate} (${r.gateReason})`);
console.log(`\ncalls: perTurn ${sum("perTurnCallsWithoutGate")} -> ${sum("perTurnCallsWithGate")}; window -> ${sum("wholeWindowCallsWithGate")}`);
console.log(`cost (offpeak, historical receipt selection; NOT new measured savings): perTurn ¥${before.toFixed(5)} -> ¥${afterPerTurn.toFixed(5)}; window ¥${afterWindow.toFixed(5)}`);
console.log("\nCaveat: D2's per-turn arm is a stress shape. The shipped scheduler already batches by");
console.log("60 s idle / 12 turns, so the gate's real saving is limited to windows that contain");
console.log("nothing extractable. This script does not claim a measured end-to-end cost change.");
