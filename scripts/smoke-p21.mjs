/**
 * 0.5.1 correctness gate: the three P1 defects from REVIEW-2026-10-28.
 *
 * These assertions must fail on the 0.5.0 code and pass after the fix:
 *   CTX-21-01  a user turn never sends more than 300 estimated tokens
 *   CTX-21-02  a superseded hit is answered with the current body, not just id
 *   IO-21-01   two URIs stay two nodes even when one body contains the other
 *   IO-21-02   a failed import leaves the database logically unchanged
 *
 * No fixture may invent record.tokens: the values must come from the planner.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  closeAll,
  describeDbFailure,
  formatHit,
  importGraph,
  insertNode,
  nodeCountOf,
  openWorkspaceDb,
  openWorkspaceDbReadOnly,
  searchNodes,
  successorOf,
} from "../lib/store.js";
import { makeRevisionResolver, revokeSupersession, supersede } from "../lib/revisions.js";
import { checkRevisionIntegrity } from "../lib/integrity.js";
import {
  fingerprintOf,
  renderContextRecords,
  selectContextRecords,
  TURN_ADDITIONAL_BUDGET,
} from "../lib/context-budget.js";
import {
  beginTurn,
  clearAfterCompaction,
  commit,
  deliveredOf,
  pendingCorrections,
  remainingOf,
  reserve,
  resetAll,
  setSessionWorkspace,
  spentOf,
} from "../lib/turn-ledger.js";
import { pinCandidates } from "../lib/pins.js";
import { writePins } from "../lib/settings.js";
import { recallPreview } from "../lib/recall-preview.js";
import { syncSidecarOnOpen } from "../lib/sidecar.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p21-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const W1 = join(root, "ws-budget");
const W2 = join(root, "ws-version");
const W3 = join(root, "ws-import");
const W4 = join(root, "ws-import-tx");
const W5 = join(root, "ws-sidecar");
const W6 = join(root, "ws-correction");
const W7 = join(root, "ws-integrity");
const W8 = join(root, "ws-other");

let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks += 1;
  console.log("ok  " + message);
}
function equal(actual, expected, message) {
  assert.equal(actual, expected, `${message} (actual=${actual}, expected=${expected})`);
  checks += 1;
  console.log("ok  " + message);
}

// Long enough to need ~210 estimated tokens, but natural text: the hygiene gate
// rejects single-character stutter, so a repeated character is not a valid fixture.
// No ASCII word may repeat 4+ times: the hygiene word-level stutter gate would
// drop the fixture before the planner ever sees it.
const SENTENCE = "鉴权方案统一改为在请求头携带会话凭据，并在网关侧校验签名，旧版登录态在过渡期继续兼容。";
const LONG = (label) => `${SENTENCE}${SENTENCE}${SENTENCE}${SENTENCE}批次${label}。`;

try {
  /* ------------------------------------------------------------ CTX-21-01 */
  // Three long chips, one user turn, three tool steps. The review measured
  // 217+217+217=651 because reserve() read record.tokens === undefined as 0.
  resetAll();
  const db1 = await openWorkspaceDb(W1);
  const budgetIds = [];
  for (let i = 0; i < 3; i += 1) {
    budgetIds.push(
      insertNode(db1, {
        type: "decision",
        name: `预算夹具${i + 1}`,
        text: LONG(i + 1),
        uri: `ctx://decision/budget-${i + 1}`,
      }),
    );
  }
  const session = "sess-budget";
  const turn = "uid:turn-budget";
  writePins(session, budgetIds);
  beginTurn(session, turn);

  const perStep = [];
  for (let step = 0; step < 3; step += 1) {
    const remaining = remainingOf(session, turn, TURN_ADDITIONAL_BUDGET);
    const plan = selectContextRecords({
      pins: pinCandidates(db1, session),
      recall: [],
      budget: remaining,
      delivered: deliveredOf(session, turn),
    });
    const rendered = renderContextRecords(plan);
    for (const record of plan.records) {
      check(Number(record.tokens) > 0, `CTX-21-01 step ${step + 1} records carry their real token cost`);
    }
    if (plan.records.length) {
      const sum = plan.records.reduce((acc, record) => acc + record.tokens, 0);
      equal(sum, plan.tokens, `CTX-21-01 step ${step + 1} per-record tokens add up to the plan total`);
      equal(rendered.total, plan.tokens, `CTX-21-01 step ${step + 1} the rendered text equals the plan`);
    }
    const reservation = reserve(session, turn, plan.records, { totalTokens: rendered.total });
    equal(reservation.tokens, rendered.total, `CTX-21-01 step ${step + 1} the reservation books the rendered total`);
    commit(reservation);
    perStep.push({ tokens: plan.tokens, spent: spentOf(session, turn) });
  }

  const totalSent = perStep.reduce((acc, row) => acc + row.tokens, 0);
  check(perStep[0].tokens > 0, "CTX-21-01 the first step really delivers a record");
  check(totalSent <= TURN_ADDITIONAL_BUDGET, `CTX-21-01 three steps stay within one 300 budget (sent=${totalSent})`);
  equal(perStep[0].spent, perStep[0].tokens, "CTX-21-01 the first step is booked, not free");
  check(perStep[2].spent >= perStep[0].spent, "CTX-21-01 the ledger only grows within the turn");
  check(perStep[2].spent <= TURN_ADDITIONAL_BUDGET, "CTX-21-01 spent never exceeds the budget");

  // Re-committing the same reservation must not charge twice.
  const idem = selectContextRecords({ pins: [], recall: [], budget: 300 });
  const idemReservation = reserve(session, turn, idem.records, { totalTokens: 0 });
  const before = spentOf(session, turn);
  commit(idemReservation);
  commit(idemReservation);
  equal(spentOf(session, turn), before, "CTX-21-01 commit is idempotent");

  // Explicit zero means zero, never "fall back to 300".
  const zeroPlan = selectContextRecords({ pins: pinCandidates(db1, session), budget: 0 });
  equal(zeroPlan.budget, 0, "CTX-21-01 an explicit zero budget stays zero");
  equal(zeroPlan.records.length, 0, "CTX-21-01 a zero budget selects nothing");

  // Compaction must not hand the same user turn a fresh 300.
  const spentBeforeCompaction = spentOf(session, turn);
  clearAfterCompaction(session);
  equal(
    remainingOf(session, turn, TURN_ADDITIONAL_BUDGET),
    TURN_ADDITIONAL_BUDGET - spentBeforeCompaction,
    "CTX-21-01 compaction keeps the same-turn spend",
  );

  /* ------------------------------------------------------------ CTX-21-02 */
  const db2 = await openWorkspaceDb(W2);
  const oldId = insertNode(db2, {
    type: "decision",
    name: "鉴权方案",
    text: "CookieLegacy 是旧鉴权方案。",
    uri: "ctx://decision/auth-old",
  });
  const newId = insertNode(db2, {
    type: "decision",
    name: "鉴权方案",
    text: "HeaderCurrent 是新的唯一鉴权方案。",
    uri: "ctx://decision/auth-new",
  });
  const applied = supersede(db2, { oldId, successorId: newId, reason: "统一到请求头", operationId: "op-p21-02" });
  check(applied.ok, "CTX-21-02 the fixture really linked the two decisions");

  const hits = searchNodes(db2, "CookieLegacy");
  const hit = hits.find((row) => Number(row.id) === oldId);
  check(hit, "CTX-21-02 the old body is still findable by its own text");
  const row = formatHit(db2, hit);
  const resolver = makeRevisionResolver(db2);
  const plan = selectContextRecords({
    pins: [],
    recall: [{ id: row.id, type: row.type, l0: row.l0, until: row.until, stale: row.stale, path: row.path }],
    budget: 300,
    resolveCurrent: resolver,
  });
  equal(plan.records.length, 1, "CTX-21-02 the superseded hit produces one record");
  equal(plan.records[0].id, newId, "CTX-21-02 the record points at the current id");
  check(
    String(plan.records[0].l0).includes("HeaderCurrent"),
    "CTX-21-02 the injected body is the current body",
  );
  check(
    !String(plan.records[0].l0).includes("CookieLegacy"),
    "CTX-21-02 the replaced body is never shown under the new id",
  );
  equal(plan.records[0].matchedHistory?.from, oldId, "CTX-21-02 the pointer keeps the real old id");

  const preview = recallPreview(db2, { query: "CookieLegacy", mode: "auto" });
  check(preview.ok, "CTX-21-02 preview succeeds");
  const previewRecord = preview.records[0];
  check(previewRecord, "CTX-21-02 preview returns a record");
  equal(previewRecord.id, newId, "CTX-21-02 preview points at the current id");
  check(String(previewRecord.l0).includes("HeaderCurrent"), "CTX-21-02 preview shows the current body");
  check(Number(previewRecord.tokens) > 0, "CTX-21-02 preview reports a real token cost");

  // A manual pin is the user's choice: keep the old id and body, mark history.
  writePins("sess-version", [oldId]);
  const pinned = pinCandidates(db2, "sess-version", { resolveRevision: resolver });
  check(Array.isArray(pinned), "CTX-21-02 pin candidates remain a structured list");
  const pinPlan = selectContextRecords({
    pins: pinned,
    budget: 300,
    resolveCurrent: resolver,
  });
  equal(pinPlan.records[0].id, oldId, "CTX-21-02 a manual pin keeps its own id");
  check(String(pinPlan.records[0].l0).includes("CookieLegacy"), "CTX-21-02 a manual pin keeps its own body");
  check(pinPlan.records[0].historical === true, "CTX-21-02 a manual pin is marked historical");

  /* ------------------------------------------------------------ CTX-21-03 */
  // A fact that was delivered and then superseded must produce a short notice,
  // not a silent stop and not the old body again.
  const db6 = await openWorkspaceDb(W6);
  const corOld = insertNode(db6, {
    type: "decision",
    name: "部署方式",
    text: "旧部署方式使用单机进程。",
    uri: "ctx://decision/cor-old",
  });
  const corNew = insertNode(db6, {
    type: "decision",
    name: "部署方式",
    text: "新部署方式使用多副本。",
    uri: "ctx://decision/cor-new",
  });
  const corSession = "sess-correction";
  const corTurn = "uid:turn-correction";
  beginTurn(corSession, corTurn);
  const deliveredPlan = selectContextRecords({
    recall: [{ id: corOld, type: "decision", l0: "旧部署方式使用单机进程。" }],
    budget: 300,
  });
  const deliveredReservation = reserve(corSession, corTurn, deliveredPlan.records, {
    totalTokens: deliveredPlan.tokens,
  });
  commit(deliveredReservation);
  equal(deliveredReservation.tokens > 0, true, "CTX-21-03 the old fact was delivered first");

  const corLinked = supersede(db6, {
    oldId: corOld,
    successorId: corNew,
    reason: "改多副本",
    operationId: "op-p21-03",
  });
  check(corLinked.ok, "CTX-21-03 the fixture really linked the two decisions");
  const corPending = pendingCorrections(corSession);
  equal(corPending.length, 1, "CTX-21-03 supersession queues one correction");
  check(String(corPending[0].l0).includes(`#${corNew}`), "CTX-21-03 the notice names the successor");
  check(
    !String(corPending[0].l0).includes("旧部署方式"),
    "CTX-21-03 the notice does not resend the old body",
  );

  const corPlan = selectContextRecords({ corrections: corPending, budget: 300 });
  equal(corPlan.records.length, 1, "CTX-21-03 the correction is selected");
  equal(corPlan.records[0].channel, "correction", "CTX-21-03 it has its own channel");
  const corRendered = renderContextRecords(corPlan);
  check(
    corRendered.corrections.text.includes("memory corrections"),
    "CTX-21-03 the correction gets a dedicated message block",
  );
  check(
    !corRendered.recall.text.includes("memory corrections"),
    "CTX-21-03 it is not mixed into the recall block",
  );
  check(
    !corRendered.corrections.text.includes("旧部署方式"),
    "CTX-21-03 the rendered notice still carries no old body",
  );
  const corReservation = reserve(corSession, corTurn, corPlan.records, { totalTokens: corRendered.total });
  commit(corReservation);
  equal(pendingCorrections(corSession).length, 0, "CTX-21-03 a delivered correction is consumed");

  // A correction that does not fit stays pending for the next turn.
  const corRevoked = revokeSupersession(db6, { oldId: corOld, successorId: corNew });
  check(corRevoked.ok, "CTX-21-03 the fixture could revoke the relation");
  equal(pendingCorrections(corSession).length, 1, "CTX-21-03 revoke queues a new correction");
  const zeroCorrection = selectContextRecords({ corrections: pendingCorrections(corSession), budget: 0 });
  equal(zeroCorrection.records.length, 0, "CTX-21-03 a zero budget defers the correction");
  equal(
    pendingCorrections(corSession).length,
    1,
    "CTX-21-03 a deferred correction is not consumed",
  );

  /* ------------------------------------------------------------ CTX-21-04 */
  const fpBase = fingerprintOf(7, "同一段正文", { type: "decision" });
  const fpUntil = fingerprintOf(7, "同一段正文", { type: "decision", until: "2099-01-01" });
  check(fpBase !== fpUntil, "CTX-21-04 a deadline change changes the fingerprint");
  const statePlan = selectContextRecords({
    recall: [{ id: 7, type: "decision", l0: "同一段正文", until: "2099-01-01" }],
    budget: 300,
    delivered: new Set([fpBase]),
  });
  equal(statePlan.records.length, 1, "CTX-21-04 a state change is not a same-turn duplicate");

  /* ------------------------------------------------------------ CTX-21-05 */
  // Node ids are per database. A change in W6 must not notify a session that
  // was shown the same numeric id in another workspace.
  const db8 = await openWorkspaceDb(W8);
  insertNode(db8, {
    type: "decision",
    name: "另一库",
    text: "另一个库里的同号决策。",
    uri: "ctx://decision/other-db",
  });
  const sessA = "sess-cwd-a";
  const sessB = "sess-cwd-b";
  setSessionWorkspace(sessA, W6);
  setSessionWorkspace(sessB, W8);
  for (const sid of [sessA, sessB]) {
    beginTurn(sid, "uid:turn-cwd");
    const plan = selectContextRecords({
      recall: [{ id: corOld, type: "decision", l0: "旧部署方式使用单机进程。" }],
      budget: 300,
    });
    commit(reserve(sid, "uid:turn-cwd", plan.records, { totalTokens: plan.tokens }));
  }
  // corOld is current again after the revoke above.
  const relinked = supersede(db6, {
    oldId: corOld,
    successorId: corNew,
    reason: "隔离验证",
    operationId: "op-p21-05",
  });
  check(relinked.ok, "CTX-21-05 the fixture linked again");
  equal(pendingCorrections(sessA).length, 1, "CTX-21-05 the same-workspace session is notified");
  equal(pendingCorrections(sessB).length, 0, "CTX-21-05 another workspace with the same id is not");

  /* ------------------------------------------------------------ IO-21-01 */
  const db3 = await openWorkspaceDb(W3);
  const beforeCount = nodeCountOf(db3);
  const graph = {
    format: "dsh-trivium-graph",
    version: 2,
    nodes: [
      {
        id: 100,
        payload: {
          type: "decision",
          name: "鉴权",
          text: "鉴权统一使用请求头携带会话凭据。",
          uri: "ctx://decision/rev100",
          status: "active",
        },
      },
      {
        id: 200,
        payload: {
          type: "decision",
          name: "鉴权",
          text: "鉴权统一使用请求头携带会话凭据。所有请求还必须校验签名。",
          uri: "ctx://decision/rev200",
          status: "active",
        },
      },
    ],
    edges: [{ from: 200, to: 100, label: "supersedes", metadata: { reason: "补签名" } }],
  };
  const imported = importGraph(db3, graph);
  equal(imported.ok, true, "IO-21-01 the two-version import is accepted");
  equal(nodeCountOf(db3) - beforeCount, 2, "IO-21-01 both URI identities survive as separate nodes");
  const importedRows = (db3.allNodeIds?.() || []).map((id) => db3.get(id)).filter(Boolean);
  const rev100 = importedRows.find((node) => node.payload?.uri === "ctx://decision/rev100");
  const rev200 = importedRows.find((node) => node.payload?.uri === "ctx://decision/rev200");
  check(rev100 && rev200, "IO-21-01 both stable URIs are present after import");
  check(Number(rev100.id) !== Number(rev200.id), "IO-21-01 the two versions were not merged");
  equal(successorOf(db3, rev100.id), Number(rev200.id), "IO-21-01 the new version supersedes the old one");
  check(Number(successorOf(db3, rev200.id) ?? -1) !== Number(rev200.id), "IO-21-01 no self loop was written");

  /* ------------------------------------------------------------ IO-21-02 */
  const db4 = await openWorkspaceDb(W4);
  const liveId = insertNode(db4, {
    type: "decision",
    name: "既有决策",
    text: "既有事实保持不变。",
    uri: "ctx://decision/live",
  });
  const snapshotBefore = nodeCountOf(db4);
  const failing = {
    format: "dsh-trivium-graph",
    version: 2,
    nodes: [
      {
        id: 1,
        payload: {
          type: "decision",
          name: "新决策",
          text: "这是一条本来会被写入的新决策。",
          uri: "ctx://decision/tx-new",
          status: "active",
        },
      },
      {
        id: 2,
        payload: {
          type: "decision",
          name: "更新决策",
          text: "既有事实保持不变，但正文变了。",
          uri: "ctx://decision/live",
          status: "active",
        },
      },
    ],
    edges: [{ from: 1, to: 2, label: "supersedes", metadata: { reason: "事务测试" } }],
  };
  const originalCommit = db4.commitTransaction;
  db4.commitTransaction = () => {
    throw new Error("injected failure");
  };
  let failedResult;
  try {
    failedResult = importGraph(db4, failing);
  } finally {
    db4.commitTransaction = originalCommit;
  }
  equal(failedResult.ok, false, "IO-21-02 a failed transaction is reported, not swallowed");
  equal(nodeCountOf(db4), snapshotBefore, "IO-21-02 a failed import wrote no nodes");
  equal(String(db4.get(liveId).payload.text), "既有事实保持不变。", "IO-21-02 a failed import did not overwrite a live body");
  equal(successorOf(db4, liveId), null, "IO-21-02 a failed import left no revision edge");

  /* ------------------------------------------------------------ IO-21-03 */
  // Legacy v1 nodes have no URI; text fallback for non-version facts must stay.
  const legacyGraph = {
    format: "dsh-trivium-graph",
    version: 1,
    nodes: [
      { id: 10, payload: { type: "preference", name: "缩进", text: "所有文件使用两个空格缩进。", status: "active" } },
    ],
    edges: [],
  };
  const legacyResult = importGraph(db3, legacyGraph);
  check(legacyResult.ok, "IO-21-03 a URI-less v1 graph still imports");
  equal(legacyResult.created, 1, "IO-21-03 the legacy node is created once");
  const legacyAgain = importGraph(db3, legacyGraph);
  check(legacyAgain.ok, "IO-21-03 re-importing the same v1 graph is accepted");
  equal(legacyAgain.created, 0, "IO-21-03 re-importing the same v1 graph creates nothing");
  equal(legacyAgain.merged, 1, "IO-21-03 re-importing the same v1 graph merges into the existing node");

  /* ------------------------------------------------------------ IO-21-05 */
  // The Git JSONL path used the same text fallback as the JSON import. A row
  // with a new URI but a body containing a local one must create a new node,
  // otherwise the older version's identity is silently overwritten.
  const db5 = await openWorkspaceDb(W5);
  const sideBase = insertNode(db5, {
    type: "decision",
    name: "旁路鉴权",
    text: "旁路鉴权统一使用请求头。",
    uri: "ctx://decision/side-base",
  });
  const sideBefore = nodeCountOf(db5);
  const jsonl = `${[
    JSON.stringify({ v: 2, format: "dsh-trivium-jsonl" }),
    JSON.stringify({
      op: "node",
      uri: "ctx://decision/side-new",
      type: "decision",
      name: "旁路鉴权",
      text: "旁路鉴权统一使用请求头。并且校验签名。",
      status: "active",
    }),
  ].join("\n")}\n`;
  writeFileSync(join(W5, ".dsh", "trivium.jsonl"), jsonl, "utf8");
  const appliedSidecar = await syncSidecarOnOpen(W5, db5);
  equal(appliedSidecar.action, "import", "IO-21-05 the JSONL is applied on open");
  equal(nodeCountOf(db5) - sideBefore, 1, "IO-21-05 a new URI becomes a new node, not a text merge");
  equal(db5.get(sideBase).payload.uri, "ctx://decision/side-base", "IO-21-05 the existing identity is unchanged");

  /* ------------------------------------------------------------ IO-21-04 */
  // Pre-allocated ids are a new capability; a plain insert afterwards must not
  // collide with them, and the whole result must survive close + reopen.
  const highestImported = Math.max(...(db3.allNodeIds?.() || []).map(Number));
  const afterImport = insertNode(db3, {
    type: "preference",
    text: "导入之后新增的普通偏好，用来验证 id 分配不会碰撞。",
    uri: "ctx://preference/after-import",
  });
  check(Number(afterImport) > highestImported, "IO-21-04 an insert after an import gets an unused id");
  const idSet = new Set((db3.allNodeIds?.() || []).map(Number));
  equal(idSet.size, db3.allNodeIds().length, "IO-21-04 imported and later ids are all distinct");
  db3.flush();
  closeAll();
  const reopened = await openWorkspaceDb(W3);
  check(reopened.get(rev100.id), "IO-21-04 an imported node survives a reopen");
  equal(successorOf(reopened, rev100.id), Number(rev200.id), "IO-21-04 the imported chain survives a reopen");
  check(reopened.get(afterImport), "IO-21-04 the later insert survives a reopen");

  /* ------------------------------------------------------------ IO-21-06 */
  // Two hosts on one workspace is a kernel-level single-writer limit, not a
  // crash. The UI must not paste the raw TDB error at the user.
  const locked = describeDbFailure(
    new Error(
      "TDB_ERROR: 数据库已锁定 (Database locked): Database '\\\\?\\C:\\work\\.dsh\\trivium.tdb' is already opened with an incompatible access mode",
    ),
  );
  equal(locked?.code, "DB_LOCKED", "IO-21-06 a busy workspace is reported as a lock");
  check(locked.message.includes("另一个 DeepSeek Harness"), "IO-21-06 the message names the other host");
  check(!locked.message.includes("TDB_ERROR"), "IO-21-06 the raw TDB error is not the user-facing text");
  equal(describeDbFailure(new Error("something else")), null, "IO-21-06 other errors keep their own message");

  /* ------------------------------------------------------------ IO-21-07 */
  // The checker must find damage without repairing it. The damage is injected
  // directly into a disposable workspace, not through the public API.
  const db7 = await openWorkspaceDb(W7);
  const healthOld = insertNode(db7, {
    type: "decision",
    name: "体检旧",
    text: "体检用的旧决策。",
    uri: "ctx://decision/health-old",
  });
  const healthNew = insertNode(db7, {
    type: "decision",
    name: "体检新",
    text: "体检用的新决策。",
    uri: "ctx://decision/health-new",
  });
  check(
    supersede(db7, { oldId: healthOld, successorId: healthNew, operationId: "op-p21-07" }).ok,
    "IO-21-07 a healthy chain was created",
  );
  const healthy = checkRevisionIntegrity(db7);
  equal(healthy.ok, true, "IO-21-07 a healthy chain passes the check");
  equal(healthy.edges, 1, "IO-21-07 only the revision edge is counted");

  insertNode(db7, { type: "decision", name: "重复一", text: "重复 URI 的第一条。", uri: "ctx://decision/dup" });
  insertNode(db7, { type: "decision", name: "重复二", text: "重复 URI 的第二条。", uri: "ctx://decision/dup" });
  const forkOld = insertNode(db7, { type: "decision", name: "分叉旧", text: "分叉的旧决策。", uri: "ctx://decision/fork-old" });
  const forkOne = insertNode(db7, { type: "decision", name: "分叉一", text: "分叉的第一个新决策。", uri: "ctx://decision/fork-1" });
  const forkTwo = insertNode(db7, { type: "decision", name: "分叉二", text: "分叉的第二个新决策。", uri: "ctx://decision/fork-2" });
  db7.link(forkOne, forkOld, "supersedes", 0.8);
  db7.link(forkTwo, forkOld, "supersedes", 0.8);
  const cycleA = insertNode(db7, { type: "decision", name: "环一", text: "环里的第一条决策。", uri: "ctx://decision/cycle-a" });
  const cycleB = insertNode(db7, { type: "decision", name: "环二", text: "环里的第二条决策。", uri: "ctx://decision/cycle-b" });
  db7.link(cycleA, cycleB, "supersedes", 0.8);
  db7.link(cycleB, cycleA, "supersedes", 0.8);
  const selfNode = insertNode(db7, {
    type: "decision",
    name: "自环",
    text: "指向自己的决策。",
    uri: "ctx://decision/self",
  });
  let selfLinked = false;
  try {
    // A separate node: a self edge on one of the cycle nodes would turn that
    // node into a fork and hide the two-node cycle behind it.
    db7.link(selfNode, selfNode, "supersedes", 0.8);
    selfLinked = true;
  } catch {
    // the kernel may refuse a self edge; the other checks still apply
  }
  db7.flush();
  const beforeCheck = nodeCountOf(db7);
  const damaged = checkRevisionIntegrity(db7);
  const codes = new Set(damaged.issues.map((issue) => issue.code));
  check(!damaged.ok, "IO-21-07 damaged chains are reported");
  check(codes.has("duplicate-uri"), "IO-21-07 duplicate URIs are reported");
  check(codes.has("fork-predecessor"), "IO-21-07 a fork on the old node is reported");
  check(codes.has("cycle"), "IO-21-07 a cycle is reported");
  if (selfLinked) check(codes.has("self-loop"), "IO-21-07 a self loop is reported");
  equal(nodeCountOf(db7), beforeCheck, "IO-21-07 the checker does not modify the graph");
  equal(typeof damaged.nodes, "number", "IO-21-07 the report carries the scanned size");

  closeAll();
  const readOnlyDb = openWorkspaceDbReadOnly(W7);
  const readOnlyReport = checkRevisionIntegrity(readOnlyDb);
  equal(
    readOnlyReport.issues.length,
    damaged.issues.length,
    "IO-21-07 a read-only open sees the same damage",
  );
  try {
    readOnlyDb.close?.();
  } catch {
    // closing a read-only handle is best effort
  }

  console.log(`\nP21 0.5.1 correctness gate passed (${checks} checks)`);
} finally {
  closeAll();
  rmSync(root, { recursive: true, force: true });
}
