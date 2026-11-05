/**
 * F5 — open a library that was written by the previous kernel, and prove it
 * survives the upgrade drill.
 *
 * The external audit (2026-11-05) blocked the release on exactly this: `triviumdb`
 * 0.9.0 is applied to libraries that already exist on disk, and nothing in the
 * evidence showed a historical file being opened, written, reopened and restored.
 *
 *   node scripts/verify-kernel-upgrade.mjs <path-to-trivium.tdb> [--probe]
 *
 * `--probe` only reads (used for the downgrade attempt: an older kernel opening a
 * file written by 0.9.0).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * The library is a **file group** (`trivium.tdb` + .gidx/.pidx/.pld/.text/.vec/.wal),
 * not one file. Copying only the `.tdb` produced `TDB_CORRUPTED_FILE: checkpoint
 * vector file is missing` on the first attempt — which is itself the finding: a
 * single-file backup is a broken backup, and the restore drill has to copy the group.
 */
const source = process.argv[2];
const probeOnly = process.argv.includes("--probe");
if (!source || !existsSync(source)) {
  console.error("usage: node scripts/verify-kernel-upgrade.mjs <dir-with-trivium.tdb*> [--probe]");
  process.exit(2);
}
const groupFiles = readdirSync(source).filter((name) => name.startsWith("trivium.tdb"));

const root = mkdtempSync(join(tmpdir(), "trivium-upgrade-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");

const store = await import("../lib/store.js");
const kernel = (await import("triviumdb/package.json", { with: { type: "json" } })).default.version;

const ws = join(root, "ws");
const live = join(ws, ".dsh", "trivium.tdb");
mkdirSync(join(ws, ".dsh"), { recursive: true });
for (const name of groupFiles) copyFileSync(join(source, name), join(ws, ".dsh", name));

const report = { kernel, source, groupFiles: groupFiles.length, steps: [], ok: true };
const step = (name, value) => {
  report.steps.push({ name, value });
  return value;
};

const snapshot = (db) => {
  const graph = store.exportGraph(db);
  return { nodes: graph.nodes.length, edges: graph.edges.length };
};

try {
  // 1) Open the historical file as-is.
  const first = await store.openWorkspaceDb(ws);
  const before = step("open-historic", snapshot(first));
  step("file-bytes", statSync(live).size);
  const sample = step(
    "read-sample",
    store.findByType(first, "preference").slice(0, 3).map((row) => ({ id: row.id, text: String(row.payload?.text || "").slice(0, 40) })),
  );

  if (!probeOnly) {
    // 2) Write, then reopen: the new kernel must be able to keep the file usable.
    const id = step("write", store.insertNode(first, { type: "preference", name: "f5-upgrade", text: "记住：升级演练写入的一条事实。" }));
    store.closeAll();
    const second = await store.openWorkspaceDb(ws);
    const after = step("reopen", snapshot(second));
    step("written-node-readable", Boolean(second.get(Number(id))));
    step("kept-historic-nodes", after.nodes >= before.nodes + 1);

    // 3) Backup / restore drill: copy the **whole group**, never one file.
    const backup = join(root, "backup");
    mkdirSync(backup, { recursive: true });
    for (const name of readdirSync(join(ws, ".dsh"))) {
      if (name.startsWith("trivium.tdb")) copyFileSync(join(ws, ".dsh", name), join(backup, name));
    }
    store.insertNode(second, { type: "preference", name: "f5-after-backup", text: "记住：备份之后写入的一条事实。" });
    store.closeAll();
    for (const name of readdirSync(join(ws, ".dsh"))) {
      if (name.startsWith("trivium.tdb") && !existsSync(join(backup, name))) rmSync(join(ws, ".dsh", name), { force: true });
    }
    for (const name of readdirSync(backup)) copyFileSync(join(backup, name), join(ws, ".dsh", name));
    const third = await store.openWorkspaceDb(ws);
    const restored = step("restore", snapshot(third));
    step("restore-dropped-the-later-write", restored.nodes === after.nodes);
    store.closeAll();
  } else {
    store.closeAll();
  }
  report.ok = report.steps.every((row) => row.value !== false);
  void sample;
} catch (err) {
  report.ok = false;
  report.error = String(err?.message || err).slice(0, 300);
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
