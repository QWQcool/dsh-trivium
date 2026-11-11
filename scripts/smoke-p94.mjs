/** Issue #5: independent generations and killable read-only snapshot queries. */
import assert from "node:assert/strict";
import engine from "triviumdb";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadSnapshot, getReadSnapshot, queryReadSnapshot, querySnapshotDirectory } from "../lib/read-snapshots.js";

const { TriviumDB } = engine;
const root = mkdtempSync(join(tmpdir(), "dsh-p94-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const cwd = join(root, "workspace");
mkdirSync(join(cwd, ".dsh"), { recursive: true });
const file = join(cwd, ".dsh", "trivium.tdb");
let db;
let checks = 0;
function check(value, label) {
  assert.ok(value, label);
  checks += 1;
  console.log("ok " + label);
}
async function rejects(fn, code, label) {
  await assert.rejects(fn, (err) => code instanceof RegExp ? code.test(err.code || "") : err.code === code);
  checks += 1;
  console.log("ok " + label);
}
const query = { tql: 'FIND {type: "entity"} RETURN *', timeoutMs: 5000 };
try {
  db = new TriviumDB(file, { dim: 2, autoBuildQuiver: false });
  for (const name of ["Alpha", "Beta", "Gamma"]) db.insert([1, 0], { type: "entity", name });
  const snapshot = createReadSnapshot(db, cwd);
  check(snapshot.nodeCount === 3 && snapshot.snapshotId === snapshot.generationId, "capture reports a verified independent generation");
  check(getReadSnapshot(cwd).snapshotId === snapshot.snapshotId, "latest resolves the successfully published capture");
  check(existsSync(join(snapshot.directory, "database.tdb")), "snapshot contains its own database file group");

  db.insert([0, 1], { type: "entity", name: "Delta" });
  db.flush();
  const result = await queryReadSnapshot(cwd, "latest", query);
  check(result.source === "snapshot" && result.rows.length === 3 && result.generationId === snapshot.generationId,
    "a separate query process reads the old snapshot while the writer continues");
  check(db.nodeCount() === 4, "snapshot queries do not change source facts");
  const clipped = await queryReadSnapshot(cwd, snapshot.snapshotId, { ...query, limit: 1 });
  check(clipped.rows.length === 1 && clipped.truncated === true && clipped.limit === 1, "result rows are explicitly truncated to the requested limit");
  const parameterized = await querySnapshotDirectory(snapshot.directory, {
    tql: 'FIND {type: "entity"} RETURN $bonus + 1 AS score', params: { bonus: 11 }, timeoutMs: 5000,
  });
  check(parameterized.rows.length === 3 && parameterized.rows.every((row) => row.score === 12), "native Console binds query parameters");
  await rejects(() => queryReadSnapshot(cwd, "latest", { ...query, tql: 'CREATE (n {name: "not allowed"})' }),
    /TDB_(QUERY_PARSE|READ_ONLY)/, "write TQL is rejected by the read-only query path");
  await rejects(() => queryReadSnapshot(cwd, "latest", { ...query, timeoutMs: 1 }), "QUERY_TIMEOUT", "wall-clock deadline terminates a query worker");
  await rejects(() => queryReadSnapshot(cwd, "latest", { ...query, params: null }), "QUERY_INVALID", "non-object parameters are rejected before worker admission");
  await rejects(() => queryReadSnapshot(cwd, "latest", { ...query, limit: 1001 }), "QUERY_INVALID", "oversized result limits are rejected");
  await rejects(() => queryReadSnapshot(cwd, "latest", { ...query, readOnly: false }), "QUERY_INVALID", "callers cannot pass extra native policy fields");
  const admitted = await Promise.allSettled([
    queryReadSnapshot(cwd, "latest", query), queryReadSnapshot(cwd, "latest", query), queryReadSnapshot(cwd, "latest", query),
  ]);
  check(admitted[0].status === "fulfilled" && admitted[1].status === "fulfilled"
    && admitted[2].status === "rejected" && admitted[2].reason.code === "QUERY_BUSY", "worker admission refuses a third concurrent query");
  check(db.nodeCount() === 4, "a rejected mutation leaves the source untouched");
  assert.throws(() => getReadSnapshot(cwd, "../../outside"), { code: "SNAPSHOT_ID_INVALID" });
  checks += 1; console.log("ok traversal IDs are rejected");
  assert.throws(() => getReadSnapshot(cwd, `snapshot-${randomUUID()}`), { code: "SNAPSHOT_NOT_FOUND" });
  checks += 1; console.log("ok unknown generation IDs are rejected");

  const pointer = join(cwd, ".dsh", "read-snapshots", "latest.json");
  const before = readFileSync(pointer, "utf8");
  const brokenWriter = { createSnapshot(target) { mkdirSync(target); writeFileSync(join(target, "database.tdb"), "invalid"); } };
  assert.throws(() => createReadSnapshot(brokenWriter, cwd));
  check(readFileSync(pointer, "utf8") === before, "failed capture verification preserves the last valid pointer");

  const symlinkWorkspace = join(root, "linked-workspace");
  mkdirSync(join(symlinkWorkspace, ".dsh"), { recursive: true });
  symlinkSync(join(cwd, ".dsh", "read-snapshots"), join(symlinkWorkspace, ".dsh", "read-snapshots"), "junction");
  assert.throws(() => getReadSnapshot(symlinkWorkspace), { code: "SNAPSHOT_PATH_INVALID" });
  checks += 1; console.log("ok snapshot-root symlinks cannot cross workspace boundaries");
  await rejects(() => querySnapshotDirectory(join(symlinkWorkspace, ".dsh", "read-snapshots", snapshot.snapshotId), query),
    "SNAPSHOT_PATH_INVALID", "CLI directory queries reject symlink ancestors");

  const cli = fileURLToPath(new URL("./query-snapshot.mjs", import.meta.url));
  const cliResult = spawnSync(process.execPath, [cli, "--snapshot", snapshot.directory, "--tql", query.tql, "--limit", "1", "--timeout-ms", "5000"], { encoding: "utf8", timeout: 10000 });
  check(cliResult.status === 0 && JSON.parse(cliResult.stdout).truncated === true, "packaged CLI reads an independent snapshot in another process");
  db.insert([0, 1], { type: "large", text: "x".repeat(600000) });
  const large = createReadSnapshot(db, cwd);
  await rejects(() => querySnapshotDirectory(large.directory, { tql: 'FIND {type: "large"} RETURN *', timeoutMs: 5000 }),
    "TDB_CONSOLE_RESPONSE_TOO_LARGE", "native response-byte budget rejects an oversized row");
  db.close();
  db = null;
  const offline = await querySnapshotDirectory(snapshot.directory, query);
  check(offline.rows.length === 3, "snapshot remains queryable after source shutdown");
  writeFileSync(join(large.directory, "database.tdb.manifest.json"), "invalid manifest");
  await rejects(() => queryReadSnapshot(cwd, "latest", query), "TDB_IMMUTABLE_ARTIFACT", "corrupt snapshot manifests are rejected by the isolated reader");
  const help = spawnSync(process.execPath, [cli, "--help"], { cwd: root, encoding: "utf8", timeout: 5000 });
  check(help.status === 0 && help.stdout.includes("--snapshot"), "CLI help does not require opening any database");
} finally {
  db?.close();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
}
console.log(`P94: ${checks}/${checks}`);
