import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tdb from "triviumdb";

const root = realpathSync(mkdtempSync(join(tmpdir(), "trivium-db-dimensions-")));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const { TriviumDB } = tdb;
const { closeAll, openWorkspaceDb, openWorkspaceDbReadOnly } = await import("../lib/store.js");
const { attachDocumentEvidence, documentEvidenceStatus, evidenceDocuments,
  saveEvidenceDocument, searchEvidenceFragments } = await import("../lib/document-evidence.js");
const { configureEmbedding } = await import("../lib/embed.js");
const upgradeScript = fileURLToPath(new URL("./upgrade-kernel.mjs", import.meta.url));
const digest = (dir) => readdirSync(dir).filter(name => /^trivium\.tdb(?:\.|$)/.test(name) && name !== "trivium.tdb.lock")
  .sort().map(name => [name, createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")]);
const code = name => error => error.code === name;
const cli = (command, cwd) => {
  const result = spawnSync(process.execPath, [upgradeScript, command, cwd], {
    env: process.env, encoding: "utf8", windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return JSON.parse(result.stdout);
};
const seed = (dir, dim) => {
  mkdirSync(dir, { recursive: true });
  const db = new TriviumDB(join(dir, "trivium.tdb"), { dim, autoBuildQuiver: false });
  try {
    db.insertWithId(101, new Array(dim).fill(0), { type: "decision", name: "Retained", text: "Original evidence", status: "active" });
    db.flush();
  } finally { db.close(); }
};
try {
  const fixtures = [1024, 1536].map(dim => {
    const cwd = join(root, "existing-" + dim);
    const dir = join(cwd, ".dsh");
    seed(dir, dim);
    return { dim, cwd, dir, original: digest(dir) };
  });
  const missing = join(root, "missing");
  mkdirSync(missing);
  assert.throws(() => openWorkspaceDbReadOnly(missing));
  assert.deepEqual(readdirSync(missing), [], "read-only must never initialize a store");

  for (const { cwd, dir, dim, original } of fixtures) {
    if (dim === 1024) assert.throws(() => new TriviumDB(join(dir, "trivium.tdb"), {
      dim: 1536, accessMode: "readOnly", autoBuildQuiver: false,
    }), code("TDB_DIMENSION_MISMATCH"));
    const db = openWorkspaceDbReadOnly(cwd);
    try {
      assert.equal(db.dim(), dim);
      assert.equal(db.nodeCount(), 1);
    } finally { db.close(); }
    assert.deepEqual(cli("check", cwd).facts, { dimension: dim, nodes: 1 });
    assert.deepEqual(digest(dir), original, "both read-only entry points preserve every database file");
    await assert.rejects(openWorkspaceDb(cwd), code("WORKSPACE_UPGRADE_PREPARE_REQUIRED"));
    assert.deepEqual(digest(dir), original, "probe must not bypass the upgrade gate");
    const prepared = cli("prepare", cwd);
    assert.equal(prepared.phase, "active");
    assert.equal(prepared.facts.dimension, dim);
  }

  for (const { cwd, dim } of fixtures) {
    const db = await openWorkspaceDb(cwd);
    assert.equal(db.dim(), dim);
    const content = "# Deployment\nThis deployment kept the original evidence.\n";
    const { document } = saveEvidenceDocument(db, { sourceId: "reports/deployment.md", content });
    const documentId = Number(document.document_id);
    const { fragments } = searchEvidenceFragments(db, { documentId, revision: document.revision, query: "original evidence" });
    assert.ok(fragments.length);
    const { reference, text: quote } = fragments[0];
    attachDocumentEvidence(db, { factId: 101, documentId, revision: document.revision, reference, quote });
    assert.equal(documentEvidenceStatus(db).links.length, 1);
  }
  assert.equal((await openWorkspaceDb(join(root, "new-default"))).dim(), 1536);
  closeAll();
  configureEmbedding({ embeddingDimensions: 768 });
  assert.equal((await openWorkspaceDb(join(root, "new-configured"))).dim(), 768);
  for (const { cwd, dim } of fixtures) assert.equal((await openWorkspaceDb(cwd)).dim(), dim, "a creation setting never overrides an existing database");
  closeAll();

  for (const { cwd, dir, dim, original } of fixtures) {
    const db = openWorkspaceDbReadOnly(cwd);
    try {
      assert.equal(db.dim(), dim);
      assert.equal(evidenceDocuments(db).length, 1);
      assert.equal(documentEvidenceStatus(db).links.length, 1);
    } finally { db.close(); }
    assert.equal(cli("rollback", cwd).phase, "rolled-back");
    assert.deepEqual(digest(dir), original, "CLI restored original file group byte for byte");
    const restored = openWorkspaceDbReadOnly(cwd);
    try {
      assert.equal(restored.dim(), dim);
      assert.equal(restored.nodeCount(), 1);
    } finally { restored.close(); }
  }

  const corruptCwd = join(root, "corrupt"), corruptDir = join(corruptCwd, ".dsh");
  seed(corruptDir, 1024);
  const corruptFile = join(corruptDir, "trivium.tdb");
  writeFileSync(corruptFile, readFileSync(corruptFile).subarray(0, 8));
  const before = digest(corruptDir);
  assert.throws(() => openWorkspaceDbReadOnly(corruptCwd));
  await assert.rejects(openWorkspaceDb(corruptCwd));
  const bad = spawnSync(process.execPath, [upgradeScript, "check", corruptCwd], { env: process.env, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.deepEqual(digest(corruptDir), before, "corruption must not cause a repair, replacement or retry with writes");
  console.log("PASS P127: 1024/1536 existing read, prepare, evidence write/reopen, exact rollback, default/configured creation and corruption guards");
} finally {
  closeAll();
  rmSync(root, { recursive: true, force: true });
}
