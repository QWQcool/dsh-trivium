#!/usr/bin/env node
/**
 * Read-only check for decision revision integrity.
 *
 *   node scripts/check-integrity.mjs <workspace> [--json]
 *   node scripts/check-integrity.mjs --snapshot <directory> [--json]
 *
 * Exit codes: 0 clean, 2 issues found, 1 cannot open.
 *
 * The database is opened with accessMode "readOnly": no WAL, no text index
 * rebuild, no workspace registration. If a host is holding the file, the open
 * is refused. An independently captured snapshot can instead be verified and
 * opened with accessMode "immutable" while the host keeps its writer open.
 */
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { checkRevisionIntegrity } from "../lib/integrity.js";
import { dbPathFor, openWorkspaceDbReadOnly } from "../lib/store.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: dsh-trivium-check [workspace] [--json]\n" +
    "       dsh-trivium-check --snapshot <directory> [--json]\n" +
    "Read-only revision-chain check. Exit codes: 0 clean, 2 issues found, 1 cannot open.");
  process.exit(0);
}

let asJson = false;
let snapshotDirectory;
let workspace;
try {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") asJson = true;
    else if (arg === "--snapshot") {
      if (snapshotDirectory !== undefined) throw new Error("--snapshot may be provided only once");
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("--snapshot requires a directory");
      snapshotDirectory = resolve(value);
    } else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else if (workspace !== undefined) throw new Error("provide only one workspace");
    else workspace = arg;
  }
  if (snapshotDirectory !== undefined && workspace !== undefined) {
    throw new Error("--snapshot cannot be combined with a workspace argument");
  }
} catch (err) {
  console.error(`invalid arguments: ${err.message}`);
  process.exit(1);
}

const cwd = snapshotDirectory === undefined ? resolve(workspace || process.cwd()) : undefined;
const file = snapshotDirectory === undefined ? dbPathFor(cwd) : join(snapshotDirectory, "database.tdb");
let db;
let generationId;
try {
  if (snapshotDirectory !== undefined) {
    // Do not follow an alias into a different directory tree. The native
    // verifier separately rejects symlink files and unexpected snapshot files.
    let current = snapshotDirectory;
    for (;;) {
      if (lstatSync(current).isSymbolicLink()) throw new Error("snapshot path must not contain symbolic links");
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (!lstatSync(snapshotDirectory).isDirectory()) throw new Error("snapshot must be a directory");
    const engine = await import("triviumdb");
    const { TriviumDB, verifySnapshot } = engine.default || engine;
    const manifest = verifySnapshot(snapshotDirectory);
    generationId = manifest.generation_id;
    db = new TriviumDB(file, {
      accessMode: "immutable",
      dim: manifest.dim,
      // The native manifest uses Rust's type name for half precision.
      dtype: manifest.dtype === "half::binary16::f16" ? "f16" : manifest.dtype,
    });
  } else {
    if (!existsSync(file)) throw new Error(`no memory database at ${file}`);
    db = openWorkspaceDbReadOnly(cwd);
  }
} catch (err) {
  console.error(snapshotDirectory === undefined
    ? `cannot open read-only (is another host using it?): ${err.message}`
    : `cannot open snapshot: ${err.message}`);
  process.exit(1);
}

try {
  const report = checkRevisionIntegrity(db);
  if (asJson) {
    const source = snapshotDirectory === undefined
      ? { cwd, file }
      : { source: "snapshot", snapshotDirectory, generationId, file };
    console.log(JSON.stringify({ ...source, ...report }, null, 2));
  } else {
    if (snapshotDirectory === undefined) console.log(`workspace: ${cwd}`);
    else {
      console.log(`snapshot: ${snapshotDirectory}`);
      console.log(`generation: ${generationId}`);
    }
    console.log(`database:  ${file}`);
    console.log(`nodes: ${report.nodes}  revision edges: ${report.edges}`);
    if (report.ok) {
      console.log("integrity: ok");
    } else {
      console.log(`integrity: ${report.issues.length} issue(s)`);
      for (const issue of report.issues) console.log(`- ${issue.code}: ${JSON.stringify(issue)}`);
    }
  }
  process.exitCode = report.ok ? 0 : 2;
} finally {
  try {
    db.close?.();
  } catch {
    // closing a read-only handle is best effort
  }
}
