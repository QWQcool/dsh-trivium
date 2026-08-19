/**
 * P3: Settings list search (type + q + until/path) and quieter ctx_find
 * (substring primary hits + business-edge neighbors only).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distill } from "../lib/extract.js";
import { closeAll, formatHit, listNodes, openWorkspaceDb, searchNodes } from "../lib/store.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p3-"));
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
  const db = await openWorkspaceDb(cwd);
  await distill({
    db,
    sessionId: "p3",
    turns: [
      { role: "user", text: "记住，本仓库鉴权走 header X。TriviumDB 是内核。" },
      { role: "user", text: "日志相关键是 X-Request-Id。网关也回传 X-Request-Id。" },
      { role: "user", text: "AuthGateway 接登录。AuthGateway 不要暴露端口。" },
      { role: "user", text: "先别动 AuthGateway，下周再改。" },
      { role: "user", text: "采用方案 A 做登录。" },
      { role: "user", text: "以后都用 pnpm，不要用 npm。" },
    ],
  });

  const listed = listNodes(db);
  assert(
    listed.some((n) => n.type === "decision" && n.until === "下周"),
    "list includes until=下周",
  );
  assert(
    listed.some((n) => Array.isArray(n.path) && n.path.some((p) => /decided->/.test(p))),
    "list path shows decided->",
  );

  const qAuth = listNodes(db, { q: "鉴权" });
  assert(
    qAuth.some((n) => n.type === "preference" && /header X/.test(n.text)),
    "Settings q=鉴权 hits preference",
  );
  assert(
    !qAuth.some((n) => n.type === "preference" && /pnpm/.test(n.text)),
    "Settings q=鉴权 does not list pnpm pref",
  );

  const qUntil = listNodes(db, { q: "下周", type: "decision" });
  assert(qUntil.length === 1 && qUntil[0].until === "下周", "type=decision + q=下周");

  const e5 = searchNodes(db, "X-Request-Id", { topK: 8, expandDepth: 1 }).map((h) =>
    formatHit(db, h),
  );
  assert(
    e5.some((h) => h.type === "entity" && /X-Request-Id/.test(h.l0)),
    "find(X-Request-Id) still hits entity",
  );
  assert(
    !e5.some((h) => h.type === "preference"),
    `find(X-Request-Id) does not drag in header X pref (got ${e5.map((h) => h.type + ":" + h.l0).join("; ")})`,
  );

  const d2 = searchNodes(db, "方案 A", { topK: 8, expandDepth: 1 }).map((h) => formatHit(db, h));
  const decision = d2.find((h) => h.type === "decision" && /方案 A/.test(h.l0));
  assert(!!decision, "find(方案 A) hits decision");
  assert(
    /decided->/.test((decision?.path || []).join("|")),
    `方案 A decision links decided-> (got ${decision?.path?.join("|") || "none"})`,
  );

  const d1 = searchNodes(db, "下周", { topK: 8, expandDepth: 1 }).map((h) => formatHit(db, h));
  assert(
    d1.some((h) => h.type === "decision" && /下周/.test(h.l0)),
    "find(下周) hits decision",
  );
  assert(
    d1.some((h) => h.type === "entity" && /AuthGateway/.test(h.l0)),
    "find(下周) still expands decided neighbor AuthGateway",
  );

  closeAll();
} catch (err) {
  failed += 1;
  console.error("FAIL exception", err);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}

if (failed) {
  console.error(`P3 cases failed (${failed})`);
  process.exit(1);
}
console.log("P3 settings search / find ranking passed");
