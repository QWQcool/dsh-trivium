#!/usr/bin/env node
/**
 * Read-only check for decision revision integrity.
 *
 *   node scripts/check-integrity.mjs <workspace> [--json]
 *
 * Exit codes: 0 clean, 2 issues found, 1 cannot open.
 *
 * The database is opened with accessMode "readOnly": no WAL, no text index
 * rebuild, no workspace registration. If a host is holding the file, the open
 * is refused — close the host or run this on a copy, never let a checker modify
 * the file it is judging.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { checkRevisionIntegrity } from "../lib/integrity.js";
import { dbPathFor, openWorkspaceDbReadOnly } from "../lib/store.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: dsh-trivium-check [workspace] [--json]\n" +
    "Read-only revision-chain check. Exit codes: 0 clean, 2 issues found, 1 cannot open.");
  process.exit(0);
}
const asJson = args.includes("--json");
const cwd = resolve(args.find((arg) => !arg.startsWith("--")) || process.cwd());
const file = dbPathFor(cwd);

if (!existsSync(file)) {
  console.error(`no memory database at ${file}`);
  process.exit(1);
}

let db;
try {
  db = openWorkspaceDbReadOnly(cwd);
} catch (err) {
  console.error(`cannot open read-only (is another host using it?): ${err.message}`);
  process.exit(1);
}

try {
  const report = checkRevisionIntegrity(db);
  if (asJson) {
    console.log(JSON.stringify({ cwd, file, ...report }, null, 2));
  } else {
    console.log(`workspace: ${cwd}`);
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
