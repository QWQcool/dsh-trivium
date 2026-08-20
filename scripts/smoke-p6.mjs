/**
 * Markdown projection + one-shot WorkBuddy import. No DSH process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EDGE_LABELS } from "../lib/schema.js";
import { capWriteBatch, MAX_WRITE_CHARS } from "../lib/extract.js";
import {
  exportMarkdown,
  isOurMarkdownExport,
  parseWorkbuddyMarkdown,
  importWorkbuddy,
} from "../lib/markdown.js";
import { closeAll, insertNode, namedRecallHits, openWorkspaceDb } from "../lib/store.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p6-"));
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return;
  }
  failed += 1;
  console.error("FAIL " + msg);
}

const WORKBUDDY = `# Notes

- Use tabs not spaces
- ESLint: airbnb config, husky pre-commit hook
- Never guess at URLs
- AuthGateway: 鉴权走 header X
- 哈哈
- 把这个文件改一下就行
- api_key=sk-abcdefghijklmnopqrstuvwxyz
- Yesterday we talked about lunch and the weather for a long time without any rule.

## 2026-07-08
- This daily log section should be skipped entirely even if it says never do X
`;

try {
  const db = await openWorkspaceDb(cwd);
  const entity = insertNode(db, { type: "entity", name: "AuthGateway", text: "gateway" });
  const pref = insertNode(db, { type: "preference", text: "鉴权走 header X" });
  db.link(pref, entity, EDGE_LABELS.about, 1);

  const md = exportMarkdown(db, { cwd });
  assert(isOurMarkdownExport(md), "export carries dsh-trivium-export marker");
  assert(/- 鉴权走 header X —about→ AuthGateway/.test(md), "preference line includes about edge");
  assert(/## entity/.test(md) && /- AuthGateway/.test(md), "entity section lists AuthGateway");

  const refused = parseWorkbuddyMarkdown(md);
  assert(refused.ok === false && /JSON/.test(refused.message || ""), "refuse round-trip of our export");

  const parsed = parseWorkbuddyMarkdown(WORKBUDDY);
  assert(parsed.ok === true, "WorkBuddy parse ok");
  assert(
    parsed.candidates.some((c) => c.type === "preference" && /tabs/i.test(c.text)),
    "Use tabs not spaces → preference",
  );
  assert(
    parsed.candidates.some((c) => c.type === "entity" && c.name === "ESLint") &&
      parsed.candidates.some((c) => c.type === "preference" && /airbnb/.test(c.text) && c.linkName === "ESLint"),
    "ESLint: … → entity + preference about it",
  );
  assert(
    parsed.candidates.some((c) => c.type === "preference" && /header X/.test(c.text) && c.linkName === "AuthGateway"),
    "AuthGateway: 鉴权走 header X → about AuthGateway",
  );
  assert(
    !parsed.candidates.some((c) => /哈哈|改一下|sk-abcdefghijklmnopqrstuvwxyz|lunch|daily log/i.test(c.text || "")),
    "chitchat / oneshot / secret / narrative / dated section skipped",
  );
  assert(parsed.skipped > 0, "skipped count is non-zero");

  const memDir = join(cwd, ".workbuddy", "memory");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "MEMORY.md"), WORKBUDDY, "utf8");
  const imported = importWorkbuddy(db, { cwd, ids: ["workspace"] });
  assert(imported.ok === true && imported.created >= 2, "one-shot import creates nodes");
  assert(
    namedRecallHits(db, "AuthGateway").some((h) => /header X/.test(h.payload?.text || "")),
    "imported preference is 1-hop from AuthGateway",
  );
  const again = importWorkbuddy(db, { cwd, ids: ["workspace"] });
  assert(again.ok === true && again.created === 0, "second import merges, does not duplicate");

  const many = Array.from({ length: 40 }, (_, i) => ({
    type: "preference",
    text: `以后都不要用方案 ${i} 作为默认。`,
  }));
  const capped = capWriteBatch(many);
  assert(capped.kept.length < 40 && capped.dropped > 0, "write batch drops the tail");
  assert(capped.used <= MAX_WRITE_CHARS, "write batch stays within 3000 chars");
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
console.log("smoke-p6 ok");
