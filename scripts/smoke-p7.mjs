/**
 * Episode nodes stay out of find / short map; pins clip to 300 tokens.
 * Uses a temp dir — does not open the workspace .tdb DSH may already hold.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSINESS_EDGES, EDGE_LABELS, NODE_TYPES } from "../lib/schema.js";
import { backfillSessionMap, cutSessionMap, recordCheckpoint, ensureTail, listEpisodeRecords, sessionMapSnapshot, syncForkLineage } from "../lib/episode.js";
import { buildPinInject, listChips, setSessionPins } from "../lib/pins.js";
import { SETTINGS_FILE } from "../lib/settings.js";
import {
  buildShortMapReport,
  closeAll,
  insertNode,
  listNodes,
  namedRecallHits,
  openWorkspaceDb,
  searchNodes,
} from "../lib/store.js";
import { estimateTokens } from "../lib/tokens.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p7-"));
let failed = 0;
const prevSettings = existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, "utf8") : null;

function assert(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return;
  }
  failed += 1;
  console.error("FAIL " + msg);
}

try {
  assert(NODE_TYPES.includes("episode"), "NODE_TYPES includes episode");
  assert(!BUSINESS_EDGES.includes("continues") && !BUSINESS_EDGES.includes("forks_from"), "plot edges stay out of BUSINESS_EDGES");
  assert(EDGE_LABELS.continues === "continues" && EDGE_LABELS.forksFrom === "forks_from", "continues / forks_from labels");

  const db = await openWorkspaceDb(cwd);
  const sessionId = "sess-p7";
  const summary = "本段：鉴权改为 header X，并修了登录超时。";
  const ep = recordCheckpoint(db, {
    sessionId,
    atSeq: 124,
    compactionId: "cmp-1",
    summary,
  });
  assert(Number.isFinite(ep), "checkpoint episode inserted");
  const again = recordCheckpoint(db, {
    sessionId,
    atSeq: 124,
    compactionId: "cmp-1",
    summary,
  });
  assert(again === ep, "same uri reuses the checkpoint node");

  const eps = listEpisodeRecords(db, sessionId);
  assert(eps.filter((e) => e.kind === "tail").length === 1, "at most one tail per session");
  assert(eps.some((e) => e.kind === "checkpoint" && e.atSeq === 124), "checkpoint kept");

  const hits = searchNodes(db, "鉴权改为 header X");
  assert(!hits.some((h) => h.payload?.type === "episode"), "searchNodes skips episode");
  const named = namedRecallHits(db, "鉴权改为 header X");
  assert(!named.some((h) => h.payload?.type === "episode"), "namedRecallHits skips episode");
  const map = buildShortMapReport(db, 400);
  assert(!/episode|鉴权改为 header X/.test(map.text), "short map skips episode");
  const listed = listNodes(db);
  assert(!listed.some((n) => n.type === "episode"), "listNodes default skips episode");
  const explicit = listNodes(db, { type: "episode" });
  assert(explicit.some((n) => n.type === "episode"), "listNodes type=episode returns episodes");

  const child = "sess-p7-child";
  syncForkLineage(db, { childSessionId: child, parentSessionId: sessionId, atSeq: 124 });
  const afterFork = listEpisodeRecords(db, sessionId).filter((e) => e.kind === "checkpoint" || e.kind === "fork");
  assert(afterFork.filter((e) => e.atSeq === 124).length === 1, "fork at checkpoint atSeq does not double-write");
  assert(!afterFork.some((e) => e.kind === "fork"), "fork at existing checkpoint does not insert a dummy fork box");

  const lonely = "sess-p7-lonely";
  const lonelyChild = "sess-p7-lonely-child";
  ensureTail(db, lonely, { atSeq: 0, summary: "" });
  const beforeLonely = listEpisodeRecords(db, lonely).length;
  syncForkLineage(db, { childSessionId: lonelyChild, parentSessionId: lonely, atSeq: 534 });
  const lonelyRows = listEpisodeRecords(db, lonely);
  assert(lonelyRows.length === beforeLonely, "fork from a single tail does not insert a cut box");
  assert(!lonelyRows.some((e) => e.kind === "fork"), "single-box fork has no dummy fork episode");
  const lonelySnap = sessionMapSnapshot(db, lonely);
  const tailId = lonelyRows.find((e) => e.kind === "tail")?.id;
  const childTail = listEpisodeRecords(db, lonelyChild).find((e) => e.kind === "tail");
  assert(
    lonelySnap.edges.some((e) => e.label === "forks_from" && e.from === childTail?.id && e.to === tailId),
    "single-box fork attaches to the existing tail",
  );
  const snap = sessionMapSnapshot(db, sessionId);
  assert(
    snap.edges.some((e) => e.label === "forks_from") && snap.edges.some((e) => e.label === "continues"),
    "map snapshot has continues and forks_from",
  );

  const oldSess = "sess-p7-legacy";
  const oldChild = "sess-p7-legacy-child";
  const filled = backfillSessionMap(db, {
    sessionId: oldSess,
    compactations: [
      { atSeq: 40, compactionId: "cmp-old", summary: "旧会话已经压过一次" },
      { atSeq: 40, summary: "duplicate seq ignored" },
    ],
    forks: [{ childSessionId: oldChild, parentSessionId: oldSess, atSeq: 40 }],
  });
  assert(filled.ok && filled.checkpoints === 1, "backfill writes one checkpoint per atSeq");
  assert(filled.forks === 1, "backfill projects the fork link");
  const againFill = backfillSessionMap(db, {
    sessionId: oldSess,
    compactations: [{ atSeq: 40, compactionId: "cmp-old", summary: "旧会话已经压过一次" }],
    forks: [{ childSessionId: oldChild, parentSessionId: oldSess, atSeq: 40 }],
  });
  const oldChecks = listEpisodeRecords(db, oldSess).filter((e) => e.kind === "checkpoint");
  assert(oldChecks.length === 1 && againFill.checkpoints === 1, "backfill is idempotent on the same atSeq");
  const oldChildTail = listEpisodeRecords(db, oldChild).find((e) => e.kind === "tail");
  assert(
    againFill.edges.some(
      (e) => e.label === "forks_from" && e.from === oldChildTail?.id && e.to === oldChecks[0].id,
    ),
    "backfill fork hangs off the reconstructed checkpoint",
  );

  const pref = insertNode(db, {
    type: "preference",
    text: "b".repeat(200),
    name: "long-pref",
  });
  const more = [];
  for (let i = 0; i < 8; i += 1) {
    more.push(insertNode(db, { type: "preference", text: ("pin-" + i + "-").padEnd(200, "x") }));
  }
  const entity = insertNode(db, { type: "entity", name: "AuthGateway", text: "gateway" });
  const exp = insertNode(db, { type: "experience", text: "once failed login", fail: "x", fix: "y" });
  const chips = listChips(db);
  assert(
    chips.some((c) => c.id === pref) && chips.some((c) => c.id === entity) && !chips.some((c) => c.id === exp),
    "chips are unarchived preference/decision/entity, not experience",
  );

  const pin = setSessionPins(db, sessionId, [pref, entity, ...more]);
  assert(pin.clipped === true, "pins clip when over 300 tokens");
  assert(estimateTokens(pin.text) <= 301, "clipped pin inject stays within ~300 tokens");
  assert(pin.text.includes("dsh-trivium pins"), "pin inject text is labeled");

  ensureTail(db, sessionId);
  assert(listEpisodeRecords(db, sessionId).filter((e) => e.kind === "tail").length === 1, "ensureTail still one tail");

  const cutSess = "sess-p7-cut";
  const cut1 = cutSessionMap(db, { sessionId: cutSess, atSeq: 40, summary: "先测三个数据集" });
  assert(cut1.ok && cut1.created, "manual cut creates a checkpoint");
  const cutChain = (cut1.nodes || []).filter((n) => n.sessionId === cutSess);
  assert(cutChain.some((n) => n.kind === "checkpoint" && n.atSeq === 40), "cut writes historical box");
  assert(cutChain.some((n) => n.kind === "tail"), "cut keeps a tail box");
  const cut2 = cutSessionMap(db, { sessionId: cutSess, atSeq: 40, summary: "重复切" });
  assert(cut2.ok && cut2.created === false, "same atSeq does not add another box");
  assert(
    listEpisodeRecords(db, cutSess).filter((e) => e.kind === "checkpoint").length === 1,
    "manual cut is idempotent on atSeq",
  );
  const cut3 = cutSessionMap(db, { sessionId: cutSess, atSeq: 80, summary: "再切一格" });
  assert(cut3.ok && cut3.created, "later atSeq extends the chain");
  assert(
    listEpisodeRecords(db, cutSess).filter((e) => e.kind === "checkpoint").length === 2,
    "second cut adds another historical box",
  );
} catch (err) {
  failed += 1;
  console.error("FAIL exception " + (err && err.stack ? err.stack : err));
} finally {
  closeAll();
  try {
    if (prevSettings == null) {
      try {
        rmSync(SETTINGS_FILE, { force: true });
      } catch {
        // ignore
      }
    } else {
      writeFileSync(SETTINGS_FILE, prevSettings, "utf8");
    }
  } catch {
    // ignore
  }
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("smoke-p7 ok");
