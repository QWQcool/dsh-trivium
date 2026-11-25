import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-issue10-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "trivium.json");
const { apply, makeLlmCall } = await import("../lib/index.js");
const store = await import("../lib/store.js");
const extract = await import("../lib/extract.js");

const session = {
  id: "issue10",
  requestHeader: () => ({ config: { provider: "opencode-go", model: "deepseek-v4.1-flash" } }),
};
const message = 'provider "opencode-go" model "deepseek-v4.1-flash" does not support reasoning effort "off"';
const unsupported = { code: "UNSUPPORTED_REASONING_EFFORT", message: "Test catalog rejected the effort." };
const ok = text => (async function* () {
  yield { type: "text-delta", index: 0, text };
  yield { type: "finish", reason: { kind: "stop" } };
})();
const finish = (failure, kind = "error", before = []) => (async function* () {
  yield* before;
  yield { type: "finish", reason: { kind, failure } };
})();
const thrown = error => (async function* () { throw error; })();
const stub = fn => {
  const calls = [];
  return { calls, ctx: { llm: { stream(request) { calls.push(request); return fn(request, calls.length); } } } };
};
let passed = 0;
async function check(label, test) {
  await test();
  ++passed;
  console.log("ok " + label);
}
async function success(rejectFirst) {
  const controller = new AbortController();
  const { calls, ctx } = stub((_request, count) => count === 1 ? rejectFirst() : ok('{"candidates":[]}'));
  const call = makeLlmCall(ctx, session);
  assert.equal(await call("same prompt", { signal: controller.signal }), '{"candidates":[]}');
  assert.equal(calls.length, 2);
  const [{ reasoningEffort, ...first }, second] = calls;
  assert.equal(reasoningEffort, "off");
  assert.equal(Object.hasOwn(second, "reasoningEffort"), false);
  // Each request is built afresh, but only the effort may change.
  assert.deepEqual(first, second);
  assert.equal(second.maxTokens, 900);
  assert.equal(second.provider, "opencode-go");
  assert.equal(second.model, "deepseek-v4.1-flash");
  assert.equal(second.signal, controller.signal);
  assert.equal(await call("later strict prompt", { signal: controller.signal }), '{"candidates":[]}');
  assert.equal(calls.length, 3);
  assert.equal(Object.hasOwn(calls[2], "reasoningEffort"), false);
}
async function noRetry(reject) {
  const { calls, ctx } = stub((_req, n) => n === 1 ? reject() : ok("NOT EXPECTED"));
  await assert.rejects(() => makeLlmCall(ctx, session)("prompt"));
  assert.equal(calls.length, 1);
}
try {
  await check("recognized successes do not change the current model or default effort", async () => {
    const { calls, ctx } = stub(() => ok("original text"));
    assert.equal(await makeLlmCall(ctx, session)("prompt"), "original text");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reasoningEffort, "off");
    assert.equal(calls[0].maxTokens, 900);
  });
  await check("actual message-only provider error triggers one otherwise identical retry", () => success(() => { throw Error(message); }));
  await check("structured failure from a throwing stream triggers the same retry", () => success(() => thrown({ failure: unsupported })));
  await check("structured finish error also triggers the same retry", () => success(() => finish(unsupported)));
  await check("message-only finish error can follow empty blocks and still retry", () => success(() => finish(
    { code: "UNKNOWN", message }, "error", [{ type: "block-start", index: 0, blockType: "text" }])));

  await check("a partial text delta prohibits a retry on finish error", () => noRetry(() => finish(unsupported, "error", [
    { type: "text-delta", index: 0, text: " " },
  ])));
  await check("a partial reasoning delta prohibits retry after a later throw", () => noRetry(() => (async function* () {
    yield { type: "reasoning-delta", index: 0, text: "partial thinking" };
    throw Error(message);
  })()));
  await check("a tool-call step is not an empty failed attempt", () => noRetry(() => finish(unsupported, "error", [
    { type: "tool-call-delta", index: 0, id: "fixture", name: "fixture", argumentsDelta: "" },
  ])));
  await check("aborted finish, 429, network and timeout take precedence over retry", async () => {
    for (const fail of [
      () => finish(unsupported, "aborted"),
      () => finish({ ...unsupported, status: 429 }),
      () => thrown({ ...unsupported, cause: { code: "ECONNRESET" } }),
      () => thrown({ ...unsupported, name: "TimeoutError" }),
      () => thrown({ message, response: { status: 429 } }),
    ]) await noRetry(fail);
  });
  await check("unrelated errors and an explicit rejection of another effort are not retried", async () => {
    for (const fail of [
      () => thrown(Error("upstream timed out; earlier context: " + message)),
      () => thrown({ code: unsupported.code, effort: "high" }),
      () => thrown({ code: "SOME_UNSUPPORTED_REASONING_EFFORT_WRAPPER" }),
    ]) await noRetry(fail);
  });
  await check("abort wins even if the adapter then throws the narrow message", async () => {
    const c = new AbortController();
    const { calls, ctx } = stub(() => { c.abort(); throw Error(message); });
    await assert.rejects(() => makeLlmCall(ctx, session)("prompt", { signal: c.signal }), { name: "AbortError" });
    assert.equal(calls.length, 1);
  });
  await check("a second incompatibility is propagated, never a third provider call", async () => {
    const { calls, ctx } = stub(() => finish(unsupported));
    await assert.rejects(() => makeLlmCall(ctx, session)("prompt"), /catalog rejected/);
    assert.equal(calls.length, 2);
  });
  await check("registered pending extraction writes after fallback; status reports only safe failure fields", async () => {
    const handlers = new Map(), logs = [], calls = [];
    let apiHandler, broken = false;
    const text = "The export archive uses the cobalt profile.";
    const secret = "sensitive-provider-body-test-only";
    const ctx = {
      llm: { stream(request) {
        calls.push(request);
        if (broken) return finish({ code: "PROVIDER_RATE_LIMITED", status: 429, message: secret, requestId: secret });
        return request.reasoningEffort ? finish({ code: "UNKNOWN", message }) :
          ok(JSON.stringify({ candidates: [{ type: "decision", name: "Export archive profile", text }] }));
      } },
      logger: () => ({ warn(value) { logs.push(String(value)); }, info() {}, debug() {}, error() {} }),
      inject(_dependencies, run) { run(ctx); },
      on(event, handler) { handlers.set(event, handler); return () => {}; },
      effect(run) { run(); },
      tools: { register() { return () => {}; } },
      webServer: { register(entry) { if (entry.path === "/api/dsh-trivium") apiHandler = entry.handler; } },
    };
    apply(ctx, {});
    const open = async (suffix, input) => {
      const cwd = join(root, suffix);
      const db = await store.openWorkspaceDb(cwd);
      await extract.savePending(cwd, { sessionId: "window-" + suffix, turns: [{ role: "user", text: input, seq: 31 }] });
      await handlers.get("agent/created")({ agent: { session: { ...session, id: suffix, header: { cwd } }, inject() {} } });
      let status;
      await apiHandler({ method: "GET", url: "/api/dsh-trivium/status?cwd=" + encodeURIComponent(cwd),
        headers: {}, socket: { remoteAddress: "127.0.0.1" } },
      { writeHead() {}, end(body) { status = JSON.parse(String(body)); } });
      return { db, status, cwd };
    };
    const good = await open("good", text);
    assert.equal(calls.length, 2);
    assert.equal(good.status.lastExtract.llmFailed, false);
    assert.ok(good.db.allNodeIds().some(id => good.db.getPayload(id).text === text));
    assert.equal(extract.loadPendingWindows(good.cwd).length, 0);
    broken = true;
    const bad = await open("bad", "The backup archive uses the blue profile.");
    assert.equal(calls.length, 3);
    assert.equal(bad.status.lastExtract.llmFailed, true);
    assert.deepEqual(bad.status.lastExtract.llmFailure, {
      code: "EXTRACT_RATE_LIMITED", message: "The extraction provider rate-limited the request.",
    });
    assert.equal(extract.loadPendingWindows(bad.cwd).length, 1);
    assert.ok(!JSON.stringify(bad.status).includes(secret) && !logs.join("\n").includes(secret));
  });
} finally {
  store.closeAll();
  if (dirname(resolve(root)) === resolve(tmpdir())) rmSync(root, { recursive: true, force: true });
}
console.log("P125: " + passed + "/13");
