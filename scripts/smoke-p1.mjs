/**
 * P1: rule extract, merge, secret reject, pending replay, archive hides from find,
 * short-map token budget. No DSH process required.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCandidates,
  clearPending,
  distill,
  filterCandidates,
  loadPending,
  parseModelJson,
  ruleCandidates,
  savePending,
} from "../lib/extract.js";
import { EDGE_LABELS } from "../lib/schema.js";
import {
  archiveNode,
  buildShortMapReport,
  closeAll,
  insertNode,
  openWorkspaceDb,
  searchNodes,
} from "../lib/store.js";
import { estimateTokens } from "../lib/tokens.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p1-"));
let failed = false;

function assert(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return;
  }
  failed = true;
  console.error("FAIL " + msg);
}

try {
  const pref = ruleCandidates([
    { role: "user", text: "记住，本仓库鉴权走 header X", turn: 1 },
  ]);
  assert(
    pref.some((c) => c.type === "preference" && /鉴权/.test(c.text)),
    "记住… → preference",
  );

  const wrapped = ruleCandidates([
    {
      role: "user",
      text: "不要调用任何工具。用户说：记住以后都用 pnpm。只回复收到。",
      turn: 1,
    },
  ]);
  const wrappedPref = wrapped.find((c) => c.type === "preference");
  assert(!!wrappedPref && /pnpm/.test(wrappedPref.text), "wrapped 记住 still extracts");
  assert(wrappedPref && !/不要调用/.test(wrappedPref.text), "preference keeps the cue sentence only");

  const multi = ruleCandidates([
    {
      role: "user",
      text: "记住，本仓库鉴权走 header X。以后都用 pnpm。把这个文件改了就行。记住 api_key=sk-abc123token。",
      turn: 1,
    },
  ]);
  assert(
    multi.filter((c) => c.type === "preference" && /header X/.test(c.text)).length === 1,
    "multi-cue turn keeps header X preference",
  );
  assert(
    multi.some((c) => c.type === "preference" && /pnpm/.test(c.text)),
    "multi-cue turn keeps pnpm preference",
  );
  assert(
    !multi.some((c) => c.type === "preference" && /把这个文件/.test(c.text)),
    "multi-cue turn still drops oneshot",
  );
  assert(
    !multi.some((c) => /sk-abc123/.test(c.text || "")),
    "multi-cue turn still drops secret span",
  );

  const packed = ruleCandidates([
    {
      role: "user",
      text: [
        "记住，本仓库鉴权走 header X。",
        "以后都用 pnpm。",
        "先别动 AuthGateway，下周再改。",
        "采用方案 A 做登录。",
        "就用这个 TriviumDB 单文件，不要另起服务。",
        "postpone the migration until Friday.",
      ].join("\n"),
      turn: 1,
    },
  ]);
  assert(
    packed.filter((c) => c.type === "decision").length >= 4,
    `packed turn keeps four decisions (got ${packed.filter((c) => c.type === "decision").map((c) => c.text).join(" | ")})`,
  );
  assert(
    packed.filter((c) => c.type === "preference").length >= 2,
    "packed turn keeps two preferences",
  );

  const oneshot = filterCandidates(
    ruleCandidates([{ role: "user", text: "把这个文件改了就行", turn: 1 }]),
  );
  assert(
    !oneshot.some((c) => c.type === "preference"),
    "one-off file edit is not a preference",
  );

  const chat = filterCandidates(ruleCandidates([{ role: "user", text: "哈哈", turn: 1 }]));
  assert(!chat.some((c) => c.type === "preference"), "chitchat is not a preference");

  const secret = filterCandidates([
    { type: "preference", text: "记住 api_key=sk-abc123token", via: "rule" },
  ]);
  assert(secret.length === 0, "secret candidate rejected");

  const entities = ruleCandidates([
    { role: "user", text: "TriviumDB is the kernel. We keep TriviumDB in-process.", turn: 1 },
    { role: "assistant", text: "TriviumDB opened trivium.tdb", turn: 1 },
  ]);
  assert(
    entities.some((c) => c.type === "entity" && /TriviumDB/i.test(c.name || c.text)),
    "repeated proper name → entity",
  );

  const decision = ruleCandidates([
    { role: "user", text: "先别动 AuthGateway，下周再改", turn: 1 },
  ]);
  assert(
    decision.some((c) => c.type === "decision"),
    "decision with an object",
  );

  const exp = ruleCandidates([
    { role: "tool", name: "bash", ok: false, text: "ENOENT", turn: 2 },
    { role: "tool", name: "bash", ok: true, text: "ok after mkdir", turn: 2 },
  ]);
  assert(
    exp.some((c) => c.type === "experience"),
    "tool fail then success → experience",
  );

  const parsed = parseModelJson('```json\n{"candidates":[{"type":"entity","name":"Foo","text":"Foo"}]}\n```');
  assert(parsed.length === 1 && parsed[0].name === "Foo", "model JSON fence parsed");

  const db = await openWorkspaceDb(cwd);
  const first = applyCandidates(db, [
    { type: "preference", text: "记住，本仓库鉴权走 header X", quote: "记住" },
  ]);
  const second = applyCandidates(db, [
    { type: "preference", text: "记住，本仓库鉴权走 header X", quote: "记住" },
  ]);
  assert(first[0]?.action === "insert", "first preference inserted");
  assert(second[0]?.action === "merge" && second[0].id === first[0].id, "duplicate preference merged");

  const entityId = insertNode(db, { type: "entity", name: "dsh-trivium", text: "this repository" });
  db.link(first[0].id, entityId, EDGE_LABELS.about, 1);
  db.flush();

  savePending(cwd, { sessionId: "s1", turns: [{ role: "user", text: "记住以后都用 pnpm" }] });
  const pending = loadPending(cwd);
  assert(pending?.turns?.[0]?.text.includes("pnpm"), "pending saved");
  const replay = await distill({ db, turns: pending.turns, sessionId: "s1" });
  assert(replay.applied.some((a) => a.type === "preference"), "pending replay extracted");
  clearPending(cwd);
  assert(!loadPending(cwd), "pending cleared after success");

  const map = buildShortMapReport(db, 400);
  assert(map.tokens <= 400, `short map tokens ${map.tokens} <= 400`);
  assert(estimateTokens(map.text) === map.tokens, "token estimate matches report");

  const before = searchNodes(db, "鉴权", { topK: 8, expandDepth: 1 });
  assert(before.length > 0, "find hits before archive");
  archiveNode(db, first[0].id);
  const after = searchNodes(db, "鉴权", { topK: 8, expandDepth: 1 });
  assert(
    !after.some((h) => h.id === first[0].id || h.payload?.status === "archived"),
    "archived node hidden from find",
  );

  closeAll();
} catch (err) {
  failed = true;
  console.error("FAIL exception", err);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("P1 extract/merge/archive/token passed");
