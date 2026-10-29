/** Frozen synthetic pipeline comparison. Run --audit first; --run costs money (<=15 CNY). */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { grade, scenarios, plantScenario, normalizeRecord, SYSTEM, RUBRIC_VERSION } from "./quality-fixtures.mjs";
const args = new Map(process.argv.slice(2).map((s) => { const at = s.indexOf("="); return at < 0 ? [s, true] : [s.slice(0, at), s.slice(at + 1)]; }));
const run = args.has("--run"), budget = Number(args.get("--budget") || 15);
assert.ok(budget > 0 && budget <= 15);
const out = resolve(String(args.get("--out") || `.tmp/cost-quality-2026-10-29/quality-${run ? "online" : "audit"}.json`));
assert.equal(existsSync(out), false, "Use a new output path; never overwrite paid evidence or reset its ledger");
mkdirSync(dirname(out), { recursive: true });
if (run) assert.ok(process.env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY required (value not logged)");
const root = mkdtempSync(join(tmpdir(), "dsh-quality-v2-"));
process.env.DSH_HOME = join(root, "home"); process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const store = await import("../lib/store.js"), revisions = await import("../lib/revisions.js");
const { registerTools } = await import("../lib/tools.js");
const tools = new Map();
registerTools({ effect: (f) => f(), tools: { register: (t) => { tools.set(t.name, t); return () => {}; } }, on() {} }, {});
const defs = ["ctx_find", "ctx_read"].map((name) => { const t = tools.get(name); return { type: "function", function: { name, description: t.description, parameters: t.parameters } }; });
const report = { rubric: RUBRIC_VERSION, model: "deepseek-flash", thinking: "disabled", temperature: 0, budgetCny: budget,
  pricesCnyPerMillion: { input: 2, cached: 0.04, output: 8 }, priceSource: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  protocolHash: createHash("sha256").update(readFileSync(new URL("./quality-fixtures.mjs", import.meta.url))).digest("hex"),
  status: "running", estimatedCny: 0, reservedOrChargedCny: 0, calls: [], results: [] };
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
const hash = (s) => createHash("sha256").update(s).digest("hex");
async function call(messages, toolDefs, final, trial, maxTokens = 600) {
  assert.ok(run);
  const body = { model: report.model, messages, temperature: 0, thinking: { type: "disabled" }, max_tokens: maxTokens, stream: false,
    ...(toolDefs ? { tools: toolDefs, tool_choice: final ? "none" : "auto" } : {}) };
  // UTF-8 byte count bounds normal tokenizer input; extra framing allowance is intentionally generous.
  const reserve = (Buffer.byteLength(JSON.stringify(body), "utf8") + 16_384) * 2e-6 + maxTokens * 8e-6;
  assert.ok(report.reservedOrChargedCny + reserve <= budget, "Budget exhausted before request; no request sent");
  const receipt = { trial, reservedCny: reserve, state: "reserved" }; report.calls.push(receipt);
  report.reservedOrChargedCny += reserve; save();
  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Provider HTTP ${response.status}`);
    const json = await response.json();
    receipt.model = json.model; receipt.usage = json.usage; receipt.response = json.choices;
    const u = json.usage;
    if (!u || !Number.isFinite(u.prompt_tokens) || !Number.isFinite(u.completion_tokens)) throw new Error("Missing usage; keep full reservation and stop");
    const cached = Math.min(u.prompt_tokens, Math.max(0, Number(u.prompt_cache_hit_tokens || 0)));
    const cost = (u.prompt_tokens - cached) * 2e-6 + cached * 0.04e-6 + u.completion_tokens * 8e-6;
    receipt.estimatedCny = cost; receipt.state = "complete";
    report.estimatedCny += cost; report.reservedOrChargedCny += cost - reserve; save();
    assert.ok(report.reservedOrChargedCny <= budget && cost <= reserve, "Conservative reservation exceeded; stop");
    assert.ok(json.choices?.[0]?.message, "Provider returned no message");
    return json.choices[0].message;
  } catch (err) { receipt.error = err.message; receipt.state = "stopped"; save(); throw err; }
}
async function answer(sc, arm, planted, trial) {
  const messages = [{ role: "system", content: SYSTEM }];
  if (arm === "plain-all") messages.push({ role: "user", content: `完整记忆材料（含历史和无关记录）：\n${planted.corpus}` });
  messages.push({ role: "user", content: sc.question });
  const before = report.estimatedCny;
  for (let round = 0; round <= 4; round++) {
    const msg = await call(messages, arm === "graph-tools" ? defs : null, round === 4, { ...trial, round });
    messages.push(msg);
    if (!msg.tool_calls?.length) return { answer: String(msg.content || ""), transcript: messages, estimatedCny: report.estimatedCny - before };
    assert.ok(arm === "graph-tools" && round < 4 && msg.tool_calls.length <= 8, "Tool loop limit exceeded");
    for (const tc of msg.tool_calls) {
      assert.ok(["ctx_find", "ctx_read"].includes(tc.function.name), "No write tools permitted");
      let result;
      try {
        result = String(await tools.get(tc.function.name).execute(JSON.parse(tc.function.arguments), planted.exec));
        if (tc.function.name === "ctx_read" && result.startsWith("{")) result = JSON.stringify(normalizeRecord(JSON.parse(result)));
      } catch (err) { result = `tool error: ${err.message}`; }
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
  throw new Error("No final answer");
}
try {
  const paths = new Set();
  if (args.has("--extraction")) {
    assert.ok(run, "Extraction sanity requires --run");
    const { pathToFileURL } = await import("node:url");
    const before = await import(pathToFileURL(resolve(".tmp/cost-quality-2026-10-29/baseline/lib/extract.js")).href);
    const after = await import("../lib/extract.js");
    const fixtures = [
      { id: "E01", turns: [{ role: "user", text: "记住，以后发布 AuroraService 都先运行 gate-79.mjs，不要跳过验收。" }], rubric: "保留 gate-79.mjs 和不能跳过验收，不反转否定" },
      { id: "E02", turns: [{ role: "user", text: "采用方案 BluePlan：2027-01-12 复盘，但这不是决策失效日期。" }], rubric: "决策含日期；不生成 until/untilAt" },
      { id: "E03", turns: [{ role: "user", text: "AuroraService 的配置改好了。AuroraService 的测试也好了。" }], rubric: "可形成 AuroraService 实体，不虚构偏好" },
      { id: "E04", turns: [{ role: "tool", name: "compile", turn: 1, ok: false, text: "missing sdk" }, { role: "tool", name: "compile", turn: 1, ok: true, text: "installed sdk, compile ok" }], rubric: "经验保留先失败后成功的顺序及修复动作" },
      { id: "E05", turns: [{ role: "user", text: "只改这份文件的标题。" }], rubric: "不生成持久偏好或决定" },
      { id: "E06", turns: [{ role: "user", text: "谢谢！" }, { role: "assistant", text: "好的。" }], rubric: "无候选；新版不发模型请求" },
    ];
    for (const f of fixtures) for (const [arm, module] of [["before", before], ["after", after]]) {
      const cwd = join(root, f.id, arm); paths.add(cwd);
      const db = await store.openWorkspaceDb(cwd), captures = [];
      const result = await module.distill({ db, turns: f.turns, sessionId: "synthetic-extraction", llmCall: async (prompt) => {
        const msg = await call([{ role: "user", content: prompt }], null, false, { scenario: f.id, arm }, 400);
        captures.push({ prompt, response: msg }); return msg.content || "";
      } });
      report.results.push({ scenario: f.id, arm, turns: f.turns, rubric: f.rubric, result, captures, stored: (db.allNodeIds() || []).map((id) => db.get(Number(id))?.payload).filter((p) => p?.type !== "workspace") });
      save(); store.closeAll(); console.log(`${f.id} ${arm}; CNY ${report.estimatedCny.toFixed(4)}`);
    }
  } else {
  for (let rep = 0; rep < 3; rep++) for (const sc of scenarios(rep)) {
    let corpusHash;
    const arms = ["none", "plain-all", "graph-tools"]; const order = [...arms.slice(rep), ...arms.slice(0, rep)];
    for (const arm of order) {
      const planted = await plantScenario({ root, rep, arm, scenario: sc, store, revisions, tools, join });
      assert.ok(!paths.has(planted.cwd)); paths.add(planted.cwd);
      const currentHash = hash(planted.corpus);
      if (corpusHash) assert.equal(currentHash, corpusHash, "The arms must receive the same complete corpus");
      corpusHash = currentHash;
      const trial = { rep, scenario: sc.id, arm };
      const result = { ...trial, corpusHash, gold: sc.gold, ...(run ? await answer(sc, arm, planted, trial) : { corpus: planted.records, question: sc.question }) };
      if (run) result.grade = grade(result.answer, sc.gold);
      report.results.push(result); save();
      if (run) console.log(`${sc.id} rep=${rep} ${arm}: ${result.grade.pass ? "pass" : "FAIL"}; total estimate CNY ${report.estimatedCny.toFixed(4)}`);
      store.closeAll();
    }
  }
  }
  report.uniqueWorkspaces = paths.size;
  report.status = run ? "complete" : "audit-complete";
  if (run && !args.has("--extraction")) report.summary = Object.fromEntries(["none", "plain-all", "graph-tools"].map((arm) => { const rows = report.results.filter((r) => r.arm === arm); return [arm, { passed: rows.filter((r) => r.grade.pass).length, total: rows.length, estimatedCny: rows.reduce((n, r) => n + r.estimatedCny, 0) }]; }));
  save(); console.log(JSON.stringify({ status: report.status, workspaces: paths.size, modelCalls: report.calls.length, estimatedCny: report.estimatedCny, summary: report.summary }));
} catch (err) { report.status = "stopped"; report.error = err.message; save(); throw err; }
finally { store.closeAll(); rmSync(root, { recursive: true, force: true }); }
