/**
 * Hygiene gate + Claude Code / Codex strict import. No DSH process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasStutter,
  payloadLooksDirty,
  sanitizeForWrite,
} from "../lib/hygiene.js";
import { addChipsFromText, listChips } from "../lib/pins.js";
import {
  discoverExternalFiles,
  importExternal,
  parseWorkbuddyMarkdown,
} from "../lib/markdown.js";
import {
  buildShortMapReport,
  closeAll,
  insertNode,
  listNodes,
  openWorkspaceDb,
  searchNodes,
} from "../lib/store.js";
import { cmpSemver } from "../lib/update.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p10-"));
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return;
  }
  failed += 1;
  console.error("FAIL " + msg);
}

try {
  assert(sanitizeForWrite("Always use pnpm not npm.").ok === true, "clean fact passes write gate");
  assert(sanitizeForWrite("api_key=sk-abcdefghijklmnopqrstuvwxyz").ok === false, "secret refused");
  assert(sanitizeForWrite("Run. Run. Run. Run. Run.").reason === "stutter", "stutter refused");
  assert(hasStutter("风。风。风。风。风。") === true, "CJK stutter detected");
  assert(
    sanitizeForWrite('{"uid":"abc","role":"user","updatedAt":"x"}').reason === "raw-json",
    "JSON envelope refused",
  );
  assert(
    sanitizeForWrite("a\na\na\na").reason === "duplicate-lines",
    "duplicate lines refused",
  );

  const db = await openWorkspaceDb(cwd);
  insertNode(db, {
    type: "preference",
    name: "dirty-stutter",
    text: "Run. Run. Run. Run. more",
    uri: "ctx://pref/dirty",
  });
  insertNode(db, {
    type: "preference",
    name: "clean-pref",
    text: "以后都用 pnpm，不要用 npm。",
    uri: "ctx://pref/clean",
  });

  const dirty = listNodes(db).find((n) => n.name === "dirty-stutter");
  const clean = listNodes(db).find((n) => n.name === "clean-pref");
  assert(dirty && dirty.dirty === true, "settings list still shows dirty node");
  assert(clean && !clean.dirty, "clean node is not marked dirty");
  assert(payloadLooksDirty({ text: dirty.text }) === true, "payloadLooksDirty true on stutter");

  const hits = searchNodes(db, "pnpm");
  assert(
    hits.some((h) => /pnpm/.test(h.payload?.text || "")) &&
      !hits.some((h) => h.payload?.name === "dirty-stutter"),
    "find skips dirty, keeps clean",
  );
  const map = buildShortMapReport(db, 400);
  assert(!/dirty-stutter/.test(map.text) && /clean-pref/.test(map.text), "short map skips dirty");
  const chips = listChips(db, { sessionId: "s1" });
  assert(
    chips.some((c) => c.name === "clean-pref") && !chips.some((c) => c.name === "dirty-stutter"),
    "chips skip dirty",
  );

  const refused = addChipsFromText(db, "Run. Run. Run. Run.", { sessionId: "s1" });
  assert(refused.ok === false && /stutter|Refused/i.test(refused.message || ""), "chip add refuses stutter");

  const claude = `# Project

Always use pnpm not npm.

- Never commit secrets
- 哈哈
- api_key=sk-abcdefghijklmnopqrstuvwxyz
`;
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, "CLAUDE.md"), claude, "utf8");
  writeFileSync(join(cwd, "AGENTS.md"), "- Prefer bun for scripts\n- Must use TypeScript\n", "utf8");

  const found = discoverExternalFiles(cwd);
  assert(
    found.some((f) => f.id === "claude-workspace" && f.exists) &&
      found.some((f) => f.id === "codex-workspace" && f.exists),
    "discovers workspace CLAUDE.md and AGENTS.md",
  );

  const parsed = parseWorkbuddyMarkdown(claude);
  assert(parsed.ok === true, "CLAUDE.md parses");
  assert(
    parsed.candidates.some((c) => /pnpm/.test(c.text || "")),
    "paragraph with always/use…not becomes a preference",
  );
  assert(
    !parsed.candidates.some((c) => /哈哈|sk-abcdefghijklmnopqrstuvwxyz/.test(c.text || "")),
    "chitchat and secret skipped from CLAUDE.md",
  );

  const imported = importExternal(db, { cwd, ids: ["claude-workspace", "codex-workspace"] });
  assert(imported.ok === true && imported.created >= 1, "strict import creates nodes");
  assert(
    searchNodes(db, "TypeScript").some((h) => /TypeScript/.test(h.payload?.text || "")),
    "Codex AGENTS.md preference is findable",
  );

  assert(cmpSemver("0.4.8", "0.4.7") > 0, "0.4.8 > 0.4.7");
  assert(cmpSemver("0.4.7", "0.4.7") === 0, "equal versions");
  assert(cmpSemver("0.4.6", "0.4.7") < 0, "0.4.6 < 0.4.7");
} catch (err) {
  failed += 1;
  console.error("FAIL exception " + (err && err.stack ? err.stack : err));
} finally {
  closeAll();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("smoke-p10 ok");
