/**
 * M0: one shared per-turn context budget, node de-duplication, a per-turn
 * delivery ledger, and a bounded ctx_find output.
 *
 * Covers CTX-01..CTX-10 from docs/next-memory/ACCEPTANCE_CASES.json. Real native
 * engine, isolated settings, no network and no performance benchmark.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  closeAll,
  formatHit,
  insertNode,
  openWorkspaceDb,
  updateNode,
  buildShortMapReport,
} from "../lib/store.js";
import { pinCandidates, setSessionPins } from "../lib/pins.js";
import {
  MAP_TOKEN_BUDGET,
  renderContextRecords,
  selectContextRecords,
  TURN_ADDITIONAL_BUDGET,
  turnKeyOf,
} from "../lib/context-budget.js";
import * as ledger from "../lib/turn-ledger.js";
import { CTX_FIND_OUTPUT_BUDGET, packTextBlocks, projectPayloadForTool } from "../lib/tool-output.js";
import { estimatedSchemaTokens, schemaProjection } from "../lib/tool-defs.js";
import { estimateTokens } from "../lib/tokens.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p16-"));
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");

let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
  console.log("ok  " + message);
}

const BIG = "说明".repeat(50); // ~100 estimated tokens of CJK per node

function cand(db, id, extra = {}) {
  const row = formatHit(db, { id });
  return {
    id: row.id,
    type: row.type,
    l0: row.l0,
    until: row.until,
    stale: row.stale,
    path: row.path,
    ...extra,
  };
}

function userMessage(id, text) {
  return { id, source: { kind: "user" }, content: [{ type: "text", text }] };
}

try {
  const db = await openWorkspaceDb(join(root, "workspace"));

  /* ---------------------------------------------------------------- CTX-01 */
  const map = buildShortMapReport(db, MAP_TOKEN_BUDGET);
  check(MAP_TOKEN_BUDGET === 400, "CTX-01 the session map budget is still 400");
  check(map.tokens <= 400, "CTX-01 the map stays within 400 estimated tokens");
  const indexSrc = readFileSync(join(ROOT, "lib", "index.js"), "utf8");
  check(
    /if \(!chipsOn && mode === "off"\) \{[\s\S]{0,120}?return decision;/.test(indexSrc),
    "CTX-01 both channels off returns before any pin/recall planning",
  );
  const serverSrc = readFileSync(join(ROOT, "lib", "server.js"), "utf8");
  check(
    !/agent\.inject|\.inject\(/.test(serverSrc),
    "CTX-01 the settings/API surface never injects context",
  );

  /* ---------------------------------------------------------------- CTX-02 */
  const A = insertNode(db, { type: "preference", text: `A ${BIG}` });
  const B = insertNode(db, { type: "preference", text: `B ${BIG}` });
  const C = insertNode(db, { type: "decision", text: `C ${BIG}` });
  const session = "s-shared";
  setSessionPins(db, session, [A, B]);
  const pins = pinCandidates(db, session);
  check(pins.length === 2, "CTX-02 pins become structured candidates, not a rendered string");

  const shared = selectContextRecords({
    pins,
    recall: [cand(db, A), cand(db, C)],
    budget: TURN_ADDITIONAL_BUDGET,
  });
  check(shared.tokens <= 300, `CTX-02 pins + recall stay within 300 (got ${shared.tokens})`);
  check(shared.records.filter((r) => r.id === A).length === 1, "CTX-02 a node in both channels is injected once");
  check(
    shared.records.find((r) => r.id === C) === undefined,
    "CTX-02 recall only gets the remaining budget, not its own 300",
  );
  check(
    shared.dropped.some((d) => d.id === C && d.reason === "over-budget"),
    "CTX-02 the reason for dropping C is recorded",
  );
  const rendered = renderContextRecords(shared, { form: "autoRecall" });
  check(rendered.pins.tokens + rendered.recall.tokens <= 300, "CTX-02 rendered blocks share one allowance");
  check(
    estimateTokens(rendered.pins.text) <= 300 && rendered.pins.text.includes("dsh-trivium pins"),
    "CTX-02 the pin block keeps its label and its own measured size",
  );

  /* ---------------------------------------------------------------- CTX-03 */
  ledger.resetAll();
  const turn3 = "uid:turn-3";
  const small = "s-turn3";
  const only = insertNode(db, { type: "preference", text: "只钉一条" });
  setSessionPins(db, small, [only]);
  const smallPins = pinCandidates(db, small);
  const passes = [];
  for (let i = 0; i < 3; i += 1) {
    const plan = selectContextRecords({
      pins: smallPins,
      budget: ledger.remainingOf(small, turn3, TURN_ADDITIONAL_BUDGET),
      delivered: ledger.deliveredOf(small, turn3),
    });
    passes.push(plan.records.length);
    if (plan.records.length) ledger.commit(ledger.reserve(small, turn3, plan.records));
  }
  check(passes[0] === 1, "CTX-03 the first pre-step of a turn delivers the pin");
  check(passes[1] === 0 && passes[2] === 0, "CTX-03 later steps in the same turn inject nothing new");

  /* ---------------------------------------------------------------- CTX-04 */
  const same = "同样的请求文本";
  const turnA = turnKeyOf([userMessage("msg-1", same)]);
  const turnB = turnKeyOf([userMessage("msg-2", same)]);
  check(turnA !== turnB, "CTX-04 identical text with different host ids is two turns");
  check(!turnA.includes(same), "CTX-04 the turn key never contains the message text");
  const bare = { source: { kind: "user" }, content: [{ type: "text", text: same }] };
  check(turnKeyOf([bare]) === turnKeyOf([bare]), "CTX-04 a host without ids keeps one key per message object");
  const bare2 = { source: { kind: "user" }, content: [{ type: "text", text: same }] };
  check(turnKeyOf([bare]) !== turnKeyOf([bare2]), "CTX-04 a different message object is a different turn");
  check(turnKeyOf([]) === "" && turnKeyOf([{ source: { kind: "plugin" } }]) === "", "CTX-04 no user message means no turn");

  const s4 = "s-ctxt04";
  ledger.resetAll();
  const plan1 = selectContextRecords({ pins: smallPins, budget: 300, delivered: ledger.deliveredOf(s4, turnA) });
  ledger.commit(ledger.reserve(s4, turnA, plan1.records));
  const plan2 = selectContextRecords({ pins: smallPins, budget: 300, delivered: ledger.deliveredOf(s4, turnB) });
  check(plan2.records.length === 1, "CTX-04 a new turn re-selects instead of replaying the old dedupe");

  /* ---------------------------------------------------------------- CTX-05 */
  ledger.resetAll();
  const s5 = "s-retry";
  const turn5 = "uid:turn-5";
  const attempt = selectContextRecords({ pins: smallPins, budget: 300, delivered: ledger.deliveredOf(s5, turn5) });
  const reservation = ledger.reserve(s5, turn5, attempt.records);
  ledger.rollback(reservation);
  check(ledger.deliveredOf(s5, turn5).size === 0, "CTX-05 a failed send marks nothing delivered");
  check(ledger.spentOf(s5, turn5) === 0, "CTX-05 a failed send spends no budget");
  const retry = selectContextRecords({ pins: smallPins, budget: 300, delivered: ledger.deliveredOf(s5, turn5) });
  check(retry.records.length === attempt.records.length, "CTX-05 the retry still has content");
  ledger.commit(ledger.reserve(s5, turn5, retry.records));
  const after = selectContextRecords({ pins: smallPins, budget: 300, delivered: ledger.deliveredOf(s5, turn5) });
  check(after.records.length === 0, "CTX-05 after the successful retry nothing repeats");
  const reserveAt = indexSrc.indexOf("const reservation = reserve(");
  const commitAt = indexSrc.indexOf("commit(reservation);");
  check(
    reserveAt > 0 && commitAt > reserveAt && /rollback\(reservation\);/.test(indexSrc),
    "CTX-05 the pre-step wires reserve -> assemble -> commit with a rollback path",
  );

  /* ---------------------------------------------------------------- CTX-06 */
  const s6 = "s-compact";
  ledger.beginTurn(s6, "uid:t6");
  ledger.commit(ledger.reserve(s6, "uid:t6", selectContextRecords({ pins: smallPins, budget: 300 }).records));
  check(ledger.deliveredOf(s6, "uid:t6").size > 0, "CTX-06 something was delivered before compaction");
  ledger.clearAfterCompaction(s6);
  const rebuilt = selectContextRecords({ pins: smallPins, budget: 300, delivered: ledger.deliveredOf(s6, "uid:t6") });
  check(rebuilt.records.length === 1, "CTX-06 compaction allows the next turn to rebuild");

  const fork = "s-fork-child";
  check(ledger.deliveredOf(fork, "uid:t6").size === 0, "CTX-06 a fork starts with an empty ledger");
  check(ledger.spentOf(fork, "uid:t6") === 0, "CTX-06 a fork inherits no spent budget");
  setSessionPins(db, fork, []);
  check(pinCandidates(db, fork).length === 0, "CTX-06 a fork inherits no pins");

  ledger.resetAll();
  ledger.beginTurn("s-gen", "uid:g");
  const inFlight = ledger.reserve("s-gen", "uid:g", [{ id: 1, fingerprint: "f1", tokens: 10 }]);
  ledger.clearAfterCompaction("s-gen");
  ledger.commit(inFlight);
  check(ledger.spentOf("s-gen", "uid:g") === 0, "CTX-06 an in-flight reservation cannot commit across compaction");

  /* ---------------------------------------------------------------- CTX-07 */
  ledger.resetAll();
  const s7 = "s-correction";
  const turn7 = "uid:t7";
  ledger.commit(ledger.reserve(s7, turn7, [{ id: 1, fingerprint: "spent", tokens: 250 }]));
  const left = ledger.remainingOf(s7, turn7, TURN_ADDITIONAL_BUDGET);
  check(left === 50, `CTX-07 250 spent leaves 50, not a fresh 300 (got ${left})`);
  const correction = {
    id: 2,
    type: "decision",
    l0: `更正：该决策已被替代。${"说明".repeat(40)}`,
    note: "superseded",
  };
  const plan7 = selectContextRecords({ corrections: [correction], budget: left });
  check(plan7.budget === left, "CTX-07 a correction uses the remaining budget");
  check(
    plan7.records.length === 0 && plan7.deferred.length === 1,
    "CTX-07 a correction that does not fit is deferred, not given a new 300",
  );

  /* ---------------------------------------------------------------- CTX-08 */
  const read8 = insertNode(db, { type: "decision", text: "接口版本保持兼容。", source: { sessionId: "s" } });
  const project = (id) => {
    const node = db.get(id);
    return JSON.stringify({ id: node.id, payload: projectPayloadForTool(node.payload), edges: node.edges });
  };
  const before8 = project(read8);
  updateNode(db, read8, {
    source: {
      sessionId: "s",
      kind: "extract",
      quote: "引用".repeat(2000),
      messageId: "m-1",
      capturedAt: "2026-10-27T00:00:00Z",
      importPath: "/tmp/notes.md",
    },
    revision: { supersedes: [], supersededBy: null },
    history: Array.from({ length: 40 }, (_, i) => ({ id: i, text: "旧".repeat(50) })),
  });
  const after8 = project(read8);
  // updatedAt legitimately moves on a write; everything else must be identical.
  const withoutStamp = (blob) => {
    const parsed = JSON.parse(blob);
    delete parsed.payload.updatedAt;
    return JSON.stringify(parsed);
  };
  check(
    withoutStamp(before8) === withoutStamp(after8),
    "CTX-08 new provenance/revision metadata does not grow the default ctx_read output",
  );
  check(!after8.includes("引用引用") && !after8.includes("capturedAt"), "CTX-08 provenance fields stay out of tool output");
  check(
    JSON.parse(after8).payload.text === "接口版本保持兼容。",
    "CTX-08 ctx_read still returns the full body",
  );

  const blocks = Array.from({ length: 40 }, (_, i) => `## decision\n[1.000] id=${i}\n${"内容".repeat(80)}\npath: (none)`);
  const packed = packTextBlocks(blocks, { budget: CTX_FIND_OUTPUT_BUDGET });
  check(packed.tokens <= 1200, `CTX-08 ctx_find stays within 1200 estimated tokens (got ${packed.tokens})`);
  check(packed.omitted > 0 && packed.kept < blocks.length, "CTX-08 over-budget hits are omitted, not sliced");
  const keptBlocks = packed.text.split("\n\n").slice(0, packed.kept);
  check(
    keptBlocks.every((block) => blocks.includes(block)),
    "CTX-08 every kept record is complete — no half JSON, no truncated id",
  );
  check(/omitted/.test(packed.text), "CTX-08 truncation is announced");
  const small8 = packTextBlocks(blocks.slice(0, 1), { budget: 1200 });
  check(small8.truncated === false && small8.text === blocks[0], "CTX-08 a small result is untouched");

  /* ---------------------------------------------------------------- CTX-09 */
  const baseline = JSON.parse(readFileSync(join(ROOT, "docs", "next-memory", "TOOL_SCHEMA_BASELINE.json"), "utf8"));
  const projection = schemaProjection();
  check(projection.length === 4, "CTX-09 still exactly four tools");
  check(
    JSON.stringify(projection.map((t) => t.name)) === JSON.stringify(baseline.tools.map((t) => t.name)),
    "CTX-09 tool names are unchanged",
  );
  for (const [i, tool] of projection.entries()) {
    const want = baseline.tools[i];
    check(
      JSON.stringify(Object.keys(tool.parameters.properties)) === JSON.stringify(Object.keys(want.parameters.properties)),
      `CTX-09 ${tool.name} parameter set is unchanged`,
    );
  }
  check(
    estimatedSchemaTokens() <= baseline.estimatedTokens,
    `CTX-09 schema estimate ${estimatedSchemaTokens()} <= baseline ${baseline.estimatedTokens}`,
  );

  /* ---------------------------------------------------------------- CTX-10 */
  const oldDecision = insertNode(db, { type: "decision", text: "缓存层使用 Redis。" });
  const newDecision = insertNode(db, { type: "decision", text: "缓存层改用进程内 LRU。" });
  const s10 = "s-history-pin";
  setSessionPins(db, s10, [oldDecision]);
  const revisionOf = (id) => (Number(id) === oldDecision ? { currentId: newDecision } : { currentId: Number(id) });
  const historyPins = pinCandidates(db, s10, { resolveRevision: revisionOf });
  check(historyPins.length === 1 && historyPins[0].id === oldDecision, "CTX-10 a pinned historical node is not rewritten to its successor");
  check(
    historyPins[0].historical === true && historyPins[0].supersededBy === newDecision,
    "CTX-10 the pin is marked historical with a pointer to the current version",
  );

  const plan10 = selectContextRecords({
    pins: historyPins,
    recall: [cand(db, oldDecision)],
    budget: TURN_ADDITIONAL_BUDGET,
    resolveCurrent: revisionOf,
  });
  const pinRecord = plan10.records.find((r) => r.channel === "pin");
  check(pinRecord?.id === oldDecision && pinRecord.historical, "CTX-10 the explicit historical pin is kept as pinned");
  check(
    plan10.records.some((r) => r.id === newDecision && r.matchedHistory?.from === oldDecision),
    "CTX-10 automatic recall maps the old hit to the current head",
  );
  check(
    plan10.records.filter((r) => r.id === oldDecision).length === 1,
    "CTX-10 the historical node is still injected only once",
  );
  check(plan10.tokens <= 300, "CTX-10 the historical pin and the mapped candidate share 300");

  const deadChain = selectContextRecords({
    recall: [cand(db, oldDecision)],
    budget: 300,
    resolveCurrent: () => ({ id: newDecision, archived: true }),
  });
  check(deadChain.records.length === 0, "CTX-10 an archived successor does not resurrect the old node");

  console.log(`\nP16 context budget regressions passed (${checks} checks)`);
} catch (err) {
  console.error("FAIL " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
} finally {
  closeAll();
  rmSync(root, { recursive: true, force: true });
}
