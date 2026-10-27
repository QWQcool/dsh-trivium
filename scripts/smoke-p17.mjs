/**
 * M1: provenance, recall traces, and the read-on-demand HTTP surface.
 *
 * Covers SRC-01..03 and TRACE-01..04 from
 * docs/next-memory/ACCEPTANCE_CASES.json. Real native engine, isolated
 * settings, no network, no embedding, no performance benchmark.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { closeAll, insertNode, nodeCountOf, openWorkspaceDb, ensureLink } from "../lib/store.js";
import {
  noteObservedSession,
  plainText,
  provenanceOf,
  QUOTE_PREVIEW_MAX,
  resetObservedSessions,
} from "../lib/provenance.js";
import { etagOf, historyOf, nodeDetail, revisionStateOf } from "../lib/revisions.js";
import {
  getTrace,
  listTraces,
  resetTraces,
  startTrace,
  TRACE_LIMIT,
  TRACE_MAX_BYTES,
  TRACE_STAGE_NODE_LIMIT,
  TRACE_TTL_MS,
} from "../lib/recall-trace.js";
import { recallPreview, PREVIEW_QUERY_MAX } from "../lib/recall-preview.js";
import { handleMemoryApi } from "../lib/server.js";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p17-"));
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
    liveOptions: () => ({ recallMode: "anchor", topK: 8 }),
    status: { lastInjectTokens: 0, lastContextPlan: null, lastTrace: null },
  });
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.status, json, raw: res.body };
}

try {
  const db = await openWorkspaceDb(WORKSPACE);
  resetObservedSessions();
  resetTraces();

  /* ---------------------------------------------------------------- SRC-01 */
  const sessionId = "sess-src-01";
  noteObservedSession(sessionId);
  const quoted = insertNode(db, {
    type: "decision",
    name: "缓存选型",
    text: "缓存层使用 Redis。",
    source: {
      kind: "chip",
      sessionId,
      quote: `<b>缓存</b>用 Redis，别用 Memcached。${"补".repeat(400)}`,
      capturedAt: "2026-10-27T10:00:00Z",
    },
  });
  const prov = provenanceOf(db, quoted);
  check(prov.status === "recorded", "SRC-01 a stored source is reported as recorded");
  check(prov.source.kind === "chip", "SRC-01 the stable kind survives the legacy via field");
  check(prov.source.quote.length <= QUOTE_PREVIEW_MAX, `SRC-01 the quote preview is capped at ${QUOTE_PREVIEW_MAX}`);
  check(prov.jump === false && prov.jumpReason.includes("session locator"), "SRC-01 no deep link is invented");
  check(
    !JSON.stringify(prov).includes("Memcached。补补补".repeat(1)) || prov.source.quote.endsWith("…"),
    "SRC-01 an over-long quote is truncated, not silently dropped",
  );

  const detail1 = nodeDetail(db, quoted);
  check(detail1.sourceAvailable === true, "SRC-01 detail reports source availability");
  check(!JSON.stringify(detail1).includes("Memcached"), "SRC-01 detail does not expand the quote");
  check(typeof detail1.etag === "string" && detail1.etag.length > 0, "SRC-01 detail carries an opaque etag");

  const httpDetail = await call("GET", `/api/dsh-trivium/nodes/${quoted}/detail?cwd=${encodeURIComponent(WORKSPACE)}`);
  check(httpDetail.status === 200 && httpDetail.json.id === quoted, "SRC-01 GET /nodes/:id/detail answers");
  const httpProv = await call("GET", `/api/dsh-trivium/nodes/${quoted}/provenance?cwd=${encodeURIComponent(WORKSPACE)}`);
  check(httpProv.status === 200 && httpProv.json.status === "recorded", "SRC-01 GET /nodes/:id/provenance answers");

  /* ---------------------------------------------------------------- SRC-02 */
  const bare = insertNode(db, { type: "preference", text: "习惯用 pnpm。" });
  const missing = provenanceOf(db, bare);
  check(missing.status === "missing", "SRC-02 a record without source says so");
  check(missing.source === null, "SRC-02 nothing is guessed for a missing source");

  const ghost = insertNode(db, {
    type: "preference",
    text: "旧的会话约定。",
    source: { kind: "extract", sessionId: "sess-never-seen", quote: "旧的" },
  });
  const unavailable = provenanceOf(db, ghost);
  check(unavailable.status === "unavailable", "SRC-02 a session we cannot confirm is unavailable");
  check(
    unavailable.message.includes("会话已不可用") && unavailable.source.quote === "旧的",
    "SRC-02 the stored excerpt is kept even when the session is gone",
  );
  check(
    !JSON.stringify(unavailable).includes(WORKSPACE) || unavailable.status === "unavailable",
    "SRC-02 no other workspace path leaks through provenance",
  );

  /* ---------------------------------------------------------------- SRC-03 */
  const nasty = insertNode(db, {
    type: "preference",
    text: "来源含脚本。",
    source: {
      kind: "import",
      sessionId,
      quote: `<script>alert(1)</script><img src=x onerror=alert(2)>${"\u0000\u202e".repeat(4)}${"长".repeat(5000)}`,
      importPath: "/tmp/notes.md",
    },
  });
  const nastyProv = provenanceOf(db, nasty);
  check(nastyProv.source.quote.length <= QUOTE_PREVIEW_MAX, "SRC-03 an over-long quote is capped");
  check(
    !/[\u0000\u202a-\u202e]/.test(nastyProv.source.quote),
    "SRC-03 control characters and bidi overrides are stripped",
  );
  check(nastyProv.source.quote.includes("<script>"), "SRC-03 markup is preserved as text, not executed");
  check(plainText("a\u0007b", 10) === "a b", "SRC-03 plainText removes control characters");
  const httpNasty = await call("GET", `/api/dsh-trivium/nodes/${nasty}/provenance?cwd=${encodeURIComponent(WORKSPACE)}`);
  check(httpNasty.status === 200, "SRC-03 untrusted source text is still served as JSON");

  /* ---------------------------------------------------------------- TRACE-01 */
  const gateway = insertNode(db, { type: "entity", name: "AuthGateway", text: "统一鉴权入口。" });
  const decision = insertNode(db, { type: "decision", name: "鉴权", text: "鉴权走 header X。" });
  ensureLink(db, decision, gateway, "about");
  const preview = recallPreview(db, { cwd: WORKSPACE, sessionId, query: "AuthGateway", mode: "anchor" });
  check(preview.ok === true, "TRACE-01 the preview answers");
  check(preview.semantic === "not_run", "TRACE-01 the preview never claims a semantic run");
  const stageNames = (preview.traceId ? getTrace(preview.traceId, { cwd: WORKSPACE, sessionId }).trace.stages : []).map((s) => s.stage);
  check(stageNames.includes("entity-anchor"), "TRACE-01 the anchor branch that actually ran is recorded");
  check(
    !/bm25|vector|contribution|confidence/i.test(JSON.stringify(preview.dropped)),
    "TRACE-01 no fabricated BM25/vector contribution is reported",
  );
  const traceBlob = JSON.stringify(getTrace(preview.traceId, { cwd: WORKSPACE, sessionId }).trace);
  check(!/embedding|apiKey|prompt/i.test(traceBlob), "TRACE-01 a trace stores no vectors, prompts or keys");

  const keywordPreview = recallPreview(db, { cwd: WORKSPACE, sessionId, query: "鉴权 header", mode: "auto" });
  check(keywordPreview.ok === true, "TRACE-01 the auto preview answers");
  const keywordTrace = getTrace(keywordPreview.traceId, { cwd: WORKSPACE, sessionId }).trace;
  check(
    keywordTrace.stages.some((s) => s.stage === "keyword-fallback" || s.stage === "native-hybrid"),
    "TRACE-01 a real retrieval branch is named",
  );

  /* ---------------------------------------------------------------- TRACE-02 */
  const before = nodeCountOf(db);
  const etagBefore = etagOf(db, decision);
  const preview2 = recallPreview(db, { cwd: WORKSPACE, sessionId, query: "鉴权", mode: "auto" });
  check(preview2.semantic === "not_run", "TRACE-02 no query vector means semantic=not_run");
  check(nodeCountOf(db) === before, "TRACE-02 the preview does not write to the database");
  check(etagOf(db, decision) === etagBefore, "TRACE-02 the preview does not mutate a node");
  check(typeof preview2.text.recall === "string", "TRACE-02 the preview shows the exact text that would be sent");
  check(preview2.budget === 300, "TRACE-02 the preview reports the shared 300 budget");
  const tooLong = recallPreview(db, { cwd: WORKSPACE, sessionId, query: "x".repeat(PREVIEW_QUERY_MAX + 1) });
  check(tooLong.ok === false && tooLong.status === 400, "TRACE-02 an over-long preview query is rejected");
  const httpPreview = await call(
    "POST",
    `/api/dsh-trivium/recall-preview?cwd=${encodeURIComponent(WORKSPACE)}`,
    JSON.stringify({ query: "鉴权", sessionId, mode: "anchor" }),
  );
  check(httpPreview.status === 200 && httpPreview.json.semantic === "not_run", "TRACE-02 POST /recall-preview answers");

  /* ---------------------------------------------------------------- TRACE-03 */
  resetTraces();
  const bucket = { cwd: WORKSPACE, sessionId: "sess-retention" };
  for (let i = 0; i < TRACE_LIMIT + 1; i += 1) {
    const trace = startTrace({ ...bucket, query: `q${i}`, mode: "auto", source: "pre-step" });
    trace.stage("keyword-fallback", [{ id: i, type: "decision", l0: `hit ${i}` }]);
    trace.selected({ ids: [i], budget: 300, tokens: 10 });
    trace.finish();
  }
  const kept = listTraces(bucket);
  check(kept.length === TRACE_LIMIT, `TRACE-03 at most ${TRACE_LIMIT} traces are kept (got ${kept.length})`);
  check(kept[0].query === `q${TRACE_LIMIT}`, "TRACE-03 the newest trace is first");

  const big = startTrace({ ...bucket, query: "big", mode: "auto", source: "pre-step" });
  big.stage(
    "business-expand",
    Array.from({ length: TRACE_STAGE_NODE_LIMIT + 25 }, (_, i) => ({ id: i, type: "entity", l0: "长".repeat(200) })),
  );
  big.selected({ ids: [], budget: 300, tokens: 0 });
  const bigTrace = big.finish();
  check(bigTrace.stages[0].nodes.length <= TRACE_STAGE_NODE_LIMIT, "TRACE-03 a stage keeps at most 100 node summaries");
  check(bigTrace.stages[0].truncated === true, "TRACE-03 a capped stage says truncated");
  check(bigTrace.bytes <= TRACE_MAX_BYTES, `TRACE-03 a trace stays within 64 KiB (got ${bigTrace.bytes})`);

  const realNow = Date.now;
  try {
    const later = realNow() + TRACE_TTL_MS + 1000;
    Date.now = () => later;
    check(listTraces(bucket).length === 0, "TRACE-03 traces expire after the TTL");
    const gone = getTrace(bigTrace.traceId, bucket);
    check(gone.ok === false && gone.status === 410, "TRACE-03 an expired trace id answers 410");
    const httpGone = await call(
      "GET",
      `/api/dsh-trivium/recall-traces/${bigTrace.traceId}?cwd=${encodeURIComponent(WORKSPACE)}&session=sess-retention`,
    );
    check(httpGone.status === 410, "TRACE-03 the route returns 410 for an expired trace");
  } finally {
    Date.now = realNow;
  }

  /* ---------------------------------------------------------------- TRACE-04 */
  const mine = startTrace({ ...bucket, query: "isolation", mode: "auto", source: "pre-step" });
  mine.selected({ ids: [], budget: 300, tokens: 0 });
  const mineTrace = mine.finish();
  const otherSession = getTrace(mineTrace.traceId, { cwd: WORKSPACE, sessionId: "someone-else" });
  check(otherSession.ok === false && otherSession.status === 404, "TRACE-04 another session cannot read this trace");
  const otherCwd = getTrace(mineTrace.traceId, { cwd: join(root, "other"), sessionId: "sess-retention" });
  check(otherCwd.ok === false && otherCwd.status === 404, "TRACE-04 another workspace cannot read this trace");
  check(
    listTraces({ cwd: WORKSPACE, sessionId: "someone-else" }).length === 0,
    "TRACE-04 listing is scoped to one workspace+session",
  );
  const httpOther = await call(
    "GET",
    `/api/dsh-trivium/recall-traces/${mineTrace.traceId}?cwd=${encodeURIComponent(WORKSPACE)}&session=someone-else`,
  );
  check(httpOther.status === 404 && !httpOther.raw.includes("isolation"), "TRACE-04 the route leaks nothing");

  /* --------------------------------------------------- detail / history API */
  const history = historyOf(db, quoted);
  check(history.ok === true && history.nodes.length === 1, "history returns just this node while no chain exists");
  check(history.nodes[0].isCurrent === true && history.nodes[0].relation === null, "history marks the current node");
  const httpHistory = await call("GET", `/api/dsh-trivium/nodes/${quoted}/history?cwd=${encodeURIComponent(WORKSPACE)}&limit=20`);
  check(httpHistory.status === 200 && httpHistory.json.requestedId === quoted, "GET /nodes/:id/history answers");
  const noNode = await call("GET", `/api/dsh-trivium/nodes/999999/detail?cwd=${encodeURIComponent(WORKSPACE)}`);
  check(noNode.status === 404, "detail answers 404 for an unknown node");
  const revision = revisionStateOf(db, quoted);
  check(revision.ok === true && revision.superseded === false, "a node with no chain is its own current version");

  console.log(`\nP17 provenance and recall traces passed (${checks} checks)`);
} catch (err) {
  console.error("FAIL " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  closeAll();
  rmSync(root, { recursive: true, force: true });
}
