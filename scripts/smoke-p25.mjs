/** 0.7.1 closeout: workspace diagnostics, correction priority and clock expiry.
 * Real TriviumDB + installed DSH peers; controlled coordinator, no model calls.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";

const home = mkdtempSync(join(tmpdir(), "dsh-trivium-p25-"));
process.env.DSH_TRIVIUM_SETTINGS = join(home, "settings.json");
process.env.DSH_HOME = join(home, "dsh-home");
const store = await import("../lib/store.js");
const sidecar = await import("../lib/sidecar.js");
const settings = await import("../lib/settings.js");
const ledger = await import("../lib/turn-ledger.js");
const { selectContextRecords } = await import("../lib/context-budget.js");
const { supersede } = await import("../lib/revisions.js");
const plugin = await import("../lib/index.js");
let checks = 0, failed = 0;
function check(ok, label, detail = "") {
  checks++;
  if (ok) console.log("ok  " + label);
  else { failed++; console.error("FAIL " + label + (detail ? ": " + detail : "")); }
}
const handlers = new Map();
let httpHandler;
const ctx = {
  logger: () => ({ warn() {}, info() {}, error() {} }),
  inject(_deps, fn) { fn(ctx); },
  on(name, fn) { handlers.set(name, fn); return () => {}; },
  effect(fn) { fn(); return () => {}; },
  tools: { register: () => () => {} },
  webServer: { register(def) { httpHandler = def.handler; return () => {}; } },
};
plugin.apply(ctx, {});
async function api(path, cwd, expectedStatus = 200) {
  const req = Readable.from([]);
  req.method = "GET";
  req.url = "/api/dsh-trivium/" + path + "?cwd=" + encodeURIComponent(cwd);
  req.headers = {};
  req.socket = { remoteAddress: "127.0.0.1" };
  let code, body;
  await httpHandler(req, { writeHead(value) { code = value; }, end(data) { body = String(data || ""); } });
  assert.equal(code, expectedStatus, body);
  return JSON.parse(body);
}
const message = (id) => ({ id, source: { kind: "user" }, content: [{ type: "text", text: "请继续当前任务" }] });
const textsOf = (decision) => (decision.messages || []).flatMap((m) => m.content || []).map((x) => x.text || "").join("\n");
const RealDate = Date;
let clock = RealDate.parse("2040-01-01T00:00:00Z");
class TestDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
}

try {
  const a = join(home, "a"), b = join(home, "b");
  const dbA = await store.openWorkspaceDb(a), dbB = await store.openWorkspaceDb(b);
  writeFileSync(sidecar.sidecarPath(a), "not valid jsonl", "utf8");
  await sidecar.syncSidecarOnOpen(a, dbA);
  writeFileSync(sidecar.sidecarPath(b), '{"v":2,"format":"dsh-trivium-jsonl"}\n', "utf8");
  await sidecar.syncSidecarOnOpen(b, dbB);
  check(sidecar.sidecarHealth(a).ok === false, "HEALTH-25 A failure survives B success");
  check(sidecar.sidecarHealth(b).ok === true, "HEALTH-25 B keeps its own success");
  const healthA = (await api("status", a)).derived.sidecar;
  const healthB = (await api("status", b)).derived.sidecar;
  check(!healthA.ok && healthB.ok, "HEALTH-25 status reports the requested workspace's health");
  check(healthA.cwd === resolve(a) && healthA.scope === "workspace", "HEALTH-25 health identifies its workspace");
  settings.writeUiSettings({ gitSidecarEnabled: true });
  rmSync(sidecar.sidecarPath(b));
  mkdirSync(sidecar.sidecarPath(b));
  assert.throws(() => store.generateSidecarFromDb(b, dbB));
  check(sidecar.sidecarHealth(b).ok === false, "HEALTH-25 an explicit generation failure is recorded for that workspace");
  rmSync(sidecar.sidecarPath(b), { recursive: true });
  await sidecar.syncSidecarOnOpen(b, dbB);
  check(sidecar.sidecarHealth(b).ok === true && sidecar.sidecarHealth(a).ok === false, "HEALTH-25 recovering a generated sidecar cannot clear another workspace's error");
  settings.writeUiSettings({ gitSidecarEnabled: false });

  const urgent = { id: 9, type: "decision", l0: "已失效，停止依赖旧事实。".repeat(6), correction: true };
  const priority = selectContextRecords({
    pins: [1, 2].map((id) => ({ id, type: "preference", l0: "记忆".repeat(50) })),
    corrections: [urgent], budget: 300,
  });
  check(priority.records[0]?.channel === "correction", "CORR-25 corrections are selected before recurring pins");
  check(priority.records.some((r) => r.id === urgent.id), "CORR-25 recurring pins cannot starve a fitting correction");
  check(priority.tokens <= 300 && priority.deferred.some((r) => r.channel === "pin"), "CORR-25 priority still honors the shared budget");

  // Advance the clock without any database write between delivery and expiry.
  globalThis.Date = TestDate;
  settings.writeUiSettings({ chipsEnabled: true, recallMode: "off", extractEnabled: false, gitSidecarEnabled: false });
  const workspace = join(home, "clock");
  const db = await store.openWorkspaceDb(workspace);
  const id = store.insertNode(db, { type: "decision", name: "ClockFact", text: "测试环境限时使用当前认证约定。", until: "2040-01-01" });
  const sid = "p25-clock-session";
  settings.writePins(sid, [id]);
  const agent = { session: { id: sid, header: { cwd: workspace } }, inject() {} };
  const step = (turn) => handlers.get("agent/pre-step")({ agent, messages: [message(turn)] }, async () => ({ kind: "enter", messages: [] }));
  const initial = await step("clock-1");
  check(textsOf(initial).includes("当前认证约定"), "EXPIRY-25 the actual pre-step first delivered the live fact");
  const before = JSON.stringify(db.get(id));
  clock = RealDate.parse("2040-01-02T00:00:00Z");
  const expired = await step("clock-1");
  check(textsOf(expired).includes("memory corrections") && /到期|过期/.test(textsOf(expired)), "EXPIRY-25 clock-only expiry reaches the same user turn's actual pre-step as a correction", textsOf(expired));
  check(JSON.stringify(db.get(id)) === before, "EXPIRY-25 observing expiry does not rewrite the fact");
  check(ledger.spentOf(sid, "uid:clock-1") <= 300, "EXPIRY-25 same-turn expiry shares the already-spent allowance");
  const again = await step("clock-1");
  check(!textsOf(again).includes("memory corrections"), "EXPIRY-25 repeated pre-step does not resend the same expiry");
  const laterTurn = await step("clock-2-next");
  check(!textsOf(laterTurn).includes("memory corrections"), "EXPIRY-25 later user turns do not repeat an acknowledged expiry");

  // A write queues a correction, but disabling all injection must retain it.
  store.updateNode(db, id, { until: "" });
  settings.writeUiSettings({ chipsEnabled: false, recallMode: "off", extractEnabled: false });
  const disabled = await step("clock-3");
  check(disabled.messages.length === 0 && ledger.pendingCorrections(sid).length > 0, "CORR-25 channels off retains pending correction without injecting");
  const paused = await api("corrections", workspace);
  check(paused.sessions[0]?.pending[0]?.blockedReason === "channels-off", "CORR-25 disabled injection has a truthful pending reason");
  const unknownWorkspace = await api("corrections", join(home, "unknown-workspace"), 400);
  check(unknownWorkspace.ok === false && !unknownWorkspace.sessions, "CORR-25 unknown explicit workspace cannot expose other workspaces' corrections");
  settings.writeUiSettings({ chipsEnabled: true, recallMode: "off", extractEnabled: false });
  const resumed = await step("clock-4");
  check(textsOf(resumed).includes("memory corrections"), "CORR-25 re-enabling injection delivers the retained correction");

  // Exhaust a real turn allowance, then change a fact. No free new allowance.
  const spent = selectContextRecords({ pins: [{ id: 999, type: "preference", l0: "预算".repeat(100) }] });
  ledger.commit(ledger.reserve(sid, "uid:clock-budget", spent.records, { totalTokens: spent.tokens }));
  ledger.queueCorrection(sid, urgent);
  const blocked = await step("clock-budget");
  const budgetView = await api("corrections", workspace);
  check(!textsOf(blocked).includes(urgent.l0) && budgetView.sessions[0]?.pending.some((r) => r.id === urgent.id && r.blockedReason === "budget"), "CORR-25 insufficient remaining budget is reported without consuming the notice");
  check(ledger.spentOf(sid, "uid:clock-budget") <= 300, "CORR-25 blocked correction cannot reset a turn budget");

  const observed = await api("status", workspace);
  const quiet = await api("status", b);
  check(observed.lastContextPlan && quiet.lastContextPlan === null, "STATUS-25 another workspace cannot inherit the last plan");
  check(quiet.lastInjectTokens === 0 && quiet.lastInjectAt === null, "STATUS-25 another workspace cannot inherit map counters");
  check(quiet.diagnosticsScope === "workspace", "STATUS-25 diagnostics scope is explicit");

  // The old node's later expiry cannot overwrite an undelivered replacement.
  clock = RealDate.parse("2040-02-01T00:00:00Z");
  const old = store.insertNode(db, { type: "decision", name: "ExpireOld", text: "旧的验证约定仍在过渡期内。", until: "2040-02-01" });
  const successor = store.insertNode(db, { type: "decision", name: "CurrentNew", text: "新的验证约定接替旧版本。" });
  settings.writePins(sid, [old]);
  await step("replace-old");
  assert.equal(supersede(db, { oldId: old, successorId: successor }).ok, true);
  clock = RealDate.parse("2040-02-02T00:00:00Z");
  const replacement = await step("replace-next");
  check(textsOf(replacement).includes(`以 #${successor} 为准`) && !textsOf(replacement).includes("自然到期"), "EXPIRY-25 old expiry cannot replace the current-version correction");

  // Expiry is observed even while injection is disabled, then sent on resume.
  clock = RealDate.parse("2040-03-01T00:00:00Z");
  const heldId = store.insertNode(db, { type: "decision", name: "PausedExpiry", text: "此约定仅在当前验证日有效。", until: "2040-03-01" });
  settings.writePins(sid, [heldId]);
  await step("held-before");
  settings.writeUiSettings({ chipsEnabled: false, recallMode: "off", extractEnabled: false });
  clock = RealDate.parse("2040-03-02T00:00:00Z");
  const heldStep = await step("held-after");
  const heldQueue = (await api("corrections", workspace)).sessions.find((s) => s.sessionId === sid);
  check(heldStep.messages.length === 0 && heldQueue.pending.some((r) => r.id === heldId && r.blockedReason === "channels-off"), "EXPIRY-25 paused injection still observes expiry and explains the pending state");
  settings.writeUiSettings({ chipsEnabled: true, recallMode: "off", extractEnabled: false });
  const heldResume = await step("held-resume");
  check(textsOf(heldResume).includes("自然到期"), "EXPIRY-25 resuming injection delivers expiry queued while disabled");

  // A stale manual pin can later be renewed. The notified fingerprint, not the
  // originally delivered stale flag, determines whether its next expiry is new.
  clock = RealDate.parse("2040-04-02T00:00:00Z");
  const renewedId = store.insertNode(db, { type: "decision", name: "RenewedExpiry", text: "这条历史决策稍后会延长有效期。", until: "2040-04-01" });
  settings.writePins(sid, [renewedId]);
  const staleDelivery = await step("renewed-stale");
  check(textsOf(staleDelivery).includes("历史决策") && textsOf(staleDelivery).includes("stale"), "EXPIRY-25 an explicit stale pin is delivered with its stale state");
  const stillStale = await step("renewed-still-stale");
  check(!textsOf(stillStale).includes("memory corrections"), "EXPIRY-25 a fact first received stale does not gain a redundant expiry notice");
  settings.writePins(sid, []);
  store.updateNode(db, renewedId, { until: "2040-04-03" });
  const renewed = await step("renewed-active");
  check(textsOf(renewed).includes("memory corrections"), "EXPIRY-25 renewal reaches the session after the stale pin is removed");
  clock = RealDate.parse("2040-04-04T00:00:00Z");
  const renewedExpiry = await step("renewed-expired-again");
  check(textsOf(renewedExpiry).includes("自然到期"), "EXPIRY-25 a renewed fact gets its later clock-only expiry correction");
  const renewedRepeat = await step("renewed-expired-again");
  check(!textsOf(renewedRepeat).includes("memory corrections"), "EXPIRY-25 renewed expiry is acknowledged once rather than repeated");
} finally {
  globalThis.Date = RealDate;
  settings.writeUiSettings({ gitSidecarEnabled: false });
  store.closeAll();
  rmSync(home, { recursive: true, force: true });
}
console.log(`P25 reliability: ${checks - failed}/${checks} passed`);
if (failed) process.exitCode = 1;
