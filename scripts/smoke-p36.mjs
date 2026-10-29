/**
 * P36: 抽取内容门控（D2 §5.1 的落地回归）。
 *
 * D2 实测：同一批 10 轮会话里 5 个用户轮中只有 1 轮带约定，其余是
 * 「继续推进第 N 项」这类填充轮；按轮调用时 5 次/会话（1038 prompt token），
 * 整段一次 1 次/会话（342）。本片把「值不值得调模型」做成显式判断：
 *
 *   - 只跳过**短、无线索、无专名**的推进句；
 *   - 工具失败窗口仍然调用（可能形成 experience）；
 *   - 跳过时不吞掉规则候选（规则零成本照常写入）；
 *   - 跳过原因写进返回值和运行状态，不静默。
 *
 * 全部临时库、零模型调用（llmCall 是本地计数桩）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "dsh-trivium-p36-"));
process.env.DSH_TRIVIUM_SETTINGS = join(home, "settings.json");
process.env.DSH_HOME = join(home, "dsh-home");

const store = await import("../lib/store.js");
const extract = await import("../lib/extract.js");

let checks = 0;
let failed = 0;
function check(ok, label, detail = "") {
  checks += 1;
  if (ok) console.log("ok  " + label);
  else {
    failed += 1;
    console.error("FAIL " + label + (detail ? ": " + detail : ""));
  }
}

/** Same 5-user-turn shape as D2, so the gate is measured on the corpus that motivated it. */
const D2_TURNS = [
  { role: "user", text: "先记三条约定：技术视频首选标签为 DEMO-71。 发布前必须执行 CHECK-71 校验。 本工作区通道为 A-71。 收到回 ok 即可。", turn: 0 },
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

const FILLER_TURNS = [
  { role: "user", text: "继续推进第 1 项，回一句当前状态即可。", turn: 0 },
  { role: "assistant", text: "第 1 项进行中。", turn: 0 },
  { role: "user", text: "下一步。", turn: 1 },
  { role: "assistant", text: "好。", turn: 1 },
];

try {
  /* ---------- 单元：填充轮判定 ---------- */
  check(extract.isFillerTurn("继续推进第 2 项，回一句当前状态即可。"), "UNIT-36 a continuation turn is filler");
  check(extract.isFillerTurn("先别管这些，把今天的进度用一句话整理一下。"), "UNIT-36 a progress-summary request is filler");
  check(extract.isFillerTurn("下一步。"), "UNIT-36 a bare next-step is filler");
  check(extract.isFillerTurn("   "), "UNIT-36 whitespace is filler");
  check(!extract.isFillerTurn("先记三条约定：技术视频首选标签为 DEMO-71。"), "UNIT-36 the fact-bearing turn is not filler");
  check(!extract.isFillerTurn("下周再改这个接口。"), "UNIT-36 an explicit decision cue is not filler");
  check(!extract.isFillerTurn("以后都用 SQLite。"), "UNIT-36 an explicit preference cue is not filler");
  check(!extract.isFillerTurn("继续 MemoryBridge 的处理。"), "UNIT-36 a name-bearing turn is not filler");
  check(!extract.isFillerTurn("继续用 ORD-42 下单。"), "UNIT-36 an id-like token is not filler even when the rule layer calls it noise");
  check(!extract.isFillerTurn("继续" + "把这一段说明补全。".repeat(10)), "UNIT-36 a long turn is not filler");

  /* ---------- 批次判定 ---------- */
  const d2 = extract.shouldExtractBatch(D2_TURNS);
  check(d2.call === true && d2.reason === "user-content", "GATE-36 the D2 window is worth one call", d2.reason);
  const filler = extract.shouldExtractBatch(FILLER_TURNS);
  check(filler.call === false && filler.reason === "filler-only", "GATE-36 a filler-only window is skipped", filler.reason);
  const toolFail = extract.shouldExtractBatch([
    { role: "user", text: "继续推进第 1 项。", turn: 0 },
    { role: "tool", name: "build", ok: false, text: "ENOENT", turn: 0 },
    { role: "tool", name: "build", ok: true, text: "ok", turn: 0 },
  ]);
  check(toolFail.call === true && toolFail.reason === "tool-failure", "GATE-36 a tool failure still calls the model", toolFail.reason);
  const toolOk = extract.shouldExtractBatch([
    { role: "user", text: "继续推进第 1 项。", turn: 0 },
    { role: "tool", name: "build", ok: true, text: "ok", turn: 0 },
  ]);
  check(toolOk.call === false, "GATE-36 a successful tool call alone is not a reason to call", toolOk.reason);

  /* ---------- 真实 distill：调用次数 ---------- */
  const cwd = join(home, "ws");
  const db = await store.openWorkspaceDb(cwd);
  let calls = 0;
  const llmCall = async () => {
    calls += 1;
    return JSON.stringify({
      candidates: [
        { type: "preference", name: "DEMO-71", text: "记住：技术视频首选标签为 DEMO-71。", quote: "首选标签为 DEMO-71" },
      ],
    });
  };

  const first = await extract.distill({ db, turns: D2_TURNS, sessionId: "s-d2", llmCall });
  check(calls === 1, "INT-36 the D2 window costs exactly one model call", String(calls));
  check(first.gate?.skipped === false, "INT-36 the call is not reported as skipped");
  check(first.applied.length >= 1, "INT-36 the model fact is still written", JSON.stringify(first.applied));

  const before = calls;
  const second = await extract.distill({ db, turns: FILLER_TURNS, sessionId: "s-filler", llmCall });
  check(calls === before, "INT-36 a filler-only window makes no call", String(calls - before));
  check(second.gate?.skipped === true && second.gate?.reason === "filler-only", "INT-36 the skip is reported, not silent", JSON.stringify(second.gate));
  check(second.llmFailed === false, "INT-36 a skipped window is not a failure");

  /* ---------- 门控窗口仍然走规则通道，且不抛错 ---------- */
  const gatedWindow = await extract.distill({
    db,
    turns: [{ role: "user", text: "下一步。", turn: 0 }],
    sessionId: "s-gated",
    llmCall: async () => {
      throw new Error("must not be called");
    },
  });
  check(gatedWindow.llmFailed === false, "INT-36 a gated window does not treat the missing call as a failure");
  check(gatedWindow.gate?.reason === "filler-only", "INT-36 the gated window reports why", JSON.stringify(gatedWindow.gate));

  /* ---------- 规则通道不依赖模型：模型失败时规则候选照常写入 ---------- */
  const rulesOnly = await extract.distill({
    db,
    turns: [
      { role: "user", text: "以后都用 DEMO-71 通道。收到回 ok 即可。", turn: 0 },
      { role: "user", text: "以后都用 DEMO-71 通道。", turn: 1 },
    ],
    sessionId: "s-rules",
    llmCall: async () => {
      throw new Error("provider down");
    },
  });
  check(rulesOnly.llmFailed === true, "INT-36 a model failure is reported even when rules wrote something");
  check(/DEMO-71/.test(JSON.stringify(rulesOnly.applied)), "INT-36 rules still write while the model is down", JSON.stringify(rulesOnly.applied));

  /* ---------- 失败仍可见 ---------- */
  const failing = await extract.distill({
    db,
    turns: D2_TURNS,
    sessionId: "s-fail",
    llmCall: async () => {
      throw new Error("provider down");
    },
  });
  check(failing.llmFailed === true, "INT-36 a failed call is still reported as failed");
  check(failing.gate?.skipped === false, "INT-36 a failed call is not reported as a gate skip");

  /* ---------- 没有 llmCall 时不算「跳过」 ---------- */
  const noLlm = await extract.distill({ db, turns: FILLER_TURNS, sessionId: "s-nollm" });
  check(noLlm.gate?.skipped === false, "INT-36 no llmCall means nothing was skipped");

  store.closeAll();
} finally {
  try {
    store.closeAll();
  } catch {}
  rmSync(home, { recursive: true, force: true });
  console.log(`\nP36 extraction gate: ${checks - failed}/${checks} passed`);
  assert.equal(failed, 0, `${failed} check(s) failed`);
}
