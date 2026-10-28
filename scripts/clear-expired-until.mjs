#!/usr/bin/env node
/**
 * List or clear stale decision deadlines.
 *
 *   node scripts/clear-expired-until.mjs <workspace> [--json]
 *   node scripts/clear-expired-until.mjs <workspace> --apply [--all]
 *
 * Default is a read-only listing. `--apply` clears deadlines only on decisions
 * that are already stale, and by default only when the deadline text is also
 * present in the body — that is the shape 0.4.21 produced when it parsed dates
 * out of prose. Pass `--all` to clear every stale decision deadline, including
 * ones the user typed explicitly; that is a deliberate, destructive choice.
 *
 * The workspace must not be open in another process (the kernel is single
 * writer). Back up `.dsh/trivium.tdb` if you are not sure.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  closeAll,
  dbPathFor,
  describeDbFailure,
  openWorkspaceDb,
  openWorkspaceDbReadOnly,
  updateNode,
} from "../lib/store.js";
import { isStalePayload } from "../lib/until.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: dsh-trivium-clear-until [workspace] [--json] [--apply [--all]]\n" +
    "Default: read-only listing. --apply clears stale deadlines also found in the body; --all includes explicit deadlines.");
  process.exit(0);
}
const asJson = args.includes("--json");
const apply = args.includes("--apply");
const all = args.includes("--all");
const cwd = resolve(args.find((arg) => !arg.startsWith("--")) || process.cwd());
const file = dbPathFor(cwd);

function compact(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

/** 0.4.21 turned a date in the prose into `until`; that date is still in the body. */
function textMentionsUntil(text, until) {
  const raw = String(until || "").trim();
  if (!raw) return false;
  const hay = compact(text);
  const variants = [raw, raw.replace(/-/g, "."), raw.replace(/-/g, "/")];
  return variants.some((value) => hay.includes(compact(value)));
}

function fail(message, code = 1) {
  if (asJson) console.log(JSON.stringify({ ok: false, message }, null, 2));
  else console.error(message);
  process.exit(code);
}

if (!existsSync(file)) {
  fail(`No database at ${file}. Pass the workspace directory that contains .dsh/trivium.tdb.`);
}

let db;
try {
  // Even opening the normal store can import JSONL and rebuild indexes. A dry
  // run must inspect the existing file through the read-only kernel handle.
  db = apply ? await openWorkspaceDb(cwd) : openWorkspaceDbReadOnly(cwd);
} catch (err) {
  const lock = describeDbFailure(err);
  fail(lock ? lock.message : `Cannot open ${file}: ${err.message || err}`);
}

const rows = [];
for (const id of db.allNodeIds?.() || []) {
  const payload = db.get(id)?.payload || {};
  if (payload.type !== "decision") continue;
  if (!String(payload.until || "").trim()) continue;
  if (!isStalePayload(payload)) continue;
  rows.push({
    id: Number(id),
    name: String(payload.name || ""),
    until: String(payload.until || ""),
    untilAt: String(payload.untilAt || ""),
    textMentionsUntil: textMentionsUntil(payload.text, payload.until),
  });
}

const selected = apply ? (all ? rows : rows.filter((row) => row.textMentionsUntil)) : [];
const cleared = [];
for (const row of selected) {
  try {
    updateNode(db, row.id, { until: "" });
    cleared.push(row.id);
  } catch (err) {
    fail(`#${row.id} could not be cleared: ${err.message || err}`);
  }
}
if (cleared.length) db.flush();

const report = {
  ok: true,
  cwd,
  file,
  applied: apply,
  all,
  staleDecisions: rows.length,
  textMentionsUntil: rows.filter((row) => row.textMentionsUntil).length,
  cleared,
  rows,
};
if (apply) closeAll();
else db.close();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${rows.length} stale decision(s) with a deadline in ${file}`);
  for (const row of rows) {
    const mark = row.textMentionsUntil ? "date in body" : "explicit deadline";
    console.log(`  #${row.id}  ${row.name || "(no name)"}  until=${row.until}  (${mark})`);
  }
  if (!apply) {
    console.log("\nDry run. Re-run with --apply to clear dates that also appear in the body, or --apply --all for every stale deadline.");
  } else {
    console.log(`\nCleared ${cleared.length} deadline(s).`);
  }
}
