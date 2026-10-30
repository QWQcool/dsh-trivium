/** Actual host event -> extraction -> audit -> pending consumption, no model. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p59-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const cwd = join(root, "workspace");
const store = await import("../lib/store.js");
const { loadPending } = await import("../lib/extract.js");
const { readChanges } = await import("../lib/change-log.js");
const plugin = await import("../lib/index.js");
const handlers = new Map();
const warnings = [];
const ctx = {
  logger: () => ({ warn: (msg) => warnings.push(String(msg)), info() {}, error() {}, debug() {} }),
  inject(_deps, fn) { fn(ctx); },
  on(event, fn) { handlers.set(event, fn); return () => {}; },
  effect(fn) { fn(); return () => {}; },
  tools: { register: () => () => {} },
};

try {
  plugin.apply(ctx, {});
  const onEvent = handlers.get("session/event");
  assert.equal(typeof onEvent, "function");
  const session = { id: "p59", header: { cwd } };
  onEvent(session, { type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "记住，以后发布前必须先人工确认。" }], turn: 1 } });
  onEvent(session, { type: "compaction/end", seq: 2, data: {} });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !warnings.some((w) => w.includes("extract skipped"))) {
    if (readChanges(cwd).entries.some((row) => row.reason === "written") && !loadPending(cwd)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(!warnings.some((w) => w.includes("extract skipped")), `extraction must finish: ${warnings.join("; ")}`);
  const rows = readChanges(cwd).entries;
  assert.ok(rows.some((row) => row.reason === "written" && row.preview.includes("人工确认")), "a committed fact has a visible audit row");
  assert.equal(loadPending(cwd), null, "successful extraction consumes the pending window");
  const db = await store.openWorkspaceDb(cwd);
  assert.ok(store.searchNodes(db, "人工确认").length > 0, "the audited fact is persisted and searchable");
  console.log("P59: event extraction, audit and pending consumption passed");
} finally {
  store.closeAll();
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
}
