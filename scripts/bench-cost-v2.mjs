/** Compare actual plugin hooks and rendered tool text in two isolated child processes. No model calls. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const libArg = process.argv.find((x) => x.startsWith("--lib="));
const repo = resolve(new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
if (!libArg) {
  const baseline = join(repo, ".tmp", "cost-quality-2026-10-29", "baseline");
  if (!existsSync(baseline)) {
    mkdirSync(baseline, { recursive: true }); writeFileSync(join(baseline, "package.json"), '{"type":"module"}');
    for (const file of execFileSync("git", ["ls-tree", "-r", "--name-only", "490a748", "lib"], { cwd: repo, encoding: "utf8" }).trim().split(/\r?\n/)) {
      const target = join(baseline, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, execFileSync("git", ["show", `490a748:${file}`], { cwd: repo }));
    }
  }
  const result = {};
  for (const [name, path] of [["before", join(baseline, "lib")], ["after", join(repo, "lib")]]) result[name] = JSON.parse(execFileSync(process.execPath, [new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"), `--lib=${path}`], { encoding: "utf8", maxBuffer: 4e6 }));
  writeFileSync(join(repo, ".tmp/cost-quality-2026-10-29/cost.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} else {
  const root = mkdtempSync(join(tmpdir(), "dsh-cost-v2-"));
  process.env.DSH_HOME = join(root, "home"); process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, '{"recallMode":"auto"}');
  const load = (f) => import(pathToFileURL(join(libArg.slice(6), f)).href);
  const store = await load("store.js"), plugin = await load("index.js"), { estimateTokens } = await load("tokens.js"), extract = await load("extract.js");
  const handlers = new Map(), tools = new Map(), calls = [];
  let clock = 2_000_000_000_000, timerSeq = 0;
  const timers = new Map(), realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout, realNow = Date.now;
  Date.now = () => clock;
  globalThis.setTimeout = (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, at: clock + ms }); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const ctx = { logger: () => ({ warn() {} }), llm: { stream: async function* (options) { calls.push({ sessionId: options.sessionId, prompt: options.messages[0].content.map((c) => c.text || "").join("") }); } },
    inject: (deps, cb) => { if (deps[0] === "llm") cb(ctx); }, on: (name, fn) => handlers.set(name, fn), effect: (fn) => { fn(); }, tools: { register: (t) => { tools.set(t.name, t); return () => {}; } } };
  plugin.apply(ctx, {});
  const settle = () => new Promise((r) => realTimeout(r, 25));
  async function advance(ms) {
    const end = clock + ms;
    while (true) { const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break;
      clock = due[1].at; timers.delete(due[0]); due[1].fn(); await settle(); }
    clock = end; await settle();
  }
  const report = { modelCalls: 0, note: "Controlled fake-clock workload through actual plugin hooks; token counts are local estimates, not daily spend", extraction: {} };
  try {
    for (const kind of ["acknowledgements", "substantive"]) {
      const cwd = join(root, kind); await store.openWorkspaceDb(cwd);
      const session = { id: kind, header: { cwd }, requestHeader: () => ({ config: { provider: "fake", model: "fake" } }) };
      const event = handlers.get("session/event");
      for (let i = 0; i < 20; i++) {
        event(session, { type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: kind === "acknowledgements" ? "谢谢！" : `第${i}次：项目采用 AuroraStore，先测兼容性再讨论切换。` }] } });
        event(session, { type: "assistant/message", data: { content: [{ type: "text", text: kind === "acknowledgements" ? "好的。" : `第${i}次：我会记录这个兼容性约束，继续实现。` }] } });
        event(session, { type: "turn/end", seq: i }); await advance(180_000);
      }
      await advance(600_000);
      const rows = calls.filter((c) => c.sessionId === kind);
      report.extraction[kind] = { calls: rows.length, promptEstimatedTokens: rows.reduce((s, r) => s + estimateTokens(r.prompt), 0), pendingMessages: extract.loadPending(cwd)?.turns?.length || 0 };
      handlers.get("session/disposed")(session);
    }
    const cwd = join(root, "render"), db = await store.openWorkspaceDb(cwd);
    const id = store.insertNode(db, { type: "preference", name: "验收约定", text: "发布前先跑全量验收，再检查故障恢复记录。" });
    const session = { id: "render", header: { cwd } }, agent = { session, inject() {} }, exec = { agent };
    const user = { source: { kind: "user" }, content: [{ type: "text", text: "验收约定" }] };
    const decision = await handlers.get("agent/pre-step")({ agent, messages: [user] }, async () => ({ kind: "enter", messages: [] }));
    const injection = (decision.messages || []).map((m) => m.content.map((c) => c.text || "").join("")).join("\n");
    report.render = {};
    for (const [name, text] of [["map", store.buildShortMapReport(db).text], ["injection", injection], ["find", String(await tools.get("ctx_find").execute({ query: "验收约定" }, exec))], ["read", String(await tools.get("ctx_read").execute({ id }, exec))]]) report.render[name] = { text, estimatedTokens: estimateTokens(text), bytes: Buffer.byteLength(text) };
    console.log(JSON.stringify(report));
  } finally { Date.now = realNow; globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear; store.closeAll(); rmSync(root, { recursive: true, force: true }); }
}
