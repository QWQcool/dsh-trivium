/**
 * UI contract for the management panel, checked at the source level.
 *
 * There is no DOM in this suite, so these are structural assertions: the panel
 * must expose the five surfaces the plan requires, both locales must carry every
 * key the panel reads (a missing key renders as the raw key in the host UI), and
 * the prototype's demo toolbar must not have leaked into the shipped bundle.
 *
 * Interaction details that need a browser (focus restore, Escape, 409 banner)
 * are exercised by the real panel instead; see docs/next-memory/RESULT.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "lib", "client.js"), "utf8");

let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
  console.log("ok  " + message);
}

try {
  /* ---------------------------------------------------------------- locales */
  const zhStart = src.indexOf("zh: {");
  const enStart = src.indexOf("en: {", zhStart);
  const dictEnd = src.indexOf("\n    };", enStart);
  check(zhStart > 0 && enStart > zhStart && dictEnd > enStart, "the bundle keeps two locale blocks");

  const keysOf = (from, to) => {
    const body = src.slice(from, to);
    const keys = new Set();
    for (const m of body.matchAll(/\n {8}([A-Za-z][A-Za-z0-9_]*):/g)) keys.add(m[1]);
    return keys;
  };
  const zh = keysOf(zhStart, enStart);
  const en = keysOf(enStart, dictEnd);
  check(zh.size > 100, `the zh dictionary is parsed (${zh.size} keys)`);
  const missingEn = [...zh].filter((key) => !en.has(key));
  const missingZh = [...en].filter((key) => !zh.has(key));
  check(missingEn.length === 0, `every zh key exists in en (missing: ${missingEn.join(", ") || "none"})`);
  check(missingZh.length === 0, `every en key exists in zh (missing: ${missingZh.join(", ") || "none"})`);

  /* ------------------------------------------------------------------ keys */
  const used = new Set();
  for (const m of src.matchAll(/\bt\("([A-Za-z][A-Za-z0-9_]*)"/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bL\.([A-Za-z][A-Za-z0-9_]*)/g)) used.add(m[1]);
  const badKeys = [...used].filter((key) => !zh.has(key) && !en.has(key) && key !== "nav");
  check(badKeys.length === 0, `no surface reads an undefined key (bad: ${badKeys.join(", ") || "none"})`);

  /* --------------------------------------------------------------- surfaces */
  check(/tabList/.test(src) && /tabRecall/.test(src), "the panel splits into memory entries and recall check");
  check(/nodeTabContent/.test(src) && /nodeTabSource/.test(src) && /nodeTabHistory/.test(src),
    "a node detail splits into content, source and decision history");
  const endpoints = [
    "/detail",
    "/provenance",
    "/history",
    "/recall-traces",
    "/recall-preview",
  ];
  for (const endpoint of endpoints) {
    check(src.includes(endpoint), `the panel uses ${endpoint}`);
  }

  /* -------------------------------------------------- on-demand, not ambient */
  check(
    /if \(next === "source" && !sourceInfo\[id\]\) loadNodeInfo\(id, "source"\);/.test(src),
    "the source pane is fetched only when the source tab is opened",
  );
  check(
    /if \(next === "history" && !historyInfo\[id\]\) loadNodeInfo\(id, "history"\);/.test(src),
    "the history pane is fetched only when the history tab is opened",
  );
  check(
    /if \(!open && !detail\[n\.id\]\) loadNodeInfo\(n\.id, "detail"\);/.test(src),
    "detail is fetched on expand, not on list load",
  );
  check(
    /if \(tab === "recall"\) loadTraces\(\);/.test(src),
    "traces are fetched only while the recall tab is open",
  );

  /* ------------------------------------------------------------ accessibility */
  check(/role: "tab"/.test(src) && /aria-selected/.test(src), "tabs expose role and selection state");
  check(/"aria-valuenow": pct/.test(src), "the budget bar exposes its value");
  check(/type: "button"/.test(src), "tab buttons are real buttons, keyboard reachable");

  /* --------------------------------------------------------------- states */
  const states = [
    ["sourceMissing", "a missing source has its own message"],
    ["sourceUnavailable", "a dead session has its own message"],
    ["historyNone", "an empty history has its own message"],
    ["recallNoTrace", "no diagnostics has its own message"],
    ["recallEmptyText", "an empty turn has its own message"],
    ["recallDeferred", "deferred content is surfaced for the next turn"],
    ["detailFailed", "a failed read has its own message"],
  ];
  for (const [key, message] of states) {
    check(new RegExp(`\\bL\\.${key}\\b`).test(src), message);
  }

  /* -------------------------------------------------------- prototype hygiene */
  check(!/演示场景|设计标注|DEMO_|demoScene/.test(src), "no prototype demo toolbar leaked into the bundle");
  check(!/FRONTEND\.html/.test(src), "the shipped bundle does not reference the prototype file");
  check(
    /estimate/.test(src) && /recallBudgetHint/.test(src),
    "every budget number is labelled as an estimate",
  );

  /* ------------------------------------------------- revision confirm dialog */
  check(/role: "dialog"/.test(src) && /"aria-modal": "true"/.test(src), "the confirm dialog is a modal dialog");
  check(/if \(event\.key === "Escape"\) closeSupersede\(\);/.test(src), "Escape closes the dialog");
  check(
    /if \(previous && typeof previous\.focus === "function"\) previous\.focus\(\);/.test(src),
    "focus returns to the trigger when the dialog closes",
  );
  check(
    /disabled: revisionBusy \|\| !dialog\.successorId/.test(src),
    "the confirm button is disabled while saving and without a target",
  );
  check(
    /const conflict = result\.status === 409;/.test(src) && /L\.supersedeConflict/.test(src),
    "a 409 is shown as a conflict, not a generic failure",
  );
  check(
    /setRevisionDialog\(\(prev\) => \(prev \? \{ \.\.\.prev, successorId: event\.target\.value, error: "", conflict: false \} : prev\)\)/.test(src),
    "a conflict keeps the user's selection",
  );
  check(/operationId: dialog\.operationId/.test(src), "a retry reuses the same operationId");
  check(/L\.supersedeOld/.test(src) && /L\.supersedeNew/.test(src), "the dialog shows both existing decisions");
  check(/L\.showSuperseded/.test(src) && /L\.showStale/.test(src), "replaced and expired have separate switches");
  check(/params\.set\("superseded", "1"\)/.test(src), "the replaced switch is a distinct request parameter");
  check(/L\.revoke/.test(src) && /revokeSupersession\(n\.replacesId, n\.id\)/.test(src), "a current version can undo its replacement");
  check(/\bL\.noSuccessor\b/.test(src), "no candidate decision has its own message");

  console.log(`\nP18 client UI contract passed (${checks} checks)`);
} catch (err) {
  console.error("FAIL " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
}
