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
import { createHash } from "node:crypto";
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
/*
 * Second audit (2026-11-05): an empty directory produced `groupFiles: 0` and then
 * `ok: true` — the script created a fresh library and called it an upgrade drill.
 * A drill has to refuse a source that is not a library.
 */
if (!groupFiles.includes("trivium.tdb")) {
  // No absolute paths in the output: this file is committed as evidence.
  console.error(JSON.stringify({ ok: false, error: "source is not a library: trivium.tdb is missing", groupFiles }, null, 2));
  process.exit(2);
}

/*
 * Which kernel must be loaded. Fourth audit round: the "beta.3 opened the restored
 * backup" evidence actually recorded `0.9.0`, because the file was written by a
 * later run. An evidence run now asserts the version it is supposed to prove.
 */
const expectArg = process.argv.find((arg) => arg.startsWith("--expect-kernel="));
const expectedKernel = expectArg ? expectArg.split("=")[1] : "";

const root = mkdtempSync(join(tmpdir(), "trivium-upgrade-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");

const store = await import("../lib/store.js");
const kernel = (await import("triviumdb/package.json", { with: { type: "json" } })).default.version;

const ws = join(root, "ws");
const live = join(ws, ".dsh", "trivium.tdb");
mkdirSync(join(ws, ".dsh"), { recursive: true });
for (const name of groupFiles) copyFileSync(join(source, name), join(ws, ".dsh", name));

const report = {
  kernel,
  expectedKernel: expectedKernel || null,
  kernelMatches: expectedKernel ? kernel === expectedKernel : null,
  // Only the directory name and the file count: absolute paths are machine data.
  sourceName: source.replace(/[\\/]+$/, "").split(/[\\/]/).pop(),
  groupFiles: groupFiles.length,
  steps: [],
  ok: true,
};
const step = (name, value) => {
  report.steps.push({ name, value });
  return value;
};

const hash = (value) =>
  createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 16);

/**
 * Full-content fingerprint.
 *
 * Fourth audit round: the old one compared `id|type|name|first 60 chars of text`,
 * so a truncated body, a lost `history` entry or a changed edge endpoint would all
 * have passed. This hashes the **whole payload** (every field, including history)
 * and the **edge endpoints and labels**, and reports only digests — the evidence
 * file must not carry workspace text or paths.
 */
const snapshot = (db) => {
  const graph = store.exportGraph(db);
  const nodes = (graph.nodes || [])
    .map((node) => ({ id: Number(node.id), payload: hash(node.payload || {}) }))
    .sort((a, b) => a.id - b.id);
  const edges = (graph.edges || [])
    .map((edge) => ({
      from: Number(edge.from ?? edge.src ?? edge.source ?? 0),
      to: Number(edge.to ?? edge.dst ?? edge.target ?? 0),
      label: String(edge.label || edge.type || ""),
    }))
    .sort((a, b) => (a.from - b.from) || (a.to - b.to) || a.label.localeCompare(b.label));
  return {
    nodes: nodes.length,
    edges: edges.length,
    nodeDigest: hash(nodes),
    edgeDigest: hash(edges),
  };
};

try {
  /*
   * Backup the **pre-upgrade** group first (second audit: the old script backed up
   * after 0.9.0 had already opened and written, which proves nothing about
   * restoring what the user had before the upgrade).
   */
  const original = join(root, "original");
  mkdirSync(original, { recursive: true });
  for (const name of groupFiles) copyFileSync(join(source, name), join(original, name));

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

    /*
     * 3) Restore the **pre-upgrade** backup and check the content, not the count.
     *
     * This is the path a user actually needs: "I upgraded, something went wrong, put
     * back what I had". Whether the *old kernel* can then read it is the remaining
     * gap — it is reported separately and is not claimed here.
     */
    store.closeAll();
    for (const name of readdirSync(join(ws, ".dsh"))) {
      if (name.startsWith("trivium.tdb")) rmSync(join(ws, ".dsh", name), { force: true });
    }
    for (const name of readdirSync(original)) copyFileSync(join(original, name), join(ws, ".dsh", name));
    const third = await store.openWorkspaceDb(ws);
    const restored = step("restore-original", snapshot(third));
    step("restore-matches-original-content", restored.nodeDigest === before.nodeDigest && restored.edgeDigest === before.edgeDigest);
    step("restored-after-upgrade-write", after.nodes === before.nodes + 1);
    store.closeAll();
  } else {
    store.closeAll();
  }
  /*
   * Fifth audit round: `kernelMatches` was recorded but never consulted, so a run
   * under the wrong kernel still reported `ok: true` and exit 0. A version check
   * that does not change the outcome is a comment, not a gate.
   */
  if (expectedKernel && !report.kernelMatches) {
    report.ok = false;
    report.error = `expected kernel ${expectedKernel}, loaded ${kernel}`;
  }
  report.ok = report.ok && report.steps.every((row) => row.value !== false);
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
