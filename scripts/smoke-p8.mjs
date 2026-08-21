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
  addChipsFromText,
  applyPinsUpdate,
  batchChipAction,
  CHIP_TYPES,
  copyPins,
  listChips,
  livePinIds,
  setSessionPins,
  splitChipDraft,
  stripMarkdownMarkup,
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

  assert(
    stripMarkdownMarkup("鉴权走 **header X**") === "鉴权走 header X",
    "markdown emphasis is stripped, words kept",
  );
  assert(
    splitChipDraft("- 鉴权走 header X\n- 用 pnpm").length === 1,
    "list paste is still one chip",
  );
  assert(
    splitChipDraft("第一段。\n\n第二段很长的说明也不会拆开。").length === 1,
    "multi-paragraph paste is one chip",
  );
  assert(splitChipDraft("本仓库鉴权走 **header X**。").length === 1, "one paragraph is one chip");

  const made = addChipsFromText(db, "本仓库鉴权走 **header X**。", { sessionId: otherChild, pin: true });
  assert(made.ok && made.ids.length === 1, "plain/md paragraph inserts a chip");
  assert(livePinIds(db, otherChild).includes(made.ids[0]), "new chip is pinned on this session");
  const listed = listChips(db, { sessionId: otherChild });
  assert(
    listed.some((c) => c.id === made.ids[0] && /header X/.test(c.text || c.l0)),
    "inserted chip text keeps words after stripping md",
  );

  const listedMd = addChipsFromText(db, "- 以后都用 pnpm\n- 先别动 AuthGateway，下周再改", {
    sessionId: otherChild,
    pin: true,
  });
  assert(listedMd.ok && listedMd.ids.length === 1, "md list paste still inserts one chip");

  const longPaste = addChipsFromText(db, "记住：" + "鉴权走 header X。".repeat(40), { sessionId: otherChild });
  assert(longPaste.ok && longPaste.ids.length === 1, "long paste writes one chip not many");
  assert(
    (db.get(longPaste.ids[0])?.payload?.text || "").length > 240,
    "explicit chip keeps more than extract's 240-char line cap",
  );
  const secret = addChipsFromText(db, "记住 api_key=sk-abcdefghijklmnopqrstuvwxyz", { sessionId: otherChild });
  assert(secret.ok && secret.ids.length === 1, "explicit chip add does not refuse secret-looking text");
  assert(
    /sk-abcdefghijklmnopqrstuvwxyz/.test(db.get(secret.ids[0])?.payload?.text || ""),
    "secret-looking chip text is stored as typed",
  );

  const arch = batchChipAction(db, { action: "archive", ids: [made.ids[0]], sessionId: otherChild });
  assert(arch.count === 1, "batch archive one chip");
  assert(!listChips(db).some((c) => c.id === made.ids[0]), "archived chip leaves the chip list");
  assert(!livePinIds(db, otherChild).includes(made.ids[0]), "archive prunes pins");

  const goneId = listedMd.ids[0];
  const killed = batchChipAction(db, { action: "delete", ids: [goneId], sessionId: otherChild });
  assert(killed.count === 1, "batch delete one chip");
  assert(!db.get(goneId), "deleted node is gone from tdb");
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
