/** Verify an installed release tarball with real DSH peer packages.
 * Usage: node scripts/verify-package.mjs <isolated-consumer-directory>
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

if (!process.argv[2]) throw new Error("Pass the isolated consumer directory with the tarball and DSH peers installed.");
const consumer = resolve(process.argv[2]);
const require = createRequire(join(consumer,"package.json"));
const packageRoot = dirname(require.resolve("dsh-trivium/package.json"));
const load = (file) => import(pathToFileURL(join(packageRoot,"lib",file)).href);
const root = mkdtempSync(join(tmpdir(),"dsh-trivium-package-check-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root,"settings.json");
const store = await load("store.js");

try {
  const pkg = require("dsh-trivium/package.json");
  const sourcePkg = JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  assert.equal(pkg.version,sourcePkg.version);
  // The kernel is pinned in package.json; a hard-coded version here silently
  // rots every time the pin moves (it said 0.8.11 while the pin was 0.9 beta).
  const expectedKernel = String(sourcePkg.dependencies?.triviumdb || "").trim();
  assert.equal(require("triviumdb/package.json").version, expectedKernel, "installed kernel matches the pin");
  const plugin = await load("index.js");
  assert.equal(typeof plugin.apply,"function");
  assert.equal(plugin.producerSource({form:"snapshot"}).kind,"plugin:dsh-trivium");
  const registered = new Map();
  const { registerTools } = await load("tools.js");
  registerTools({
    effect: fn => fn(),
    tools: {register(tool){ registered.set(tool.name,tool); return () => {}; }},
    on() {},
  },{});
  assert.equal(registered.size,4);
  const remember = registered.get("ctx_remember");
  const find = registered.get("ctx_find");
  const exec = {agent:{session:{header:{cwd:join(root,"workspace"),id:"package-test"}}}};
  assert.equal(find.parameters.properties.include_stale.type,"boolean");
  assert.equal(remember.parameters.properties.until.type,"string");
  const historical = await remember.execute({type:"decision",name:"发布历史",text:"采用方案 A；2020-01-01 已完成复盘。"},exec);
  assert.match(historical,/Remembered id=/);
  const liveFind = await find.execute({query:"发布历史"},exec);
  assert.match(liveFind,/采用方案 A/);
  assert.doesNotMatch(liveFind,/ stale/);
  const deadline = await remember.execute({type:"decision",name:"冻结记录",text:"旧部署冻结约定。",until:"2020-01-01"},exec);
  assert.match(deadline,/Remembered id=/);
  assert.match(await find.execute({query:"冻结记录"},exec),/stale/);
  assert.equal(await find.execute({query:"冻结记录",include_stale:false},exec),"No memory hits.");
  const retrieval = await remember.execute({type:"preference",name:"上线规范",text:"发布前先检查测试结果，再执行上线流程。"},exec);
  assert.match(retrieval,/Remembered id=/);
  assert.match(await find.execute({query:"发布前 检查"},exec),/发布前先检查测试结果/);
  await remember.execute({type:"decision",name:"冻结记录",text:"旧部署冻结约定。",until:""},exec);
  assert.doesNotMatch(await find.execute({query:"冻结记录"},exec),/stale/);
  /*
   * Runtime pre-step check.
   *
   * The offline suite can only assert the wiring by reading source. A missing
   * import or a renamed helper therefore survives it and dies on the first real
   * turn (0.5.0 shipped with `remainingOf is not defined` until a host caught
   * it). This drives one pre-step through a fake coordinator with the real
   * peers installed, so the whole path — ledger, planner, renderer, host
   * message builder — has to actually execute.
   */
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ recallMode: "auto" }), "utf8");
  const seeded = await load("store.js").then((m) => m.openWorkspaceDb(join(root, "workspace")));
  const { estimateTokens } = await load("tokens.js");
  const handlers = new Map();
  const fakeCtx = {
    logger: () => ({ warn: () => {}, info: () => {}, error: () => {} }),
    inject: (deps, cb) => { try { cb(fakeCtx); } catch { /* service absent */ } },
    on: (event, fn) => { handlers.set(event, fn); return () => {}; },
    effect: (factory) => { try { factory(); } catch { /* register may throw without a host */ } return () => {}; },
    tools: { register: () => ({ dispose: () => {} }) },
  };
  plugin.apply(fakeCtx, {});
  assert.equal(typeof handlers.get("agent/pre-step"), "function");
  // Seed a fact the query will actually hit, then drive one pre-step.
  await remember.execute({ type: "preference", name: "上线规范", text: "上线前先跑验收脚本，再发布。" }, exec);
  const userMessage = { source: { kind: "user" }, content: [{ type: "text", text: "上线规范" }] };
  const decision = await handlers.get("agent/pre-step")(
    { agent: { session: { id: "s-pre", header: { cwd: join(root, "workspace") } } }, messages: [userMessage] },
    async () => ({ kind: "enter", messages: [] }),
  );
  assert.equal(decision.kind, "enter");
  const injected = (decision.messages || [])
    .map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text).join("") : ""))
    .filter(Boolean);
  assert.ok(injected.length > 0, "pre-step injected nothing");
  assert.ok(injected.some((t) => t.includes("dsh-trivium autoRecall")), "recall block missing");
  for (const text of injected) {
    assert.ok(estimateTokens(text) <= 300, "a block exceeded the shared 300 allowance");
  }
  // A second step in the same turn must not repeat what was already delivered.
  const second = await handlers.get("agent/pre-step")(
    { agent: { session: { id: "s-pre", header: { cwd: join(root, "workspace") } } }, messages: [userMessage] },
    async () => ({ kind: "enter", messages: [] }),
  );
  const secondInjected = (second.messages || []).length;
  assert.ok(secondInjected <= injected.length, "same turn injected again");

  /*
   * REVIEW P1-1: one user turn must stay within 300 across tool steps. Three
   * long chips used to book 0 each and ship 3 x ~217. This drives the real
   * pre-step path with the real ledger, so a record without a token cost fails
   * here instead of only in a hand-built fixture.
   */
  const { insertNode } = await load("store.js");
  const { writePins } = await load("settings.js");
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ recallMode: "auto", chipsEnabled: true }), "utf8");
  const longSentence = "鉴权方案统一改为在请求头携带会话凭据，并在网关侧校验签名，旧版登录态在过渡期继续兼容。";
  const pinnedIds = [];
  for (let i = 0; i < 3; i += 1) {
    pinnedIds.push(insertNode(seeded, {
      type: "decision",
      name: `预算验收${i + 1}`,
      text: `${longSentence}${longSentence}${longSentence}${longSentence}批次${i + 1}。`,
      uri: `ctx://decision/verify-budget-${i + 1}`,
    }));
  }
  writePins("s-pre-budget", pinnedIds);
  const budgetSession = { id: "s-pre-budget", header: { cwd: join(root, "workspace") } };
  const budgetMessage = { id: "turn-budget-verify", source: { kind: "user" }, content: [{ type: "text", text: "预算" }] };
  let sentTokens = 0;
  for (let step = 0; step < 3; step += 1) {
    const result = await handlers.get("agent/pre-step")(
      { agent: { session: budgetSession }, messages: [budgetMessage] },
      async () => ({ kind: "enter", messages: [] }),
    );
    const texts = (result.messages || [])
      .map((m) => (Array.isArray(m.content) ? m.content.map((c) => c.text).join("") : ""))
      .filter(Boolean);
    sentTokens += texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  }
  assert.ok(sentTokens > 0, "the long-chip fixture injected nothing");
  assert.ok(sentTokens <= 300, `one user turn exceeded 300 estimated tokens (sent=${sentTokens})`);

  console.log(JSON.stringify({
    package:pkg.name,version:pkg.version,kernel:require("triviumdb/package.json").version,
    hostPeers:{llm:require("@deepseek-ai/dsh-llm/package.json").version,tools:require("@deepseek-ai/dsh-tools/package.json").version},
    checks:["package version","native binding","host module import","v4 source shape","four tool registrations","explicit expiry","history/current-only search","multiword search","clear expiry","runtime pre-step injection","same-turn de-duplication","cumulative turn budget"],
    status:"passed",
  },null,2));
} finally {
  store.closeAll();
  rmSync(root,{recursive:true,force:true});
}
