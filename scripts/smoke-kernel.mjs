/** Exercise an actual 0.9.0 on-disk graph with the current native kernel. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const Old = require("triviumdb-090").TriviumDB;
const Current = require("triviumdb").TriviumDB;
const options = { dim: 2, syncMode: "off", autoBuildQuiver: false };

function snapshot(db) {
  return db.allNodeIds().sort((a, b) => a - b).map(id => {
    const node = db.get(id);
    return {
      id: node.id,
      payload: node.payload,
      vector: Array.from(node.vector),
      edges: node.edges.sort((a, b) => a.targetId - b.targetId || a.label.localeCompare(b.label)),
    };
  });
}

async function upgradeFrom090() {
  assert.equal(require("triviumdb-090/package.json").version, "0.9.0");
  assert.equal(require("triviumdb/package.json").version, "0.9.1");
  const root = mkdtempSync(join(tmpdir(), "dsh-kernel-upgrade-"));
  const path = join(root, "synthetic.tdb");
  let db;
  try {
    db = new Old(path, options);
    db.insertWithId(1, [0.6, 0.8], { type: "entity", name: "合成项目", aliases: ["demo", "演示"] });
    db.insertWithId(2, [1, 0], { type: "decision", text: "旧决策", history: [{ text: "原始内容", at: "2025-01-01" }] });
    db.insertWithId(3, [0, 1], { type: "decision", text: "新决策", metadata: { nested: [1, true, null] } });
    db.upsertEdge(2, 1, "about", 0.75, { source: "synthetic" });
    db.upsertEdge(3, 1, "about", 1, { source: "synthetic" });
    db.upsertEdge(3, 2, "supersedes", 1, { reason: "test" });
    db.flush();
    const oldSnapshot = snapshot(db);
    db.close(); db = null;

    db = new Current(path, options);
    assert.deepEqual(snapshot(db), oldSnapshot, "payloads, vectors, edges and metadata survive opening");
    db.insertWithId(4, [1, 0], { type: "experience", text: "upgrade write" });
    db.upsertEdge(4, 1, "about", 0.5, { source: "new kernel" });
    db.flush();
    const updatedSnapshot = snapshot(db);
    db.close(); db = null;

    db = new Current(path, options);
    assert.deepEqual(snapshot(db), updatedSnapshot, "new writes survive a reopen");
    assert.deepEqual(snapshot(db).filter(node => node.id !== 4), oldSnapshot, "old content remains intact after a write");
    assert.deepEqual(db.get(4).payload, { type: "experience", text: "upgrade write" });
    db.close(); db = null;
    assert.throws(() => {
      const downgraded = new Old(path, options);
      downgraded.close();
    }, error => error.code === "TDB_UNSUPPORTED_DATABASE_VERSION", "the old kernel cannot reopen the upgraded file");
    console.log("ok: 0.9.0 graph, vectors, payloads and relations survive 0.9.1 read, write and reopen; old kernel rejects the new format");
  } finally {
    if (db) db.close();
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("Refusing cleanup outside temp directory");
    rmSync(root, { recursive: true, force: true });
  }
}

export const cases = { p99: upgradeFrom090 };
