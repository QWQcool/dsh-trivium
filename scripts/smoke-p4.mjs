/**
 * Kernel find: entity-name anchor → unexpired about/decided/broke/fixed
 * neighbors (payload need not repeat the name); business-edge rank; stale
 * `until` hidden unless the query is about the deadline. Does not need DSH.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDGE_LABELS } from "../lib/schema.js";
import {
  closeAll,
  dropLink,
  formatHit,
  hasEdge,
  insertNode,
  listIncomingBusiness,
  openWorkspaceDb,
  searchNodes,
} from "../lib/store.js";
import { isStalePayload, resolveUntilAt } from "../lib/until.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p4-"));
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return;
  }
  failed += 1;
  console.error("FAIL " + msg);
}

try {
  const friday = resolveUntilAt("Friday", new Date("2026-08-17T00:00:00Z"));
  assert(!!friday && Date.parse(friday) > Date.parse("2026-08-17T00:00:00Z"), "Friday untilAt is in the future from Monday");
  assert(
    isStalePayload({ untilAt: "2020-01-01T00:00:00.000Z" }, new Date("2026-08-20")),
    "past untilAt is stale",
  );
  assert(
    !isStalePayload({ until: "下周", createdAt: "2026-08-19T00:00:00.000Z" }, new Date("2026-08-20")),
    "下周 from yesterday is not stale yet",
  );

  const db = await openWorkspaceDb(cwd);
  const entity = insertNode(db, { type: "entity", name: "AuthGateway", text: "AuthGateway" });
  const live = insertNode(db, {
    type: "decision",
    name: "AuthGateway",
    text: "先别动 AuthGateway，下周再改。",
    until: "下周",
    untilAt: resolveUntilAt("下周", new Date("2026-08-19T00:00:00.000Z")),
  });
  const stale = insertNode(db, {
    type: "decision",
    name: "AuthGateway",
    text: "AuthGateway 上周就该冻结。",
    until: "周五",
    untilAt: "2020-01-03T23:59:59.000Z",
  });
  const pref = insertNode(db, {
    type: "preference",
    text: "AuthGateway 日志走 header X。",
  });
  const silentPref = insertNode(db, {
    type: "preference",
    text: "日志走 header X。",
  });
  const silentLive = insertNode(db, {
    type: "decision",
    text: "先别动，下周再改。",
    until: "下周",
    untilAt: resolveUntilAt("下周", new Date("2026-08-19T00:00:00.000Z")),
  });
  const pnpm = insertNode(db, {
    type: "preference",
    text: "以后都用 pnpm。",
  });
  db.link(live, entity, EDGE_LABELS.decided, 1);
  db.link(stale, entity, EDGE_LABELS.decided, 1);
  db.link(silentPref, entity, EDGE_LABELS.about, 1);
  db.link(silentLive, entity, EDGE_LABELS.decided, 1);
  db.flush();

  const now = new Date("2026-08-20T12:00:00.000Z");
  const byGw = searchNodes(db, "AuthGateway", { topK: 8, expandDepth: 1, now }).map((h) =>
    formatHit(db, h),
  );
  assert(
    byGw.some((h) => h.id === entity),
    "find(AuthGateway) hits entity",
  );
  assert(
    byGw.some((h) => h.id === live),
    "find(AuthGateway) keeps unexpired decided neighbor",
  );
  assert(
    !byGw.some((h) => h.id === stale),
    `find(AuthGateway) hides stale until decision (got ${byGw.map((h) => h.id + ":" + h.l0).join("; ")})`,
  );

  const byUntil = searchNodes(db, "周五", { topK: 8, expandDepth: 1, now }).map((h) => formatHit(db, h));
  assert(
    byUntil.some((h) => h.id === stale),
    "find(周五) still returns the stale decision because the query is the deadline",
  );

  const liveHit = byGw.find((h) => h.id === live);
  const prefHit = byGw.find((h) => h.id === pref);
  const entityHit = byGw.find((h) => h.id === entity);
  const entityPath = (entityHit?.path || []).join("|");
  assert(!!liveHit && /decided->/.test((liveHit.path || []).join("|")), "live decision path decided->");
  assert(
    /<-about-/.test(entityPath) && entityPath.includes(String(silentPref)),
    `entity path includes incoming about (got ${entityPath || "(none)"})`,
  );
  assert(
    /<-decided-/.test(entityPath) &&
      (entityPath.includes(String(live)) || entityPath.includes(String(silentLive))),
    `entity path includes incoming decided (got ${entityPath || "(none)"})`,
  );
  assert(
    !entityPath.includes(`<-decided-${stale}`),
    `entity path hides stale incoming unless query asks until (got ${entityPath || "(none)"})`,
  );

  const untilEntity = byUntil.find((h) => h.id === entity);
  assert(
    !!untilEntity && (untilEntity.path || []).some((p) => p.includes(`<-decided-${stale}`)),
    "find(周五) entity path still shows stale incoming",
  );
  if (prefHit && liveHit) {
    const order = byGw.map((h) => h.id);
    assert(
      order.indexOf(live) < order.indexOf(pref),
      `business-edge decision ranks before in_workspace-only pref (order=${order})`,
    );
    assert(
      order.indexOf(entity) < order.indexOf(pref),
      `incoming business edges rank entity above in_workspace-only pref (order=${order})`,
    );
  }

  assert(
    byGw.some((h) => h.id === silentPref),
    "find(AuthGateway) expands about-neighbor whose text omits the entity name",
  );
  assert(
    byGw.some((h) => h.id === silentLive),
    "find(AuthGateway) expands decided-neighbor whose text omits the entity name",
  );
  assert(
    !byGw.some((h) => h.id === pnpm),
    "find(AuthGateway) does not pull unlinked pnpm pref",
  );

  const byPhrase = searchNodes(db, "AuthGateway 的决策", { topK: 8, expandDepth: 1, now }).map(
    (h) => formatHit(db, h),
  );
  assert(
    byPhrase.some((h) => h.id === entity),
    "find(AuthGateway 的决策) still anchors the entity",
  );
  assert(
    byPhrase.some((h) => h.id === silentLive),
    "find(AuthGateway 的决策) returns unexpired decided neighbor",
  );
  assert(
    byPhrase.some((h) => h.id === silentPref),
    "find(AuthGateway 的决策) returns about preference neighbor",
  );
  assert(
    !byPhrase.some((h) => h.id === stale),
    `find(AuthGateway 的决策) hides stale until (got ${byPhrase.map((h) => h.id + ":" + h.l0).join("; ")})`,
  );
  assert(
    !byPhrase.some((h) => h.id === pnpm),
    "find(AuthGateway 的决策) does not pull unlinked pnpm pref",
  );

  const byPnpm = searchNodes(db, "pnpm", { topK: 8, expandDepth: 1, now }).map((h) =>
    formatHit(db, h),
  );
  assert(
    byPnpm.some((h) => h.id === pnpm),
    "find(pnpm) still hits the unlinked preference",
  );
  assert(
    !byPnpm.some((h) => h.id === silentPref || h.id === silentLive),
    "find(pnpm) does not expand AuthGateway neighbors",
  );

  const incoming = listIncomingBusiness(db, entity);
  assert(
    incoming.some((e) => e.from === silentPref && e.label === "about"),
    "listIncomingBusiness includes about",
  );
  assert(
    incoming.some((e) => e.from === live && e.label === "decided"),
    "listIncomingBusiness includes decided",
  );

  const exp = insertNode(db, {
    type: "experience",
    text: "mkdir 失败后改用 fs.mkdir。",
    fail: "bash mkdir",
    fix: "fs.mkdir",
  });
  db.link(exp, entity, EDGE_LABELS.fixed, 0.9);
  db.flush();
  const byExp = searchNodes(db, "AuthGateway", { topK: 8, expandDepth: 1, now }).map((h) =>
    formatHit(db, h),
  );
  assert(
    byExp.some((h) => h.id === exp),
    "find(AuthGateway) expands fixed experience neighbor",
  );
  const expEntityPath = (byExp.find((h) => h.id === entity)?.path || []).join("|");
  assert(
    /<-fixed-/.test(expEntityPath) && expEntityPath.includes(String(exp)),
    `entity path includes incoming fixed (got ${expEntityPath || "(none)"})`,
  );

  const staleIso = insertNode(db, {
    type: "decision",
    name: "AuthGateway",
    text: "AuthGateway freeze until 2020-01-03.",
    until: "2020-01-03",
    untilAt: "2020-01-03T23:59:59.000Z",
  });
  db.link(staleIso, entity, EDGE_LABELS.decided, 1);
  db.flush();
  const byFridayIso = searchNodes(db, "周五", { topK: 8, expandDepth: 1, now }).map((h) =>
    formatHit(db, h, { query: "周五", now }),
  );
  assert(
    byFridayIso.some((h) => h.id === staleIso),
    "find(周五) includes ISO-until stale decision",
  );
  const fridayEntity = byFridayIso.find((h) => h.id === entity);
  assert(
    !!fridayEntity && (fridayEntity.path || []).some((p) => p.includes(`<-decided-${staleIso}`)),
    "find(周五) entity path shows ISO stale incoming",
  );
  const oldDec = insertNode(db, { type: "decision", text: "旧方案：用 cookie 会话。" });
  const newDec = insertNode(db, { type: "decision", text: "现方案：用 header 会话。" });
  db.link(oldDec, newDec, EDGE_LABELS.sameAs, 0.5);
  db.flush();
  const bySame = searchNodes(db, "用 cookie", { topK: 8, expandDepth: 1, now });
  assert(
    bySame.some((h) => h.id === oldDec),
    "find(用 cookie) still hits the old node",
  );
  assert(
    bySame.some((h) => h.id === newDec),
    "find follows same_as to the canonical node",
  );
  assert(hasEdge(db, silentPref, entity, EDGE_LABELS.about), "about edge exists before labeled unlink");
  assert(
    (db.get(silentPref)?.edges || []).some((e) => e.label === EDGE_LABELS.inWorkspace),
    "in_workspace exists before labeled unlink",
  );
  assert(dropLink(db, silentPref, entity, EDGE_LABELS.about), "labeled unlink drops about only");
  assert(!hasEdge(db, silentPref, entity, EDGE_LABELS.about), "about edge gone after labeled unlink");
  assert(
    (db.get(silentPref)?.edges || []).some((e) => e.label === EDGE_LABELS.inWorkspace),
    "labeled unlink keeps in_workspace",
  );

  closeAll();
} catch (err) {
  failed += 1;
  console.error("FAIL exception", err);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

if (failed) {
  console.error(`P4 kernel find cases failed (${failed})`);
  process.exit(1);
}
console.log("P4 find edge-type / until ranking passed");
