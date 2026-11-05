/**
 * F7 — the write contract of the 0.9.0 adaptation.
 *
 * The audit asked for one durable assertion instead of a pile of new tests: the same
 * nested payload, sent through every write entry the adapter touches, must survive
 * `flush` + reopen unchanged — and an unsupported value must **fail** rather than be
 * silently dropped.
 *
 *   node scripts/verify-write-contract.mjs
 *
 * Prints JSON; exit 1 on any failed assertion. Zero model calls.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "trivium-contract-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");

const store = await import("../lib/store.js");

const results = [];
const check = (name, fn) => {
  try {
    const value = fn();
    results.push({ name, ok: true, value: value === undefined ? null : value });
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message || err).slice(0, 200) });
  }
};

/** A payload as callers actually build it: optional fields spread out of nothing. */
const nested = (extra = {}) => ({
  type: "preference",
  name: "合同夹具",
  text: "记住：写入契约。",
  aliases: [undefined, "别名"], // undefined inside an array must keep its position
  source: { sessionId: "s-contract", kind: undefined },
  history: [{ text: "旧正文", at: "2026-01-01T00:00:00.000Z" }],
  note: undefined,
  ...extra,
});

const snapshot = (value) => JSON.stringify(value);

let db = null;
try {
  const ws = join(root, "ws");
  db = await store.openWorkspaceDb(ws);

  // 1) The common path: insertNode goes through `engine.insert`.
  const payload = nested();
  const before = snapshot(payload);
  const id = store.insertNode(db, payload);
  check("insert accepts a payload with optional fields", () => {
    assert.ok(Number.isFinite(id) && id > 0, `id=${id}`);
    assert.equal(snapshot(payload), before, "the caller's object was mutated");
    return { id };
  });

  // 2) updatePayload / 3) commitTransaction / 4) insertWithId / 5) updateEdge.
  check("updatePayload accepts the same shape", () => {
    db.updatePayload(Number(id), nested({ text: "记住：更新后的契约。" }));
    return null;
  });
  check("commitTransaction accepts ops with the same shape", () => {
    db.commitTransaction([
      { type: "insertWithId", id: Number(id) + 1, vector: new Array(1536).fill(0), payload: nested({ name: "事务夹具" }) },
    ]);
    return null;
  });
  check("updateEdge tolerates undefined metadata", () => {
    const other = store.insertNode(db, { type: "entity", name: "边夹具", text: "边夹具" });
    db.link(Number(id), Number(other), "related", 1);
    db.updateEdge(Number(id), Number(other), "related", 1, { note: undefined, weight: 1 });
    return null;
  });

  // 5) Reopen: what was written is what the next process reads.
  store.closeAll();
  db = await store.openWorkspaceDb(ws);
  check("a reopened library returns the payload", () => {
    const node = db.get(Number(id));
    assert.ok(node, "node missing after reopen");
    const text = String(node.payload?.text || "");
    assert.ok(text.startsWith("记住："), `text=${text.slice(0, 40)}`);
    assert.deepEqual(node.payload?.aliases, [null, "别名"], "array positions were not kept");
    assert.ok(!("note" in (node.payload || {})), "an undefined field was written");
    return null;
  });

  // 6) An unsupported value must fail loudly and leave the library alone.
  const countBefore = store.findByType(db, "preference").length;
  check("a function in a payload is rejected, not dropped", () => {
    const fn = () => 1;
    let caught = null;
    try {
      store.insertNode(db, { type: "preference", name: "坏值", text: "记住：坏值。", callback: fn });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "the write succeeded with a function in the payload");
    assert.equal(caught.code, "STORAGE_UNSUPPORTED_VALUE");
    assert.equal(store.findByType(db, "preference").length, countBefore, "a rejected write changed the library");
    return { code: caught.code };
  });
} catch (err) {
  results.push({ name: "harness", ok: false, error: String(err?.message || err).slice(0, 300) });
} finally {
  try {
    store.closeAll();
  } catch {
    /* best effort */
  }
  rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((row) => !row.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed: failed.length, results }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
