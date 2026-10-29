#!/usr/bin/env node
/**
 * C4：三方记忆插件的注入对照（预注册见 docs/next-memory/C4-PLAN.md）。
 *
 * 三条硬约束：
 *   1. 三个臂都走**各自的真实插件路径**（真实 apply + 真实 agent/pre-step），不是重写一个"类似"的检索；
 *   2. 每格独立临时库，写入前断言库路径在临时根下（本脚本自己在 2026-10-29 踩过一次写进真实库）；
 *   3. 默认（无 --run）零模型调用，只做离线审计；--run 才花钱，且每请求先预留、超预算立即停。
 *
 * 用法：
 *   node scripts/bench-c4.mjs                       # 离线审计（0 元）
 *   node scripts/bench-c4.mjs --run --budget=15     # 真实模型（≤15 元）
 *
 * 对手装在仓库外（gitignored）：.tmp/c4/goodmemory、.tmp/c4/dsh-memory。
 * 装法与版本见 C4-RESULTS.md；缺目录时该臂记为 unavailable，不静默跳过。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { grade, scenarios, plantScenario, SYSTEM, RUBRIC_VERSION } from "./quality-fixtures.mjs";
import { createModelLedger } from "./model-ledger.mjs";
import { prepareCell, assertInside, fixtureReceipt, digest } from "./experiment-support.mjs";

const args = new Map(process.argv.slice(2).map((s) => { const at = s.indexOf("="); return at < 0 ? [s, true] : [s.slice(0, at), s.slice(at + 1)]; }));
const RUN = args.has("--run");
const BUDGET = Number(args.get("--budget") || 15);
const REPS = Number(args.get("--reps") || 1);
const ONLY_ARMS = String(args.get("--arms") || "").split(",").filter(Boolean);
const MODEL = String(args.get("--model") || "deepseek-flash");
const ONLY_SCENARIOS = String(args.get("--scenarios") || "").split(",").filter(Boolean);
const REPO = resolve(import.meta.dirname, "..");
const GM_DIR = resolve(String(args.get("--goodmemory") || join(REPO, ".tmp/c4/goodmemory")));
const DM_DIR = resolve(String(args.get("--dsh-memory") || join(REPO, ".tmp/c4/dsh-memory")));
const out = resolve(String(args.get("--out") || `.tmp/c4/c4-${RUN ? "online" : "audit"}.json`));

assert.ok(BUDGET > 0 && BUDGET <= 15, "预算必须在 (0, 15] 元");
assert.ok(Number.isInteger(REPS) && REPS > 0, "reps must be a positive integer");
assert.equal(existsSync(out), false, "输出路径必须是新的；不覆盖已付费证据");
mkdirSync(dirname(out), { recursive: true });
if (RUN) assert.ok(process.env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY 缺失（值不落盘）");

// Explicit paths are validated before each plugin opens a store; DSH_HOME does not change os.homedir().
const root = mkdtempSync(join(tmpdir(), "c4-run-"));
process.env.DSH_HOME = join(root, "dsh-home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "trivium-settings.json");
// 我方 pre-step 只有 autoRecall 打开才会注入（bench-injection 同口径：这是测量条件，不是默认行为）
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ recallMode: "auto", extractEnabled: false }), "utf8");

const hash = (s) => createHash("sha256").update(s).digest("hex");
const textOf = (messages) => (messages || []).map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : typeof m.content === "string" ? m.content : "")).join("\n");
const indexHtml = (dir) => { try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { return null; } };

/* ---------- 我方（trivium）真实插件路径 ---------- */
const triviumPkg = indexHtml(REPO);
const trivium = {};
if (triviumPkg) {
  trivium.store = await import(pathToFileURL(join(REPO, "lib/store.js")).href);
  trivium.revisions = await import(pathToFileURL(join(REPO, "lib/revisions.js")).href);
  trivium.tokens = await import(pathToFileURL(join(REPO, "lib/tokens.js")).href);
  const { registerTools } = await import(pathToFileURL(join(REPO, "lib/tools.js")).href);
  const plugin = await import(pathToFileURL(join(REPO, "lib/index.js")).href);
  trivium.toolDefs = (await import(pathToFileURL(join(REPO, "lib/tool-defs.js")).href)).TOOL_DEFS;
  trivium.tools = new Map();
  registerTools({ effect: (fn) => fn(), tools: { register: (t) => { trivium.tools.set(t.name, t); return () => {}; } }, on() {} }, {});
  trivium.handlers = new Map();
  trivium.disposers = [];
  await plugin.apply({
    logger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
    inject: (deps, cb) => { /* 无宿主服务：不触发 */ },
    on: (event, fn) => { trivium.handlers.set(event, fn); return () => {}; },
    effect: (factory) => { try { const d = factory(); if (typeof d === "function") trivium.disposers.push(d); } catch { /* 无宿主 */ } return () => {}; },
    tools: { register: () => ({ dispose: () => {} }) },
  }, {});
  trivium.preStep = trivium.handlers.get("agent/pre-step");
}

/* ---------- 对手包版本 ---------- */
const gmPkg = indexHtml(join(GM_DIR, "node_modules/dsh-goodmemory"));
const gmEnginePkg = indexHtml(join(GM_DIR, "node_modules/goodmemory"));
const dmPkg = existsSync(DM_DIR) ? indexHtml(DM_DIR) : null;

/* ---------- 计费账本（与 bench-quality-v2 同口径） ---------- */
const report = {
  protocol: "C4-R2", plan: "docs/next-memory/C4-PLAN.md", rubric: RUBRIC_VERSION,
  model: MODEL, thinking: "disabled", temperature: 0, maxTokens: 600, reps: REPS,
  budgetCny: BUDGET, pricesCnyPerMillion: { peak: { input: 2, cached: 0.04, output: 8 }, offpeak: { input: 1, cached: 0.02, output: 4 } },
  priceSource: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  costBasis: "budget guard uses peak; reported cost uses off-peak (offpeak = peak/2)",
  environment: {
    node: process.version,
    host: "@deepseek-ai/dsh 0.2.1-rc.4 (peer)",
    trivium: triviumPkg ? { version: triviumPkg.version } : null,
    goodmemory: gmPkg ? { plugin: gmPkg.version, engine: gmEnginePkg?.version, dir: GM_DIR } : { unavailable: `未找到 ${GM_DIR}` },
    dshMemory: dmPkg ? { version: dmPkg.version, engines: dmPkg.engines?.dsh, dir: DM_DIR } : { unavailable: `未找到 ${DM_DIR}` },
  },
  status: "running", estimatedCny: 0, reservedOrChargedCny: 0, calls: [], cells: [],
};
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
// 预算守卫按峰价（上界），对外报数按谷价；两者都由 scripts/pricing.mjs 唯一决定。
const paidCall = createModelLedger({ report, save, budget: BUDGET, model: MODEL });
async function callRaw(body, label) { assert.ok(RUN, "offline audit cannot call a model"); return paidCall(body, label); }

/** Convert one of our tool defs (`{name, description, parameters: {x:{type,required}}}`) to OpenAI shape. */
function openAiTools(defs) {
  return defs.map((d) => ({
    type: "function",
    function: {
      name: d.name,
      description: d.description,
      parameters: {
        type: "object",
        properties: Object.fromEntries(Object.entries(d.parameters || {}).map(([k, v]) => [k, { type: v.type, description: v.description }])),
        required: Object.entries(d.parameters || {}).filter(([, v]) => v.required).map(([k]) => k),
      },
    },
  }));
}

/**
 * One turn, optionally with the plugin's own tools. Every provider call goes
 * through the same budget ledger, so the tool face is charged for what it
 * actually costs instead of being compared as if tools were free.
 */
async function call(messages, label, { tools, exec } = {}) {
  const msgs = [...messages];
  const usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 };
  let cost = 0;
  let costOffpeak = 0;
  let toolCalls = 0;
  const trace = [];
  for (let round = 0; round < 6; round += 1) {
    const body = {
      model: report.model, messages: msgs, temperature: 0, thinking: { type: "disabled" }, max_tokens: 600, stream: false,
      ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
    };
    const res = await callRaw(body, `${label}#${round}`);
    usage.prompt_tokens += res.usage.prompt_tokens;
    usage.completion_tokens += res.usage.completion_tokens;
    usage.prompt_cache_hit_tokens += Number(res.usage.prompt_cache_hit_tokens || 0);
    cost += res.cost;
    costOffpeak += res.costOffpeak;
    const msg = res.message;
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) return { answer: String(msg.content || ""), usage, cost, costOffpeak, toolCalls, trace };
    toolCalls += calls.length;
    msgs.push({ role: "assistant", content: String(msg.content || ""), tool_calls: calls });
    for (const c of calls) {
      let out = "";
      const def = trivium.tools.get(c.function?.name);
      try {
        const args = JSON.parse(c.function?.arguments || "{}");
        out = def ? String(await def.execute(args, exec)) : `unknown tool: ${c.function?.name}`;
      } catch (err) { out = `tool error: ${err.message}`; }
      trace.push({ name: c.function?.name, arguments: c.function?.arguments, output: out });
      msgs.push({ role: "tool", tool_call_id: c.id, content: out });
    }
  }
  return { answer: "", usage, cost, costOffpeak, toolCalls, trace, exhausted: true };
}

/* ---------- 六个场景：只取不用修订链/归档的三方都能表达的 ------------- */
const SCENARIO_IDS = ["S01", "S04", "S05", "S06", "S07", "S09"];
// Every adapter receives the name in the body too; text-only stores must not
// lose information that our named index gets through separate payload fields.
const sharedFact = f => ({ ...f, text: `${f.name}：${f.text}` });
const all = scenarios(0).filter((s) => SCENARIO_IDS.includes(s.id)).map(sc => ({
  ...sc, facts: sc.facts.map(sharedFact), foreign: sc.foreign ? sharedFact(sc.foreign) : undefined,
}));
assert.equal(all.length, SCENARIO_IDS.length, "场景集合必须与预注册一致");

const userMsg = (text) => ({ role: "user", source: { kind: "user" }, content: [{ type: "text", text }] });
let activeCell;
const dirs = () => activeCell;

/* ---------- arm: none / plain-all（共用 trivium 的种植，保证语料同源） ---------- */
async function plantTrivium(rep, sc, arm) {
  return plantScenario({ root: activeCell.cell, rep, arm, scenario: sc, store: trivium.store, revisions: trivium.revisions, tools: trivium.tools, join });
}

/* ---------- arm: trivium-inject ---------- */
async function armTrivium(rep, sc) {
  const planted = await plantTrivium(rep, sc, activeCell.arm);
  const db = await trivium.store.openWorkspaceDb(planted.cwd);
  assert.equal(trivium.store.nodeCountOf(db), sc.facts.length + 1);
  const fixture = fixtureReceipt(sc.facts, planted.ids.map(id => db.get(id).payload.text));
  const maps = [];
  if (!trivium.preStep) throw new Error("agent/pre-step 未注册");
  const decision = await trivium.preStep(
    { agent: { inject: (m) => maps.push(m), session: { id: activeCell.sessionId, header: { cwd: planted.cwd } } }, signal: new AbortController().signal, messages: [userMsg(sc.question)] },
    async () => ({ kind: "enter", messages: [] }),
  );
  const context = textOf([...maps, ...(decision?.messages || [])]);
  return { planted, fixture, context, source: { kind: "trivium-pre-step", bytes: Buffer.byteLength(context, "utf8") }, tokens: trivium.tokens.estimateTokens(context) };
}

/* ---------- arm: goodmemory（每次一桥一库） ---------- */
const gmLauncher = gmPkg ? resolve(GM_DIR, "node_modules/goodmemory/scripts/goodmemory-http-bridge.js") : null;
const gmModule = gmPkg ? await import(pathToFileURL(join(GM_DIR, "node_modules/dsh-goodmemory/lib/index.js")).href) : null;
const gmScopeId = (cwd) => `dsh-workspace:${createHash("sha256").update(resolve(cwd)).digest("hex")}`;

async function armGoodmemory(rep, sc, maxTokens) {
  const { cell, wsA, wsB } = dirs(rep, sc.id);
  mkdirSync(cell, { recursive: true });
  const dbPath = join(cell, "goodmemory.sqlite");
  assert.ok(assertInside(root, dbPath), "拒绝写入非临时库（goodmemory）");
  const token = `c4-${rep}-${sc.id}-${maxTokens}`;
  const child = spawn(process.execPath, [gmLauncher, "--host", "127.0.0.1", "--port", "0", "--recommended"], {
    env: { ...process.env, GOODMEMORY_HTTP_BRIDGE_TOKEN: token, GOODMEMORY_STORAGE_PROVIDER: "sqlite", GOODMEMORY_STORAGE_URL: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
  const errs = [];
  let isReady = false;
  createInterface({ input: child.stderr }).on("line", (l) => errs.push(l.replaceAll(token, "[redacted]")));
  const ready = await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`goodmemory bridge ready 超时: ${errs.slice(-2).join(" | ")}`)), 30_000);
    createInterface({ input: child.stdout }).on("line", (line) => { try { const v = JSON.parse(line); if (v.event === "ready") { isReady = true; clearTimeout(t); ok(v); } } catch { /* 非 ready 行 */ } });
    child.on("exit", (c) => { if (!isReady) { clearTimeout(t); fail(new Error(`bridge 提前退出 code=${c}: ${errs.slice(-2).join(" | ")}`)); } });
  });
  // external 模式在 apply 时读 token 环境变量，必须在 apply 之前设好
  process.env.GOODMEMORY_HTTP_BRIDGE_TOKEN = token;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-goodmemory-user-id": `c4-${rep}-${sc.id}`, "x-goodmemory-operations": "remember" };
  const remember = async (text, no, workspaceId) => {
    const resp = await fetch(`${ready.url}/memory/remember`, {
      method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { ...headers, "x-goodmemory-workspace-id": workspaceId },
      body: JSON.stringify({ idempotencyKey: `${rep}-${sc.id}-${no}`, mode: "sync", scope: { userId: `c4-${rep}-${sc.id}`, workspaceId }, messages: [{ role: "user", content: text, id: `${rep}-${sc.id}-${no}`, observedAt: new Date().toISOString() }] }),
    });
    const body = await resp.json();
    return { status: resp.status, accepted: body?.result?.accepted ?? 0, reasons: [...new Set((body?.result?.events || []).map((e) => e.reason).filter(Boolean))] };
  };
  const planted = [];
  for (const [i, f] of sc.facts.entries()) planted.push(await remember(`记住：${f.text}`, `f${i}`, gmScopeId(wsA)));
  if (sc.foreign) planted.push(await remember(`记住：${sc.foreign.text}`, "foreign", gmScopeId(wsB)));
  const exportedResponse = await fetch(`${ready.url}/memory/export`, {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { ...headers, "x-goodmemory-operations": "export", "x-goodmemory-workspace-id": gmScopeId(wsA) },
    body: JSON.stringify({ scope: { userId: `c4-${rep}-${sc.id}`, workspaceId: gmScopeId(wsA) } }),
  });
  assert.equal(exportedResponse.status, 200, "Need durable export to audit ingestion");
  const fixtureExport = await exportedResponse.json();
  const durable = fixtureExport.exported?.durable?.facts;
  assert.ok(Array.isArray(durable), "Unknown durable export schema");
  const canonical = text => String(text).trim().replace(/[。.!]+$/, "");
  const expectedFacts = sc.facts.map(f=>canonical(f.text)).sort();
  const actualFacts = durable.filter(f=>f.isActive !== false).map(f=>canonical(f.content)).sort();
  const fixture = { expectedCount:expectedFacts.length, storedCount:actualFacts.length, sourceHash:digest(expectedFacts), storedHash:digest(actualFacts), exact:JSON.stringify(expectedFacts)===JSON.stringify(actualFacts) };
  if (RUN && !fixture.exact) throw Error("goodmemory changed the stored fixture; exclude from controlled retrieval comparison");
  const handlers = new Map();
  const disposers = [];
  const logs = [];
  await gmModule.apply({
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push("WARN " + String(m)), error: (m) => logs.push("ERR " + String(m)), debug: () => {} },
    on: (e, fn) => { handlers.set(e, fn); return () => {}; },
    effect: (fn) => { try { const d = fn(); if (typeof d === "function") disposers.push(d); } catch { /* 无宿主 */ } return () => {}; },
    inject: () => {},
  }, { mode: "external", baseUrl: ready.url, maxRecallTokens: maxTokens, scope: { userId: `c4-${rep}-${sc.id}`, agentId: null }, tokenEnv: "GOODMEMORY_HTTP_BRIDGE_TOKEN" });
  const preStep = handlers.get("agent/pre-step");
  if (typeof preStep !== "function") throw new Error("goodmemory 未注册 agent/pre-step");
  // goodmemory 从 next() 的决策里取用户文本（不是 payload.messages），所以这里必须把真实消息交给下游，
  // 再只挑出它插入的那条 recall 消息（source.kind === 'goodmemory'）。
  const baseMessages = [userMsg(sc.question)];
  const decision = await preStep(
    { agent: { id: `${rep}-${sc.id}`, session: { id: `${rep}-${sc.id}`, header: { cwd: wsA } } }, signal: new AbortController().signal, messages: baseMessages, turn: 1 },
    async () => ({ kind: "enter", messages: baseMessages }),
  );
  const injected = (decision?.messages || []).filter((m) => m?.source?.kind === "goodmemory");
  const context = textOf(injected);
  // 诊断（不参与判分）：同一 query 直接问桥，区分"插件没调"与"桥返回空"
  let recallProbe = null;
  try {
    const probe = await fetch(`${ready.url}/memory/recall-context`, {
      method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { ...headers, "x-goodmemory-operations": "recall-context", "x-goodmemory-workspace-id": gmScopeId(wsA) },
      body: JSON.stringify({ maxTokens, output: "system_prompt_fragment", query: sc.question, referenceTime: new Date().toISOString(), retrievalProfile: "coding_agent", scope: { userId: `c4-${rep}-${sc.id}`, workspaceId: gmScopeId(wsA) }, strategy: "auto" }),
    });
    const pb = await probe.json();
    recallProbe = { status: probe.status, hasContext: pb?.hasContext, itemCount: pb?.itemCount, tokens: pb?.context?.estimatedTokens, error: pb?.error };
  } catch (err) { recallProbe = { error: String(err.message || err) }; }
  for (const d of disposers) { try { await d(); } catch { /* ignore */ } }
  child.kill("SIGTERM");
  return { planted, context, recallProbe, source: { fixture, fixtureExport, kind: "goodmemory-pre-step", maxTokens, accepted: planted.reduce((n, p) => n + p.accepted, 0), recallProbe }, tokens: Math.ceil(context.length / 2) };
  } finally { child.kill("SIGTERM"); }
}

/* ---------- arm: dsh-memory（真实 apply + pre-step） ---------- */
const dmConfigApi = dmPkg ? await import(pathToFileURL(join(DM_DIR, "lib/config.js")).href) : null;
const dmCompat = dmPkg ? await import(pathToFileURL(join(DM_DIR, "lib/compat.js")).href) : null;
const dmModule = dmPkg ? await import(pathToFileURL(join(DM_DIR, "lib/index.js")).href) : null;
const dmUtil = dmPkg ? await import(pathToFileURL(join(DM_DIR, "lib/util.js")).href) : null;

async function armDshMemory(rep, sc, injectMaxTokens, minScoreOverride = null) {
  const { cell, wsA } = dirs(rep, sc.id);
  mkdirSync(cell, { recursive: true });
  const dbFile = join(cell, "dsh-memory.db");
  assert.ok(assertInside(root, dbFile), "拒绝写入非临时库（dsh-memory）");
  const base = dmCompat.plainConfig(dmConfigApi.Config({}).get());
  const config = {
    ...base, dbFile, scope: "global",
    features: { ...base.features, manageTools: false, preStepInject: true, autoWrite: false, writeGate: false },
    embedding: { ...base.embedding, provider: "rule" },
    reranker: { ...base.reranker, enabled: false },
    refiner: { ...base.refiner, enabled: false },
    batchExtract: { ...base.batchExtract, enabled: false },
    housekeeping: { ...base.housekeeping, enabled: false },
    logging: { ...base.logging, enabled: false },
    injectMaxTokens,
    ...(minScoreOverride === null ? {} : { injectMinScore: minScoreOverride }),
  };
  assertInside(root, config.dbFile); // before apply() can open anything
  const handlers = new Map();
  const disposers = [];
  let memory = null;
  try {
  await dmModule.apply({
    logger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
    on: (e, fn) => { handlers.set(e, fn); return () => {}; },
    effect: (fn) => { try { const d = fn(); if (typeof d === "function") disposers.push(d); } catch { /* 无宿主 */ } return () => {}; },
    inject: () => {},
    provide: (name, value) => { if (name === "memory") memory = value; },
    get settings() { return undefined; },
    get workspaceRegistry() { return null; },
    tools: { register: () => () => {} },
    llm: {},
  }, config);
  if (!memory) throw new Error("dsh-memory 未 provide('memory')");
  const store = memory.store;
  assert.ok(assertInside(root, String(store.dbFile)), `拒绝写入非临时库: ${store.dbFile}`);
  assert.equal(store.stats().memories, 0, "competitor cell must start empty");
  const scope = basename(wsA);
  const added = [];
  for (const f of sc.facts) added.push(await store.add({ content: f.text, keywords: [], scope, type: "note", layer: "sm" }));
  if (sc.foreign) await store.add({ content: sc.foreign.text, keywords: [], scope: "ws-b", type: "note", layer: "sm" });
  const preStep = handlers.get("agent/pre-step");
  if (typeof preStep !== "function") throw new Error("dsh-memory 未注册 agent/pre-step");
  const decision = await preStep(
    { agent: { id: `${rep}-${sc.id}`, session: { id: `${rep}-${sc.id}`, meta: { cwd: wsA } } }, signal: new AbortController().signal, messages: [userMsg(sc.question)], turn: 1, step: 1 },
    async () => ({ kind: "enter", messages: [] }),
  );
  const context = textOf(decision?.messages);
  const fixture = fixtureReceipt(sc.facts, store.list({scope,limit:sc.facts.length + 1}).map(r=>r.content));
  const stats = store.stats();
  assert.equal(stats.memories, sc.facts.length + (sc.foreign ? 1 : 0), "competitor fixture cardinality");
  // 诊断（不参与判分）：默认 injectMinScore=0.02 会把"单路 rank1≈0.016"整条滤掉。
  // 记下 minScore=0 时的命中条数，才能区分"检索不到"与"被门槛拦下"。
  let hitsAtZeroThreshold = null;
  try {
    const hits = await store.search(sc.question, { scope: [scope, "global"], limit: 6, minScore: 0 });
    hitsAtZeroThreshold = hits.length;
  } catch { /* 诊断失败不影响主结果 */ }
  return {
    planted: { added: added.length, stats },
    context,
    source: { fixture, kind: "dsh-memory-pre-step", injectMaxTokens, memories: stats.memories, minScore: config.injectMinScore, hitsAtZeroThreshold },
    tokens: dmUtil.estimateTokens(context),
  };
  } finally {
    try { memory?.store?.close(); } catch {}
    for (const dispose of disposers) { try { await dispose(); } catch {} }
  }
}

/* ---------- 臂表 ---------- */
const ARMS = [
  { id: "none", budget: 0 },
  { id: "plain-all", budget: 0 },
  { id: "trivium-inject", budget: 300 },
  // 工具面臂（Step 0 追加）：同一批事实、同一个注入块，再把我方的 4 个工具给模型。
  // 用来回答"摘要 + ctx_read 是否真的能补回长正文与多条并列"，并如实计入工具 schema 税。
  { id: "trivium-tools", budget: 300, tools: true },
  { id: "goodmemory-256", budget: 256 },
  { id: "goodmemory-300", budget: 300 },
  { id: "dsmmemory-800", budget: 800 },
  // post-hoc 敏感性臂（预注册之外，看到默认门槛把单条命中全滤掉之后追加）：
  // 只放宽 injectMinScore 一个变量，用来说明"是门槛还是检索"。不作为预注册结论。
  { id: "dsmmemory-800-min0", budget: 800, minScore: 0, postHoc: true },
];

assert.ok(ONLY_ARMS.every(id => ARMS.some(a => a.id === id)), "Unknown arm");
assert.ok(ONLY_SCENARIOS.every(id => SCENARIO_IDS.includes(id)), "Unknown scenario");
const orderedArms = args.has("--reverse") ? [...ARMS].reverse() : ARMS;
try {
  for (const arm of orderedArms) {
    if (ONLY_ARMS.length && !ONLY_ARMS.includes(arm.id)) continue;
    if (arm.id.startsWith("goodmemory") && !gmPkg) { report.cells.push({ arm: arm.id, unavailable: "dsh-goodmemory 未安装" }); continue; }
    if (arm.id.startsWith("dsmmemory") && !dmPkg) { report.cells.push({ arm: arm.id, unavailable: "dsh-memory 未安装" }); continue; }
    for (let rep = 0; rep < REPS; rep++) {
      for (const sc of all) {
        if (ONLY_SCENARIOS.length && !ONLY_SCENARIOS.includes(sc.id)) continue;
        const cell = { arm: arm.id, budget: arm.budget, rep, scenario: sc.id, gold: sc.gold, question: sc.question };
        try {
          activeCell = { ...prepareCell(root, arm.id, rep, sc.id), arm: arm.id };
          cell.identity = { sessionId: activeCell.sessionId, cell: activeCell.cell };
          cell.fixtureSourceHash = digest(sc.facts);
          let context = "";
          let meta = null;
          if (arm.id === "none") {
            meta = { source: { kind: "none" }, tokens: 0 };
          } else if (arm.id === "plain-all") {
            const planted = await plantTrivium(rep, sc, "plain-all");
            context = planted.corpus;
            meta = { source: { kind: "plain-corpus", corpusHash: hash(context) }, tokens: trivium.tokens.estimateTokens(context) };
          } else if (arm.id.startsWith("trivium-")) {
            const r = await armTrivium(rep, sc);
            context = r.context;
            meta = { source: r.source, tokens: r.tokens, planted: { ids: r.planted.ids }, fixture: r.fixture, cwd: r.planted.cwd };
          } else if (arm.id.startsWith("goodmemory")) {
            const r = await armGoodmemory(rep, sc, arm.budget); context = r.context; meta = { source: r.source, tokens: r.tokens, planted: r.planted };
          } else {
            const r = await armDshMemory(rep, sc, arm.budget, arm.minScore ?? null); context = r.context; meta = { source: r.source, tokens: r.tokens, planted: r.planted };
          }
          const messages = [{ role: "system", content: SYSTEM }];
          if (context.trim()) messages.push({ role: "user", content: `记忆材料：\n${context}` });
          messages.push({ role: "user", content: sc.question });
          cell.context = context; cell.contextHash = hash(context); cell.contextChars = context.length; cell.injection = meta;
          if (RUN) {
            const toolFace = arm.tools
              ? { tools: openAiTools(trivium.toolDefs), exec: { agent: { session: { header: { cwd: meta.cwd } } } } }
              : {};
            const res = await call(messages, `${arm.id}/${sc.id}/r${rep}`, toolFace);
            cell.answer = res.answer; cell.usage = res.usage; cell.estimatedCny = res.costOffpeak; cell.estimatedCnyPeak = res.cost; cell.grade = grade(res.answer, sc.gold);
            if (arm.tools) { cell.toolCalls = res.toolCalls; cell.toolTrace = res.trace || []; }
            console.log(`${arm.id} ${sc.id} r${rep}: ${cell.grade.pass ? "pass" : "FAIL"} ctx~${meta.tokens}tok tools=${res.toolCalls || 0} total=${report.estimatedCny.toFixed(4)}`);
          } else {
            cell.contextPreview = context.slice(0, 400);
            console.log(`${arm.id} ${sc.id} r${rep}: ctx~${meta.tokens}tok chars=${context.length}`);
          }
          // 我方 pre-step 的注入块含当前时间戳；对照只比较事实与预算，不比较时间
          if (arm.id.startsWith("trivium-")) cell.contextHashWithoutTime = hash(context.replace(/当前时间：[^\n]*/g, ""));
          report.cells.push(cell); save();
        } catch (err) {
          cell.error = String(err.message || err); report.cells.push(cell); save();
          console.log(`${arm.id} ${sc.id} r${rep}: ERROR ${cell.error}`);
          throw err; // any failure terminates; do not continue after unknown charges
        } finally {
          try { trivium.handlers.get("session/disposed")?.({ id: activeCell.sessionId, header: { cwd: activeCell.wsA } }); trivium.store?.closeAll?.(); } catch { /* ignore */ }
        }
      }
    }
  }
  report.status = RUN ? "complete" : "audit-complete";
  if (RUN) {
    report.summary = Object.fromEntries(ARMS.filter((a) => !ONLY_ARMS.length || ONLY_ARMS.includes(a.id)).map((a) => {
      const rows = report.cells.filter((c) => c.arm === a.id && c.grade);
      return [a.id, {
        cells: rows.length,
        passed: rows.filter((c) => c.grade.pass).length,
        errors: report.cells.filter((c) => c.arm === a.id && c.error).length,
        meanInjectedTokens: rows.length ? Math.round(rows.reduce((n, c) => n + (c.injection?.tokens || 0), 0) / rows.length) : 0,
        meanPromptTokens: rows.length ? Math.round(rows.reduce((n, c) => n + c.usage.prompt_tokens, 0) / rows.length) : 0,
        estimatedCny: rows.reduce((n, c) => n + (c.estimatedCny || 0), 0),
      }];
    }));
  }
  save();
  console.log(JSON.stringify({ status: report.status, cells: report.cells.length, calls: report.calls.length, estimatedCny: report.estimatedCny, summary: report.summary }, null, 2));
} catch (err) {
  report.status = "stopped"; report.error = String(err.message || err); save(); throw err;
} finally {
  try { trivium.store?.closeAll?.(); } catch { /* ignore */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* sqlite 句柄可能未释放 */ }
}
