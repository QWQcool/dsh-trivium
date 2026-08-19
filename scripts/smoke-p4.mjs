/**
 * Kernel find: business-edge rank, stale `until` filtered unless the query
 * is about the deadline. Does not need DSH.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDGE_LABELS } from "../lib/schema.js";
import {
  closeAll,
  formatHit,
  insertNode,
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
  db.link(live, entity, EDGE_LABELS.decided, 1);
  db.link(stale, entity, EDGE_LABELS.decided, 1);
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
  assert(!!liveHit && /decided->/.test((liveHit.path || []).join("|")), "live decision path decided->");
  if (prefHit && liveHit) {
    const order = byGw.map((h) => h.id);
    assert(
      order.indexOf(live) < order.indexOf(pref),
      `business-edge decision ranks before in_workspace-only pref (order=${order})`,
    );
  }

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
