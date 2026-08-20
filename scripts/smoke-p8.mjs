/**
 * Second knife: chip q filter, suggested neighbors (not auto-pinned), inherit copy.
 * Uses a temp dir — does not open a .tdb DSH may already hold.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDGE_LABELS } from "../lib/schema.js";
import { recordCheckpoint, syncForkLineage } from "../lib/episode.js";
import {
  applyPinsUpdate,
  CHIP_TYPES,
  copyPins,
  listChips,
  livePinIds,
  setSessionPins,
} from "../lib/pins.js";
import { SETTINGS_FILE } from "../lib/settings.js";
import { closeAll, ensureLink, insertNode, openWorkspaceDb } from "../lib/store.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p8-"));
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
  assert(CHIP_TYPES.join(",") === "preference,decision,entity", "CHIP_TYPES stay preference/decision/entity");

  const db = await openWorkspaceDb(cwd);
  const sessionId = "sess-p8";
  const childId = "sess-p8-child";
  const otherChild = "sess-p8-empty";

  const entity = insertNode(db, { type: "entity", name: "AuthGateway", text: "gateway" });
  const aboutPref = insertNode(db, { type: "preference", name: "header-x", text: "鉴权走 header X" });
  const decided = insertNode(db, { type: "decision", text: "timeout 改为 30s" });
  const unrelated = insertNode(db, { type: "preference", name: "unrelated-pref-zzz", text: "unrelated-pref-zzz noise" });
  const exp = insertNode(db, { type: "experience", text: "once failed login", fail: "x", fix: "y" });
  ensureLink(db, aboutPref, entity, EDGE_LABELS.about);
  ensureLink(db, decided, entity, EDGE_LABELS.decided);

  recordCheckpoint(db, {
    sessionId,
    atSeq: 40,
    compactionId: "cmp-p8",
    summary: "本段：鉴权改为 header X，并修了登录超时。AuthGateway 仍是入口。",
  });

  const chips = listChips(db, { sessionId });
  const byId = new Map(chips.map((c) => [c.id, c]));
  assert(byId.get(aboutPref)?.suggested === true, "about-neighbor of named entity is suggested");
  assert(byId.get(decided)?.suggested === true, "decided-neighbor of named entity is suggested");
  assert(byId.get(entity)?.suggested !== true, "named entity itself is not a neighbor suggestion");
  assert(byId.get(unrelated)?.suggested !== true, "unrelated chip is not suggested");
  assert(!chips.some((c) => c.id === exp), "experience stays out of chips");
  assert(
    livePinIds(db, sessionId).length === 0,
    "suggested flags do not write pins",
  );

  const qHeader = listChips(db, { q: "header", sessionId });
  assert(
    qHeader.some((c) => c.id === aboutPref) && !qHeader.some((c) => c.id === unrelated),
    "GET-style q= filters chips by text/name",
  );
  const qType = listChips(db, { q: "decision" });
  assert(
    qType.some((c) => c.id === decided) && !qType.some((c) => c.id === aboutPref),
    "q= also matches chip type",
  );

  const pin = setSessionPins(db, sessionId, [aboutPref]);
  assert(pin.ids.includes(aboutPref) && !pin.ids.includes(unrelated), "parent pins are explicit ids only");

  const copied = copyPins(db, sessionId, childId);
  assert(copied.length === 1 && copied[0] === aboutPref, "copyPins copies live parent pin ids");
  assert(livePinIds(db, childId).join(",") === String(aboutPref), "child has copied pins after copyPins");

  const empty = applyPinsUpdate(db, { sessionId: otherChild, ids: [] });
  assert(empty.ids.length === 0, "child without inherit stays empty");

  const replaced = applyPinsUpdate(db, { sessionId: childId, ids: [unrelated] });
  assert(
    replaced.ids.length === 1 && replaced.ids[0] === unrelated,
    "POST {sessionId, ids} without inherit still replaces",
  );

  const inherited = applyPinsUpdate(db, {
    sessionId: childId,
    inherit: true,
    inheritFrom: sessionId,
  });
  assert(
    inherited.ids.includes(aboutPref) && inherited.ids.length === 1,
    "inherit:true copies from inheritFrom",
  );

  const merged = applyPinsUpdate(db, {
    sessionId: childId,
    inherit: true,
    inheritFrom: sessionId,
    ids: [entity],
  });
  assert(
    merged.ids.includes(aboutPref) && merged.ids.includes(entity),
    "inherit:true then merges optional ids",
  );

  const graphChild = "sess-p8-graph";
  syncForkLineage(db, { childSessionId: graphChild, parentSessionId: sessionId, atSeq: 40 });
  const viaParent = applyPinsUpdate(db, { sessionId: graphChild, inherit: true });
  assert(
    viaParent.ids.includes(aboutPref),
    "inherit:true without inheritFrom uses graph parent",
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
console.log("smoke-p8 ok");
