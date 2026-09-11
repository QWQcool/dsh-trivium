/**
 * P0 store-level A/B: session A remember+link, close, session B find with edge path.
 * Does not boot DSH; proves the .tdb survives a reopen (the DSH-session analogue).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAll, formatHit, insertNode, openWorkspaceDb, searchNodes } from "../lib/store.js";
import { DIM, EDGE_LABELS } from "../lib/schema.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p0-"));
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
  const dbA = await openWorkspaceDb(cwd);
  const entityId = insertNode(dbA, {
    type: "entity",
    name: "dsh-trivium",
    text: "this repository",
    uri: "ctx://entity/repo",
  });
  const prefId = insertNode(dbA, {
    type: "preference",
    name: "auth-header",
    text: "本仓库鉴权走 header X",
    uri: "ctx://pref/auth",
  });
  dbA.link(prefId, entityId, EDGE_LABELS.about, 1);
  dbA.flush();
  console.log("session A wrote entity=%s preference=%s", entityId, prefId);
  closeAll();

  const dbB = await openWorkspaceDb(cwd);
  const hits = searchNodes(dbB, "鉴权", { topK: 8, expandDepth: 1 });
  assert(hits.length > 0, "session B ctx_find(鉴权) returned hits");
  const formatted = hits.map((h) => formatHit(dbB, h));
  console.log(formatted.map((r) => `[${r.score.toFixed(3)}] id=${r.id} type=${r.type}\n${r.l0}\npath: ${r.path.join(" | ")}`).join("\n\n"));
  const prefHit = formatted.find((r) => r.id === prefId || r.l0.includes("鉴权") || r.l0.includes("header X"));
  assert(!!prefHit, "preference node is among hits");
  const pathText = (prefHit?.path || []).join(" | ");
  assert(
    pathText.includes(String(entityId)) || pathText.includes("dsh-trivium"),
    `path mentions entity (got: ${pathText || "(none)"})`,
  );

  // Text-index invariant. triviumdb 0.8.8 opens with `loadTextIndex: false`, so
  // the persisted BM25 sidecar is NOT loaded; only rebuildTextIndex() inside
  // openWorkspaceDb() keeps hybrid text recall alive after a reopen. searchNodes
  // above cannot catch a regression (its keyword fallback still scores), so ask
  // the engine channel directly. Delete that rebuild and this fails.
  const textChannel = dbB.searchHybrid(new Array(DIM).fill(0), "鉴权", 8, 1, 0.01, 0.2);
  assert(
    textChannel.length > 0,
    `hybrid text channel survives reopen (got ${textChannel.length} hits)`,
  );
  const entityChannel = dbB.searchHybrid(new Array(DIM).fill(0), "dsh-trivium", 8, 1, 0.01, 0.2);
  assert(
    entityChannel.length > 0,
    `hybrid text channel indexes the entity name too (got ${entityChannel.length} hits)`,
  );

  closeAll();
} catch (err) {
  failed = true;
  console.error("FAIL exception", err);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("P0 store A/B passed");
