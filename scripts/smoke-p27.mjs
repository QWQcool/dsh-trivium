/**
 * p27：抽取触发策略（C2d 之后的行为回归）。
 *
 * 覆盖三件事，全部围绕"什么时候调模型"，不请求任何模型：
 *  1. 静默窗口从 12 s 改成 60 s —— 用量身替换的 setTimeout 抓延迟，不真等。
 *  2. 攒够 12 条 turns 直接抽（batch），不再排 idle 定时器。
 *  3. 抽完之后进入 5 分钟冷却：此时再攒够也不立即抽，而是重新排定时器。
 *
 * 为什么这样测：真实计时器是 60 s，等待会让回归变慢且不稳定；替换全局 setTimeout
 * 能同时验证"排了多久"和"有没有排"，而这两件事正是策略本身。
 * 传进去的假 session 不带 llm，所以 runExtract 只会走规则路径，不会发请求。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p27-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const cwd = join(root, "workspace");

/* ---- 替换 setTimeout，抓"排了多久"而不是真等 ---- */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const scheduled = [];
globalThis.setTimeout = (fn, delay, ...rest) => {
  scheduled.push({ fn, delay, at: Date.now() });
  return { __fake: true, delay };
};
globalThis.clearTimeout = () => {};

const libDir = join(dirname(new URL(import.meta.url).pathname.slice(1)), "..", "lib");
const plugin = await import(pathToFileURL(join(libDir, "index.js")).href);
const store = await import(pathToFileURL(join(libDir, "store.js")).href);

const handlers = new Map();
plugin.apply({
  logger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }),
  inject: (deps, cb) => { try { cb({}); } catch { /* 无宿主服务 */ } },
  on: (event, fn) => { handlers.set(event, fn); return () => {}; },
  effect: (factory) => { try { factory(); } catch { /* 无宿主 */ } return () => {}; },
  tools: { register: () => ({ dispose: () => {} }) },
}, {});

const onEvent = handlers.get("session/event");
assert.equal(typeof onEvent, "function", "session/event 未注册");

const session = { id: "p27", header: { cwd } };
const userMsg = (text, turn) => ({ type: "user/message", data: { content: [{ type: "text", text }], source: { kind: "user" }, turn } });
const assistantMsg = (text, turn) => ({ type: "assistant/message", data: { message: { content: [{ type: "text", text }] }, turn } });
const turnEnd = () => ({ type: "turn/end", data: {}, seq: 1 });

/** 往一个会话里塞 n 轮对话（每轮 user + assistant）。 */
function pushTurns(n, from = 1) {
  for (let i = from; i < from + n; i++) {
    onEvent(session, userMsg(`第 ${i} 轮：这个方案先跑基线再改召回。`, i));
    onEvent(session, assistantMsg(`第 ${i} 轮回复：先固定种子与版本。`, i));
  }
}

/* ---- 1. 未到批量阈值：应排 60 s 的 idle 定时器 ---- */
scheduled.length = 0;
pushTurns(5); // 10 条 turns
onEvent(session, turnEnd());
assert.equal(scheduled.length, 1, "turn/end 后应排一个 idle 定时器");
assert.equal(scheduled[0].delay, 60_000, `静默窗口应为 60 s，实际 ${scheduled[0].delay} ms`);
console.log("ok  idle 窗口从 12 s 改为 60 s");

/* ---- 2. 达到批量阈值：应立即抽，不再排 idle ---- */
const session2 = { id: "p27-batch", header: { cwd } };
scheduled.length = 0;
for (let i = 1; i <= 6; i++) {
  onEvent(session2, userMsg(`批量第 ${i} 轮：记住以后先跑验收再发布。`, i));
  onEvent(session2, assistantMsg(`批量第 ${i} 轮回复：已记录。`, i));
}
onEvent(session2, turnEnd());
assert.equal(scheduled.length, 0, "攒够 12 条 turns 应直接抽，不应再排 idle");
console.log("ok  累积 12 条 turns 直接抽取（batch）");

/* ---- 3. 冷却期内不立即抽，重新排定时器 ---- */
await new Promise((r) => realSetTimeout(r, 50)); // 让 batch 的 runExtract 走完
scheduled.length = 0;
for (let i = 7; i <= 12; i++) {
  onEvent(session2, userMsg(`冷却期第 ${i} 轮：改成教程和演示都可以。`, i));
  onEvent(session2, assistantMsg(`冷却期第 ${i} 轮回复：收到。`, i));
}
onEvent(session2, turnEnd());
assert.equal(scheduled.length, 1, "冷却期内应重新排 idle 而不是立刻抽");
assert.ok(scheduled[0].delay > 290_000 && scheduled[0].delay <= 300_000, "wake at cooldown end");
console.log("ok  5 分钟冷却期内不立即抽取，改为排下一次窗口");

globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
store.closeAll();

try { rmSync(root, { recursive: true, force: true }); } catch { /* 句柄可能未释放 */ }
console.log("\nP27 extraction scheduling passed");
