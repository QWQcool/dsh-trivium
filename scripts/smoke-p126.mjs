/** PR #8: the short map rides an admitted human step, never the agent inbox. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

const root = mkdtempSync(join(tmpdir(), "trivium-pr8-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const [plugin, store, { estimateTokens }] = await Promise.all([
  import("../lib/index.js"), import("../lib/store.js"), import("../lib/tokens.js"),
]);

const cwd = join(root, "workspace");
const handlers = new Map();
const startup = new Map();
const ctx = {
  inject(_deps, apply) { apply(ctx); },
  effect(run) { run(); },
  on(event, handler) {
    handlers.set(event, handler);
    if (event === "agent/created" || event === "agent/session-start") startup.set(event, handler);
    return () => {};
  },
  logger: () => ({ warn() {}, info() {}, error() {} }),
  tools: { register() { return () => {}; } },
};
const direct = [];
const agent = {
  session: { id: "pr8", header: { cwd } },
  inject(message) { direct.push(message); },
};
const human = text => createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
const producer = kind => createUserMessage({ content: [{ type: "text", text: "Context only" }], source: { kind } });
const texts = msg => (msg.content || []).map(block => block?.text || "").join("\n");
const mapOf = decision => (decision?.messages || []).filter(message => /^dsh-trivium memory map/.test(texts(message)));
const state = () => structuredClone({
  counts: plugin.workspaceStatus(cwd).mapInjections,
  last: plugin.workspaceStatus(cwd).lastMapInjection,
});
const drive = (incoming, outgoing = incoming, extra = {}) => handlers.get("agent/pre-step")(
  { agent, messages: incoming },
  () => ({ kind: "enter", messages: outgoing, ...extra }),
);
let count = 0;
async function check(label, verify) {
  await verify();
  ++count;
  console.log("ok " + label);
}
try {
  plugin.apply(ctx);
  const db = await store.openWorkspaceDb(cwd);
  store.insertNode(db, { type: "decision", name: "first-fixture", text: "Synthetic memory before the first human step." });
  await check("both host startup events queue nothing and mark no map delivered", async () => {
    const before = state();
    for (const fn of startup.values()) await fn({ agent });
    assert.equal(startup.size, 2);
    assert.deepEqual(direct, []);
    assert.deepEqual(state(), before);
  });
  await check("empty, producer, assistant, goal, tools and rejected user claims do not bootstrap", async () => {
    const before = state();
    const real = human("not admitted");
    const noHuman = [
      [], [producer("plugin:dsh-trivium")], [producer("plugin:another")], [producer("goal")],
      [{ ...real, role: "assistant" }], [{ ...real, role: "tool" }], [human("   ")],
      [{ ...real, content: [{ type: "tool-call", name: "fixture" }] }],
    ];
    for (const messages of noHuman) assert.equal(mapOf(await drive(messages)).length, 0);
    assert.equal(mapOf(await drive(undefined, [real])).length, 0, "no evidence that a historical user message is newly claimed");
    assert.equal(mapOf(await drive([real], [])).length, 0, "the downstream removed this claim");
    assert.equal(mapOf(await drive([real], [human("other ID")])).length, 0);
    const reject = { kind: "skip", reason: "fixture" };
    assert.equal(await handlers.get("agent/pre-step")({ agent, messages: [real] }, () => reject), reject);
    assert.deepEqual(state(), before);
  });
  const first = human("Open the synthetic workspace");
  await check("the first admitted human gets one bounded producer snapshot and the original decision", async () => {
    const unrelated = producer("another-producer");
    const result = await drive([first], [{ ...first }, unrelated], { hostField: "preserved" });
    assert.equal(result.hostField, "preserved");
    assert.equal(result.messages[1].id, first.id);
    assert.equal(result.messages[2], unrelated);
    const maps = mapOf(result);
    assert.equal(maps.length, 1);
    const [map] = maps;
    assert.match(texts(map), /first-fixture/);
    assert.equal(map.source.kind, "plugin:dsh-trivium");
    assert.equal(map.source.form, "snapshot");
    assert.equal(map.source.sections[0].text, texts(map));
    assert.ok(estimateTokens(texts(map)) <= 400);
    assert.equal(state().counts.sessionStart, 1);
  });
  const delivered = state();
  store.insertNode(db, { type: "decision", name: "later-fixture", text: "Synthetic write during a real turn." });
  await check("continuations, repeated claims and filtered humans do not consume a pending diff", async () => {
    const old = producer("plugin:tool-fixture");
    assert.equal(mapOf(await drive([old], [old, first])).length, 0, "history is not a newly claimed user message");
    assert.equal(mapOf(await drive([first])).length, 0);
    assert.equal(mapOf(await drive([human("gets filtered")], [old])).length, 0);
    assert.deepEqual(state(), delivered);
  });
  const second = human("Is there newer synthetic evidence?");
  await check("if the outgoing decision cannot be composed, delivery isn't marked", async () => {
    const blocked = { kind: "enter", messages: [second] };
    Object.defineProperty(blocked, "hostProperty", {
      enumerable: true, get() { throw Error("synthetic composition failure"); },
    });
    const result = await handlers.get("agent/pre-step")({ agent, messages: [second] }, () => blocked);
    assert.equal(result, blocked);
    assert.equal(mapOf(result).length, 0);
    assert.deepEqual(state(), delivered);
  });
  await check("a failed addition is retried on the same admitted ID and then delivered once", async () => {
    const result = await drive([second]);
    assert.equal(mapOf(result).length, 1);
    assert.match(texts(mapOf(result)[0]), /\+decision:later-fixture/);
    assert.equal(state().last.mode, "diff");
    assert.notEqual(state().last.version, delivered.last.version);
    const after = state();
    assert.equal(mapOf(await drive([second])).length, 0);
    assert.deepEqual(state(), after);
  });
  await check("unchanged human turns stay quiet without changing delivered map version", async () => {
    const before = state();
    assert.equal(mapOf(await drive([human("No memory changes")])).length, 0);
    const after = state();
    assert.equal(after.last.reason, "unchanged");
    assert.equal(after.last.version, before.last.version);
    assert.equal(after.counts.skip, before.counts.skip + 1);
  });
  await check("compaction clears the map without injecting; an admitted attachment can bootstrap", async () => {
    const before = state();
    handlers.get("session/event")(agent.session, { type: "compaction/end", data: {} });
    assert.equal(mapOf(await drive([])).length, 0);
    assert.deepEqual(state(), before);
    const file = createUserMessage({ source: { kind: "user" }, content: [
      { type: "file", attachment: { id: "synthetic-attachment" } },
    ] });
    const result = await drive([file]);
    assert.equal(mapOf(result).length, 1);
    assert.match(texts(mapOf(result)[0]), /^dsh-trivium memory map:/);
    assert.equal(state().counts.sessionStart, before.counts.sessionStart + 1);
    assert.deepEqual(direct, []);
  });
  console.log("P126: " + count + "/" + count);
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
