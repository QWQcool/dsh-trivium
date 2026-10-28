/**
 * p29：单字符检索词不得产生命中（C3-offline S06 的有害注入回归）。
 *
 * 背景：查询「1+1 等于几」过去会把 `1` 当成检索词，命中任何正文带 1 的无关节点，
 * 于是自动召回把无关记忆投给了模型——一次真实的有害注入。
 * 修复：`queryTerms()` 对所有脚本一律要求 term.length >= 2。
 *
 * 同时保留正例，防止"把检索词砍太狠"：两字符以上的词必须照常命中，
 * 完整标识符（X-Request-Id）走 identifierQuery 分支，不受影响。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p29-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");

const libDir = join(dirname(new URL(import.meta.url).pathname.slice(1)), "..", "lib");
const store = await import(pathToFileURL(join(libDir, "store.js")).href);
const { registerTools } = await import(pathToFileURL(join(libDir, "tools.js")).href);

const cwd = join(root, "workspace");
const db = await store.openWorkspaceDb(cwd);

const tools = new Map();
registerTools({ effect: (fn) => fn(), tools: { register: (t) => { tools.set(t.name, t); return () => {}; } }, on() {} }, {});
const remember = tools.get("ctx_remember");
const exec = { agent: { session: { header: { cwd, id: "p29" }, id: "p29" } } };

await remember.execute({ type: "entity", name: "无关实体", text: "与算术无关的记录 1。" }, exec);
await remember.execute({ type: "experience", name: "发布流程", text: "发布前要跑 run-all.mjs 全量回归。" }, exec);
await remember.execute({ type: "decision", name: "端口约定", text: "本地服务固定 8787 端口。" }, exec);

/* ---- 反例：单字符 term 不应产生任何命中 ---- */
for (const query of ["1+1 等于几", "1", "几"]) {
  const hits = store.searchNodes(db, query, { topK: 8 });
  assert.equal(hits.length, 0, `查询「${query}」不应命中任何节点，实际 ${hits.length}`);
}
console.log("ok  单字符检索词不再产生命中");

/* ---- 正例：两字符以上的词照常命中 ---- */
const byWord = store.searchNodes(db, "run-all.mjs", { topK: 8 });
assert.ok(byWord.some((h) => String(h.payload?.text || "").includes("run-all.mjs")), "run-all.mjs 应命中发布流程");
const byDigits = store.searchNodes(db, "8787", { topK: 8 });
assert.ok(byDigits.length > 0, "两字符以上的数字应照常命中");
const byHan = store.searchNodes(db, "发布", { topK: 8 });
assert.ok(byHan.length > 0, "两字中文词应照常命中");
console.log("ok  两字符以上的词、数字、中文词仍然命中");

/* ---- 标识符查询不受影响 ---- */
const byIdentifier = store.searchNodes(db, "x-request-id", { topK: 8 });
assert.ok(Array.isArray(byIdentifier), "标识符查询不应抛错");
console.log("ok  完整标识符查询不受单字符过滤影响");

store.closeAll();
try { rmSync(root, { recursive: true, force: true }); } catch { /* 句柄可能未释放 */ }
console.log("\nP29 short-term recall guard passed");
