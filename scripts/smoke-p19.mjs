/**
 * M2: human-confirmed decision supersession.
 *
 * Covers REV-01..REV-11 from docs/next-memory/ACCEPTANCE_CASES.json. Real
 * native engine, isolated settings, no network, no performance benchmark.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import {
  archiveNode,
  closeAll,
  deleteNode,
  ensureLink,
  findMergeTarget,
  hasEdge,
  insertNode,
  listNodes,
  mergeInto,
  mergeNodes,
  openWorkspaceDb,
  predecessorOf,
  successorOf,
  supersedesIn,
  updateNode,
} from "../lib/store.js";
import {
  currentHeadOf,
  etagOf,
  historyOf,
  makeRevisionResolver,
  nodeDetail,
  REVISION_CODES,
  revisionStateOf,
  revokeSupersession,
  supersede,
  withWorkspaceQueue,
} from "../lib/revisions.js";
import { selectContextRecords } from "../lib/context-budget.js";
import { pinCandidates } from "../lib/pins.js";
import { recallPreview } from "../lib/recall-preview.js";
import { isStalePayload } from "../lib/until.js";
import { handleMemoryApi } from "../lib/server.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p19-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const WORKSPACE = join(root, "workspace");

let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
  console.log("ok  " + message);
}

function mockReq({ method = "GET", url = "/", body = "" } = {}) {
  const stream = Readable.from(body ? [Buffer.from(body, "utf8")] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = {};
  stream.socket = { remoteAddress: "127.0.0.1" };
  return stream;
}

async function call(method, url, body) {
  const res = {
    status: 0,
    body: "",
    writeHead(status) {
      this.status = status;
    },
    end(data) {
      this.body = data ? Buffer.from(data).toString("utf8") : "";
    },
  };
  await handleMemoryApi(mockReq({ method, url, body }), res, {
    liveOptions: () => ({ recallMode: "anchor" }),
    status: {},
  });
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const q = (path) => `${path}${path.includes("?") ? "&" : "?"}cwd=${encodeURIComponent(WORKSPACE)}`;

try {
  const db = await openWorkspaceDb(WORKSPACE);

  /* ---------------------------------------------------------------- REV-01 */
  const A = insertNode(db, { type: "decision", name: "缓存层", text: "缓存层使用 Redis。", until: "下周" });
  const B = insertNode(db, { type: "decision", name: "缓存层", text: "缓存层改用进程内 LRU。" });
  const aBefore = { ...db.get(A).payload };
  const linked = supersede(db, {
    oldId: A,
    successorId: B,
    reason: "内存成本",
    expectedEtags: { old: etagOf(db, A), new: etagOf(db, B) },
    operationId: "op-rev01",
  });
  check(linked.ok === true, "REV-01 the replacement is confirmed");
  check(successorOf(db, A) === B, "REV-01 the edge points new -> old");
  check(predecessorOf(db, B) === A, "REV-01 the reverse lookup agrees");
  check(supersedesIn(db, A).length === 1, "REV-01 exactly one relation exists");
  check(
    db.get(A).payload.text === aBefore.text && db.get(A).payload.until === aBefore.until,
    "REV-01 the old body and deadline are untouched",
  );
  check(db.get(A).payload.status !== "archived", "REV-01 the old decision is not archived");
  const meta = supersedesIn(db, A)[0].metadata;
  check(meta.reason === "内存成本" && meta.operationId === "op-rev01", "REV-01 the reason is stored on the edge");
  check(revisionStateOf(db, B).superseded === false, "REV-01 the new decision is the current version");
  const resolver = makeRevisionResolver(db);
  check(resolver(A)?.currentId === B, "REV-01 automatic recall resolves to the current head");
  check(db.get(A).payload.text.includes("Redis"), "REV-01 ctx_read can still read the old body");

  /* ---------------------------------------------------------------- REV-02 */
  const plan = selectContextRecords({
    recall: [{ id: A, type: "decision", l0: "缓存层使用 Redis。" }],
    budget: 300,
    resolveCurrent: resolver,
  });
  check(plan.records.length === 1 && plan.records[0].id === B, "REV-02 an old-version hit maps to the head");
  check(
    plan.records[0].matchedHistory?.from === A && plan.records[0].matchedHistory?.current === B,
    "REV-02 the record carries a short history pointer",
  );
  const dupPlan = selectContextRecords({
    recall: [
      { id: A, type: "decision", l0: "缓存层使用 Redis。" },
      { id: B, type: "decision", l0: "缓存层改用进程内 LRU。" },
    ],
    budget: 300,
    resolveCurrent: resolver,
  });
  check(dupPlan.records.length === 1, "REV-02 old and new hits collapse into one record");

  /* ---------------------------------------------------------------- REV-03 */
  const C = insertNode(db, { type: "decision", name: "超时", text: "请求超时设为 30 秒。", until: "2020-01-01" });
  check(isStalePayload(db.get(C).payload) === true, "REV-03 C is expired by deadline");
  const plain = listNodes(db, {}).map((row) => row.id);
  check(!plain.includes(A) && plain.includes(B), "REV-03 the list hides a replaced version by default");
  check(!plain.includes(C), "REV-03 the list also hides an expired decision by default");
  const withReplaced = listNodes(db, { includeSuperseded: true }).map((row) => row.id);
  check(withReplaced.includes(A), "REV-03 showing replaced versions reveals A");
  check(!withReplaced.includes(C), "REV-03 showing replaced versions does not reveal expired C");
  const withExpired = listNodes(db, { includeStale: true }).map((row) => row.id);
  check(withExpired.includes(C), "REV-03 showing expired reveals C");
  check(!withExpired.includes(A), "REV-03 showing expired does not reveal replaced A");
  const rowA = listNodes(db, { includeSuperseded: true }).find((row) => row.id === A);
  check(rowA.revision === "superseded" && rowA.stale === false, "REV-03 the two states are reported separately");
  check(rowA.supersededBy === B && rowA.replacesId === null, "REV-03 the row names its current version");

  /* ---------------------------------------------------------------- REV-04 */
  const self = supersede(db, { oldId: A, successorId: A, operationId: "op-self" });
  check(self.ok === false && self.code === REVISION_CODES.self, "REV-04 a self replacement is refused");

  const cycle = supersede(db, { oldId: B, successorId: A, operationId: "op-cycle" });
  check(cycle.ok === false && cycle.code === REVISION_CODES.cycle, "REV-04 a cycle is refused");

  const D = insertNode(db, { type: "decision", text: "第三条决策。" });
  const fork1 = supersede(db, { oldId: A, successorId: D, operationId: "op-fork" });
  check(fork1.ok === false && fork1.code === REVISION_CODES.alreadySuperseded, "REV-04 a second successor is refused");

  const E = insertNode(db, { type: "decision", text: "第四条决策。" });
  supersede(db, { oldId: D, successorId: E, operationId: "op-chain" });
  const fork2 = supersede(db, { oldId: B, successorId: E, operationId: "op-fork2" });
  check(
    fork2.ok === false && fork2.code === REVISION_CODES.successorHasPredecessor,
    "REV-04 a successor with its own predecessor is refused (linear chain only)",
  );

  const pref = insertNode(db, { type: "preference", text: "偏好不能参与替代。" });
  const nonDecision = supersede(db, { oldId: A, successorId: pref, operationId: "op-nond" });
  check(nonDecision.ok === false && nonDecision.code === REVISION_CODES.nonDecision, "REV-04 only decisions can be replaced");

  /*
   * Node ids are workspace-local, so a foreign id simply does not exist in this
   * db. The guard is that resolution never leaves the requested workspace — an
   * id from another store is "not found", never silently matched.
   */
  const other = await openWorkspaceDb(join(root, "other-workspace"));
  insertNode(other, { type: "decision", text: "别的工作区的决策。" });
  const absentId = 987654;
  check(db.get(absentId) == null, "REV-04 a foreign id is absent from this workspace");
  const cross = supersede(db, { oldId: D, successorId: absentId, operationId: "op-cross" });
  check(cross.ok === false && cross.code === REVISION_CODES.notFound, "REV-04 resolution stays inside the workspace");
  const foreignCwd = await call(
    "POST",
    `/api/dsh-trivium/nodes/${D}/supersede?cwd=${encodeURIComponent(join(root, "unlisted-workspace"))}`,
    JSON.stringify({ successorId: A, operationId: "op-cross-http" }),
  );
  check(foreignCwd.status === 400, "REV-04 an unregistered workspace is refused by the route");

  // 32-hop cap: build a chain that is longer than the walk limit.
  let cursor = insertNode(db, { type: "decision", text: "链头 0。" });
  for (let i = 1; i <= 33; i += 1) {
    const next = insertNode(db, { type: "decision", text: `链头 ${i}。` });
    supersede(db, { oldId: cursor, successorId: next, operationId: `op-hop-${i}` });
    cursor = next;
  }
  check(currentHeadOf(db, cursor).ok === true, "REV-04 the head of the long chain resolves");
  const longTail = insertNode(db, { type: "decision", text: "想接在过长链后面。" });
  const tooLong = supersede(db, { oldId: cursor, successorId: longTail, operationId: "op-toolong" });
  check(
    tooLong.ok === false && tooLong.code === REVISION_CODES.tooLong,
    "REV-04 a chain beyond the hop limit is refused, not half-resolved",
  );
  const unresolved = currentHeadOf(db, A);
  check(unresolved.ok === true, "REV-04 short chains still resolve after the refusal");

  /* ---------------------------------------------------------------- REV-05 */
  const F = insertNode(db, { type: "decision", text: "并发测试旧决策。" });
  const G = insertNode(db, { type: "decision", text: "并发测试新决策。" });
  const staleEtag = etagOf(db, F);
  const first = supersede(db, {
    oldId: F,
    successorId: G,
    expectedEtags: { old: staleEtag, new: etagOf(db, G) },
    operationId: "op-rev05",
  });
  check(first.ok === true, "REV-05 the first window succeeds");
  const H = insertNode(db, { type: "decision", text: "第二个窗口选择的决策。" });
  const second = supersede(db, {
    oldId: F,
    successorId: H,
    expectedEtags: { old: staleEtag, new: etagOf(db, H) },
    operationId: "op-rev05-b",
  });
  check(second.ok === false && second.status === 409, "REV-05 a stale etag cannot overwrite another window");
  check(successorOf(db, F) === G, "REV-05 the original relation survives");

  const retry = supersede(db, { oldId: F, successorId: G, operationId: "op-rev05" });
  check(retry.ok === true && retry.alreadyApplied === true, "REV-05 the same operationId is idempotent");
  check(supersedesIn(db, F).length === 1, "REV-05 a retry does not create a parallel edge");

  // A lost response is recognised by re-reading the relation, not by guessing.
  const lostThenRetry = supersede(db, { oldId: F, successorId: G, operationId: "op-new-but-same-pair" });
  check(lostThenRetry.ok === true && lostThenRetry.alreadyApplied === true, "REV-05 re-reading recognises an applied relation");
  check(supersedesIn(db, F).length === 1, "REV-05 still exactly one edge");

  /* ---------------------------------------------------------------- REV-06 */
  const keepIn = insertNode(db, { type: "decision", text: "事务失败旧。" });
  const keepOut = insertNode(db, { type: "decision", text: "事务失败新。" });
  const realCommit = db.commitTransaction.bind(db);
  db.commitTransaction = () => {
    throw new Error("injected failure");
  };
  const failed = supersede(db, { oldId: keepIn, successorId: keepOut, operationId: "op-rev06" });
  db.commitTransaction = realCommit;
  check(
    failed.ok === false && failed.code === REVISION_CODES.transactionFailed,
    "REV-06 a native transaction failure is reported",
  );
  check(
    successorOf(db, keepIn) == null && predecessorOf(db, keepOut) == null,
    "REV-06 a failed transaction leaves both ends unchanged",
  );

  /* ---------------------------------------------------------------- REV-07 */
  check(
    linked.ok === true && successorOf(db, A) === B,
    "REV-07 the graph keeps the relation even though the JSONL file is written later",
  );
  const status = await call("GET", q("/api/dsh-trivium/status"));
  check(
    status.json && status.json.derived && typeof status.json.derived.sidecar.ok === "boolean",
    "REV-07 the derived sidecar state is reported separately",
  );

  /* ---------------------------------------------------------------- REV-08 */
  let protectedError = null;
  try {
    updateNode(db, A, { text: "偷偷改写历史。" });
  } catch (err) {
    protectedError = err;
  }
  check(protectedError?.code === "REVISION_PROTECTED", "REV-08 an in-place body rewrite is refused");
  check(db.get(A).payload.text.includes("Redis"), "REV-08 the history body is unchanged");

  const renamed = updateNode(db, A, { name: "缓存层（历史）" });
  check(renamed?.name === "缓存层（历史）", "REV-08 non-factual fields remain editable");

  check(
    findMergeTarget(db, { type: "decision", name: "缓存层", text: "缓存层使用 Redis。" }) == null,
    "REV-08 auto-extraction will not merge into a chain node",
  );
  // A longer incoming body would win mergeInto's text heuristic, which is
  // exactly the overwrite the chain has to refuse.
  let mergeIntoError = null;
  try {
    mergeInto(db, A, { text: "合并进来的新说法，比原来更长也更具体，足以覆盖旧正文。" });
  } catch (err) {
    mergeIntoError = err;
  }
  check(mergeIntoError?.code === "REVISION_PROTECTED", "REV-08 mergeInto protects the chain body");
  check(db.get(A).payload.text.includes("Redis"), "REV-08 the body still matches history");

  /* ---------------------------------------------------------------- REV-09 */
  ensureLink(db, B, A, "about");
  check(hasEdge(db, B, A, "about"), "REV-09 a plain about edge exists between the same two nodes");
  const revoked = revokeSupersession(db, {
    oldId: A,
    successorId: B,
    expectedEtags: { old: etagOf(db, A), new: etagOf(db, B) },
    operationId: "op-rev09",
  });
  check(revoked.ok === true, "REV-09 the relation is revoked");
  check(successorOf(db, A) == null, "REV-09 A has no successor again");
  check(hasEdge(db, B, A, "about"), "REV-09 the unrelated about edge survives");
  check(!hasEdge(db, B, A, "supersedes"), "REV-09 only the supersedes edge was removed");

  // Rebuild a chain, then refuse a revoke that would split the wrong place.
  supersede(db, { oldId: A, successorId: B, operationId: "op-rev09-b" });
  const later = insertNode(db, { type: "decision", text: "再一次更新后的缓存决策。" });
  supersede(db, { oldId: B, successorId: later, operationId: "op-rev09-c" });
  const wrongSplit = revokeSupersession(db, { oldId: A, successorId: B, operationId: "op-rev09-d" });
  check(
    wrongSplit.ok === false && wrongSplit.code === REVISION_CODES.hasLaterVersion,
    "REV-09 revoking below a newer version is refused",
  );

  /* ---------------------------------------------------------------- REV-10 */
  const chainOld = insertNode(db, { type: "decision", text: "归档测试旧决策。" });
  const chainNew = insertNode(db, { type: "decision", text: "归档测试新决策。" });
  supersede(db, { oldId: chainOld, successorId: chainNew, operationId: "op-rev10" });
  archiveNode(db, chainNew);
  const archivedResolver = makeRevisionResolver(db);
  const archivedPlan = selectContextRecords({
    recall: [{ id: chainOld, type: "decision", l0: "归档测试旧决策。" }],
    budget: 300,
    resolveCurrent: archivedResolver,
  });
  check(archivedPlan.records.length === 0, "REV-10 an archived successor does not resurrect the old node");
  check(
    listNodes(db, { includeSuperseded: true }).find((row) => row.id === chainOld)?.revision === "superseded",
    "REV-10 the UI can still show the history state",
  );

  const expiredNew = insertNode(db, { type: "decision", text: "过期测试新决策。", until: "2020-01-01" });
  const expiredOld = insertNode(db, { type: "decision", text: "过期测试旧决策。" });
  supersede(db, { oldId: expiredOld, successorId: expiredNew, operationId: "op-rev10-b" });
  const expiredPlan = selectContextRecords({
    recall: [{ id: expiredOld, type: "decision", l0: "过期测试旧决策。" }],
    budget: 300,
    resolveCurrent: makeRevisionResolver(db),
  });
  check(expiredPlan.records.length === 0, "REV-10 an expired successor does not revive the old decision");

  /* ---------------------------------------------------------------- REV-11 */
  let deleteError = null;
  try {
    deleteNode(db, A);
  } catch (err) {
    deleteError = err;
  }
  check(deleteError?.code === "REVISION_LINKED", "REV-11 deleting a chain node is refused");

  const mergeResult = mergeNodes(db, A, B);
  check(
    mergeResult.ok === false && mergeResult.status === 409 && mergeResult.code === "REVISION_LINKED",
    "REV-11 merging a chain node is refused with 409",
  );
  const httpDelete = await call("POST", q(`/api/dsh-trivium/nodes/${A}/delete`));
  check(httpDelete.status === 409 && httpDelete.json.code === "REVISION_LINKED", "REV-11 the route answers 409 REVISION_LINKED");
  const httpMerge = await call("POST", q(`/api/dsh-trivium/nodes/${A}/merge`), JSON.stringify({ dropId: B }));
  check(httpMerge.status === 409, "REV-11 the merge route answers 409");

  /* ------------------------------------------------------- HTTP write paths */
  const H1 = insertNode(db, { type: "decision", text: "接口测试旧。" });
  const H2 = insertNode(db, { type: "decision", text: "接口测试新。" });
  const d1 = await call("GET", q(`/api/dsh-trivium/nodes/${H1}/detail`));
  const d2 = await call("GET", q(`/api/dsh-trivium/nodes/${H2}/detail`));
  const httpOk = await call(
    "POST",
    q(`/api/dsh-trivium/nodes/${H1}/supersede`),
    JSON.stringify({
      successorId: H2,
      reason: "接口",
      operationId: "op-http-1",
      expectedEtags: { old: d1.json.etag, new: d2.json.etag },
    }),
  );
  check(httpOk.status === 200 && httpOk.json.ok === true, "the supersede route accepts a valid request");
  const httpStale = await call(
    "POST",
    q(`/api/dsh-trivium/nodes/${H1}/supersede`),
    JSON.stringify({ successorId: H2, operationId: "op-http-2", expectedEtags: { old: d1.json.etag, new: d2.json.etag } }),
  );
  check(
    httpStale.status === 409 || httpStale.json?.alreadyApplied === true,
    "a repeated relation is never duplicated by the route",
  );
  const httpRevoke = await call(
    "POST",
    q(`/api/dsh-trivium/nodes/${H1}/supersession/revoke`),
    JSON.stringify({ successorId: H2, operationId: "op-http-3" }),
  );
  check(httpRevoke.status === 200 && httpRevoke.json.ok === true, "the revoke route answers");
  const httpBad = await call("POST", q(`/api/dsh-trivium/nodes/${H1}/supersede`), JSON.stringify({}));
  check(httpBad.status === 400, "an incomplete request is rejected with 400");
  const httpMissing = await call(
    "POST",
    q(`/api/dsh-trivium/nodes/999999/supersede`),
    JSON.stringify({ successorId: H2, operationId: "op-http-4" }),
  );
  check(httpMissing.status === 404, "an unknown node answers 404");

  /* ------------------------------------------------------------- history API */
  const chain = insertNode(db, { type: "decision", text: "历史链第一条。" });
  const chain2 = insertNode(db, { type: "decision", text: "历史链第二条。" });
  supersede(db, { oldId: chain, successorId: chain2, reason: "第二次", operationId: "op-h1" });
  const history = historyOf(db, chain);
  check(history.ok === true && history.nodes.length === 2, "history returns the whole chain");
  check(history.nodes[0].id === chain2 && history.nodes[0].isCurrent === true, "history is newest first");
  check(history.nodes[1].id === chain && history.nodes[1].isRequested === true, "history marks the requested node");
  check(history.nodes[1].relation?.reason === "第二次", "history carries the relation reason");
  const paged = historyOf(db, chain, { limit: 1 });
  check(paged.nodes.length === 1 && paged.nextCursor === "1", "history paginates with a cursor");

  /* --------------------------------------------------------- serialisation */
  const detail = nodeDetail(db, chain);
  check(detail.revisionState === "superseded" && detail.currentId === chain2, "detail reports the current version");
  check(detail.expiryState === "none", "detail keeps expiry on its own axis");

  // The queue serialises work per workspace.
  const order = [];
  await withWorkspaceQueue(WORKSPACE, async () => {
    order.push("first-start");
    await new Promise((ok) => setTimeout(ok, 10));
    order.push("first-end");
  });
  await withWorkspaceQueue(WORKSPACE, async () => {
    order.push("second");
  });
  check(
    order.join(",") === "first-start,first-end,second",
    "withWorkspaceQueue serialises read-validate-commit per workspace",
  );

  console.log(`\nP19 revision relations passed (${checks} checks)`);
} catch (err) {
  console.error("FAIL " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  closeAll();
  rmSync(root, { recursive: true, force: true });
}
