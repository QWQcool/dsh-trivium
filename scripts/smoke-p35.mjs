/**
 * P35: 注入完整性的两条回归（C4 实测暴露的两个缺陷）。
 *
 * 1. S07「六条并列事实」只注入三条 —— 根因不是预算（只用了 89/300），而是
 *    `recallCandidates()` 里写死的 `topK: 3` + `slice(0, 3)`。预算才是真正的约束，
 *    这里钉住：预算够时六条必须全部到达。
 * 2. S05「长正文答案在尾部」被 200 字**只留头**的截断吃掉 —— 决策是「尾部保底」，
 *    这里钉住：结论在尾部时必须仍在注入文本里，且单条仍受 200 字上限约束。
 *
 * 全部走真实 pre-step（plugin.apply + agent/pre-step），临时库，零模型调用。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "dsh-trivium-p35-"));
process.env.DSH_TRIVIUM_SETTINGS = join(home, "settings.json");
process.env.DSH_HOME = join(home, "dsh-home");

const store = await import("../lib/store.js");
const settings = await import("../lib/settings.js");
const { preserveEnds, L0_MAX_CHARS, renderContextRecords, selectContextRecords } = await import("../lib/context-budget.js");
const { makeRevisionResolver } = await import("../lib/revisions.js");
const { estimateTokens } = await import("../lib/tokens.js");
const plugin = await import("../lib/index.js");

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

try {
  /* ---------- 单元：尾部保底 ---------- */
  const long = `${"背景记录。".repeat(55)}最终验收命令为 verify-QA-71.mjs。`;
  const clipped = preserveEnds(long, L0_MAX_CHARS);
  check(clipped.length <= L0_MAX_CHARS, "UNIT-35 clipped body never exceeds the cap", String(clipped.length));
  check(clipped.includes("verify-QA-71.mjs"), "UNIT-35 the tail (the answer) survives", clipped.slice(-40));
  check(clipped.startsWith("背景记录。"), "UNIT-35 the head is still there for context");
  check(clipped.includes("…"), "UNIT-35 the omission is visible, not silent");
  check(preserveEnds("短事实。", L0_MAX_CHARS) === "短事实。", "UNIT-35 short bodies are untouched");

  /* ---------- 真实 pre-step ---------- */
  const handlers = new Map();
  const ctx = {
    logger: () => ({ warn() {}, info() {}, error() {} }),
    inject(_deps, fn) { fn(ctx); },
    on(name, fn) { handlers.set(name, fn); return () => {}; },
    effect(fn) { fn(); return () => {}; },
    tools: { register: () => () => {} },
  };
  plugin.apply(ctx, {});
  settings.writeUiSettings({ recallMode: "auto", chipsEnabled: false, extractEnabled: false, gitSidecarEnabled: false });

  const preStep = handlers.get("agent/pre-step");
  assert.equal(typeof preStep, "function", "agent/pre-step registered");
  const message = (id, text) => ({ id, source: { kind: "user" }, content: [{ type: "text", text }] });
  const textsOf = (decision) => (decision.messages || []).flatMap((m) => m.content || []).map((x) => x.text || "").join("\n");

  const ws = join(home, "ws");
  const db = await store.openWorkspaceDb(ws);
  const codes = [1, 2, 3, 4, 5, 6].map((i) => `QA${i}-71`);
  for (const [i, code] of codes.entries()) {
    store.insertNode(db, { type: "decision", name: `联调约定${i + 1}`, text: `先跑基线。联调约定编号 ${code}，关注事项 ${i + 1}。` });
  }
  // 噪音：同库再加 6 条无关事实，确保命中不是全库回吐
  for (let i = 0; i < 6; i += 1) store.insertNode(db, { type: "entity", name: `旁支${i}`, text: `无关设备编号 DEVICE-${i}。` });

  const six = await preStep(
    { agent: { session: { id: "p35-six", header: { cwd: ws } } }, messages: [message("p35-six-1", "列出全部六条联调约定的编号。")] },
    async () => ({ kind: "enter", messages: [] }),
  );
  const sixText = textsOf(six);
  const present = codes.filter((c) => sixText.includes(c));
  check(present.length === 6, "S07-35 all six parallel facts reach the model when the budget allows", `got ${present.length}/6: ${sixText.slice(0, 160)}`);
  check(estimateTokens(sixText) <= 300, "S07-35 the shared 300-token turn budget still holds", String(estimateTokens(sixText)));
  check(!sixText.includes("DEVICE-3"), "S07-35 unrelated rows are not dragged in", sixText.slice(0, 120));

  const longId = store.insertNode(db, { type: "experience", name: "发布流程", text: long });
  const longTurn = await preStep(
    { agent: { session: { id: "p35-long", header: { cwd: ws } } }, messages: [message("p35-long-1", "“发布流程”的最终验收命令是什么？")] },
    async () => ({ kind: "enter", messages: [] }),
  );
  const longText = textsOf(longTurn);
  check(longText.includes("verify-QA-71.mjs"), "S05-35 a tail-only answer is delivered without ctx_read", longText.slice(-80));
  check(longText.includes(`experience#${longId}`), "S05-35 the long fact is the record that arrived (not another row)");
  const bodyLine = longText.split("\n").find((l) => l.includes(`experience#${longId}`)) || "";
  check(bodyLine.length <= L0_MAX_CHARS + 40, "S05-35 one record still cannot eat the whole turn budget", String(bodyLine.length));

  // 预算仍优先于条数：8 条长事实不可能全进，且必须**整条丢弃**而不是把中间挖掉。
  // 这一段直接测选择层：pre-step 里短地图也会占用同一份 300 预算（真实宿主里地图确实在对话中，
  // 但本 harness 的 fake next() 不携带地图消息），走 pre-step 会把这层记账差异混进断言。
  const many = join(home, "ws-many");
  const dbMany = await store.openWorkspaceDb(many);
  for (let i = 0; i < 8; i += 1) {
    store.insertNode(dbMany, { type: "decision", name: `长约定${i}`, text: `${"长正文".repeat(90)}结论${i}：RUN-${i}-71。` });
  }
  const hitsMany = store.searchNodes(dbMany, "列出全部长约定的结论。", { topK: 8, expandDepth: 1, includeStale: false })
    .map((h) => store.formatHit(dbMany, h, { includeWorkspace: false }));
  const planMany = selectContextRecords({
    pins: [],
    recall: hitsMany,
    corrections: [],
    budget: 300,
    form: "autoRecall",
    delivered: new Set(),
    mapText: store.buildShortMapReport(dbMany, 400).text,
    resolveCurrent: makeRevisionResolver(dbMany),
  });
  const selectedText = renderContextRecords(planMany, { form: "autoRecall" }).recall.text;
  check(planMany.records.length >= 1, "BUDGET-35 a long fact still fits the 300-token turn", String(planMany.records.length));
  check(planMany.tokens <= 300, "BUDGET-35 the cap is honoured", String(planMany.tokens));
  check(planMany.records.every((r) => r.l0.slice(-6).includes("。")), "BUDGET-35 selected bodies end on a record boundary, not mid-word");
  check(planMany.dropped.length >= 1 && planMany.dropped.every((d) => d.reason === "over-budget"), "BUDGET-35 the rest are dropped whole, with an explicit reason", JSON.stringify(planMany.dropped.slice(0, 2)));
  check(selectedText.includes("RUN-"), "BUDGET-35 the selected record still carries its conclusion");
} finally {
  settings.writeUiSettings({ gitSidecarEnabled: false });
  store.closeAll();
  rmSync(home, { recursive: true, force: true });
}

console.log(`P35 injection integrity: ${checks - failed}/${checks} passed`);
if (failed) process.exitCode = 1;
