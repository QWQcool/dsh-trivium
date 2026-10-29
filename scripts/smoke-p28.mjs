/**
 * p28：抽取去重（同一批内容不重复调模型）。
 *
 * p27 只覆盖"什么时候排定时器"，没覆盖 `turnsHash` 的跳过路径。这里补上。
 *
 * 判据用**模型调用次数**：llm 桩一调就抛，于是抽取走 llmFailed → savePending 分支，
 * 既能计数，又留下"确实抽过"的落盘痕迹。
 *   phase1 首次：调 1 次
 *   phase2 同一批内容 + 冷却已过：仍应是 1 次（去重生效）
 *   phase3 改一个字符：应变成 2 次（证明 phase2 的"没调"不是测试恒过）
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p28-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const cwd = join(root, "workspace");

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realDateNow = Date.now;
let clock = realDateNow();
Date.now = () => clock;
globalThis.setTimeout = () => ({ __fake: true });
globalThis.clearTimeout = () => {};

const libDir = join(dirname(new URL(import.meta.url).pathname.slice(1)), "..", "lib");
const plugin = await import(pathToFileURL(join(libDir, "index.js")).href);
const store = await import(pathToFileURL(join(libDir, "store.js")).href);

const llmCalls = [];
const stubLlm = {
  stream: async function* stream() {
    llmCalls.push(clock);
    throw new Error("p28 stub llm failure");
  },
};

const handlers = new Map();
const fakeCtx = {
  llm: stubLlm,
  logger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
  inject: (deps, cb) => { try { cb(fakeCtx); } catch { /* 无服务 */ } },
  on: (event, fn) => { handlers.set(event, fn); return () => {}; },
  effect: (factory) => { try { factory(); } catch { /* 无宿主 */ } return () => {}; },
  tools: { register: () => ({ dispose: () => {} }) },
};
plugin.apply(fakeCtx, {});

const onEvent = handlers.get("session/event");
assert.equal(typeof onEvent, "function", "session/event 未注册");

const session = {
  id: "p28",
  header: { cwd },
  // resolveLlmTarget 要求 provider/model，否则 makeLlmCall 返回 null、根本不调模型
  requestHeader: () => ({ config: { provider: "stub", model: "stub-model" } }),
};

const TEXTS = Array.from({ length: 6 }, (_, i) => ({
  user: `第 ${i + 1} 轮：记住，以后发布前先跑验收脚本。`,
  assistant: `第 ${i + 1} 轮回复：已记录。`,
}));

function pushTurns(texts) {
  texts.forEach((pair, i) => {
    onEvent(session, { type: "user/message", data: { content: [{ type: "text", text: pair.user }], source: { kind: "user" }, turn: i + 1 } });
    onEvent(session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: pair.assistant }] }, turn: i + 1 } });
  });
}
const turnEnd = () => onEvent(session, { type: "turn/end", data: {}, seq: 1 });
/*
 * 抽取是异步的：runExtract 要先 openWorkspaceDb（含文本索引重建），实测可能超过 150 ms。
 * turn/end 自己也会先写 pending，文件存在不等于抽取结束。等待这一阶段的
 * 明确内容（失败时 error=llm failed），再排空已完成 Promise 的回调。
 * 先开好合成库，将冷启动耗时与这个去重断言分开。
 */
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
async function settle(expectFailure) {
  const pending = join(cwd, ".dsh", "trivium-pending.json");
  const deadline = realDateNow() + 10_000;
  let observed = false;
  while (realDateNow() < deadline) {
    try {
      const saved = JSON.parse(readFileSync(pending, "utf8"));
      if (expectFailure ? saved.error === "llm failed" : saved.error === undefined) { observed = true; break; }
    } catch { /* a pending write may not have completed yet */ }
    await wait(10);
  }
  assert.ok(observed, "本阶段 pending 写入未完成，不能据此判断去重");
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

try {
await store.openWorkspaceDb(cwd);
/* ---- phase 1：首次批量抽取 ---- */
pushTurns(TEXTS);
turnEnd();
await settle(true);
assert.equal(llmCalls.length, 1, `首次抽取应调用模型 1 次，实际 ${llmCalls.length}`);
assert.ok(existsSync(join(cwd, ".dsh", "trivium-pending.json")), "抽取失败应落盘 pending");
console.log("ok  首次批量抽取调用模型并落盘");

/* ---- phase 2：内容不变 + 冷却已过，应去重跳过 ---- */
clock += 10 * 60_000;
pushTurns(TEXTS);
turnEnd();
await settle(false);
assert.equal(llmCalls.length, 1, `同一批内容不应再调模型，实际 ${llmCalls.length}`);
console.log("ok  同一批内容被去重跳过");

/* ---- phase 3：改一个字符，必须重新抽取 ---- */
clock += 10 * 60_000;
const changed = TEXTS.map((pair, i) => (i === TEXTS.length - 1 ? { ...pair, user: `${pair.user}（补充一句）` } : pair));
pushTurns(changed);
turnEnd();
await settle(true);
assert.equal(llmCalls.length, 2, `内容变化后应重新调模型，实际 ${llmCalls.length}`);
console.log("ok  内容变化后重新抽取（证明 phase2 不是恒过）");

console.log("\nP28 extraction dedupe passed");
} finally {
  Date.now = realDateNow;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
