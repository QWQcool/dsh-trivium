/**
 * P37: 定位 C4 S07「六条并列只进三条」的失败类（不是猜测）。
 *
 * C4 当时的假设是「注入装配层把结构相似的三条折掉了」。D0 改了 topK 之后复测
 * 变成 18/18，但「为什么」没有单独取证。这里做 A/B 归因：
 *
 *   A. 用旧形状的 topK=3 取候选 → 3 条到达，预算只用了约 89/300，
 *      dropped 里**没有** duplicate-node / duplicate-in-turn —— 说明不是去重。
 *   B. 用现行 topK=8 → 6 条全部到达，同样没有去重丢弃。
 *
 * 结论：失败类是「预算之前的一处未文档化的候选条数上限」，不是内容折叠。
 * 该断言防止将来有人把去重/相似度折叠加回来却让 p35 仍然只是"恰好 6 条"。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "dsh-trivium-p37-"));
process.env.DSH_TRIVIUM_SETTINGS = join(home, "settings.json");
process.env.DSH_HOME = join(home, "dsh-home");

const store = await import("../lib/store.js");
const { selectContextRecords, renderContextRecords, TURN_ADDITIONAL_BUDGET } = await import("../lib/context-budget.js");
const { makeRevisionResolver } = await import("../lib/revisions.js");

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

const QUERY = "列出全部六条“联调约定”的编号。";
const DEDUPE_REASONS = new Set(["duplicate-node", "duplicate-in-turn", "already-in-map", "empty"]);

try {
  const ws = join(home, "ws");
  const db = await store.openWorkspaceDb(ws);

  // Same shape as quality-fixtures S07: six facts, one shared prefix, distinct ids and codes.
  const codes = [1, 2, 3, 4, 5, 6].map((i) => `QAF${i}`);
  const bodies = ["环境隔离", "版本固定", "种子记录", "失败样本", "回滚方案", "验收门槛"];
  for (const [i, code] of codes.entries()) {
    store.insertNode(db, {
      type: "decision",
      name: `联调约定${i + 1}`,
      text: `先跑基线。联调约定编号 ${code}，关注${bodies[i]}。`,
    });
  }

  const plan = (topK) => {
    const hits = store
      .searchNodes(db, QUERY, { topK, expandDepth: 1, includeStale: false })
      .slice(0, topK)
      .map((hit) => store.formatHit(db, hit, { includeWorkspace: false }));
    const selected = selectContextRecords({
      pins: [],
      recall: hits,
      corrections: [],
      budget: TURN_ADDITIONAL_BUDGET,
      form: "autoRecall",
      delivered: new Set(),
      mapText: "",
      resolveCurrent: makeRevisionResolver(db),
    });
    return { hits, selected, text: renderContextRecords(selected, { form: "autoRecall" }).recall.text };
  };

  const oldShape = plan(3);
  check(oldShape.hits.length === 3, "OLD-37 the legacy topK=3 yields only three candidates", String(oldShape.hits.length));
  check(oldShape.selected.records.length === 3, "OLD-37 three records reach the injection", String(oldShape.selected.records.length));
  check(oldShape.selected.tokens < TURN_ADDITIONAL_BUDGET, "OLD-37 the budget was never the limiter", `${oldShape.selected.tokens}/${TURN_ADDITIONAL_BUDGET}`);
  check(
    oldShape.selected.dropped.every((d) => !DEDUPE_REASONS.has(d.reason)),
    "OLD-37 nothing was deduplicated away; the cap sat before the budget",
    JSON.stringify(oldShape.selected.dropped),
  );

  const current = plan(8);
  check(current.hits.length === 6, "NOW-37 all six candidates are produced", String(current.hits.length));
  check(current.selected.records.length === 6, "NOW-37 all six are selected", String(current.selected.records.length));
  check(current.selected.tokens <= TURN_ADDITIONAL_BUDGET, "NOW-37 the shared budget still holds", `${current.selected.tokens}/${TURN_ADDITIONAL_BUDGET}`);
  check(
    codes.every((c) => current.text.includes(c)),
    "NOW-37 every code is in the rendered text",
    codes.filter((c) => !current.text.includes(c)).join(","),
  );
  check(
    current.selected.dropped.length === 0,
    "NOW-37 no record is dropped at the current shape",
    JSON.stringify(current.selected.dropped),
  );

  // Distinct ids must never be folded because their bodies look alike.
  const ids = current.selected.records.map((r) => r.id);
  check(new Set(ids).size === 6, "NOW-37 six distinct ids, no content folding", ids.join(","));

  store.closeAll();
} finally {
  try {
    store.closeAll();
  } catch {}
  rmSync(home, { recursive: true, force: true });
  console.log(`\nP37 S07 failure class: ${checks - failed}/${checks} passed`);
  assert.equal(failed, 0, `${failed} check(s) failed`);
}
