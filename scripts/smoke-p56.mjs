/** Real loopback HTTP coverage for the workspace-scoped change log API. */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const root = mkdtempSync(join(tmpdir(), "trivium-p56-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const { registerMemoryApi } = await import("../lib/server.js");
const { rememberWorkspace } = await import("../lib/settings.js");
const { changesPath, noteChanges, rowsForExtract } = await import("../lib/change-log.js");

let handler;
const ctx = { webServer: { register(entry) { handler = entry.handler; return () => {}; } } };
registerMemoryApi(ctx, { liveOptions: () => ({}), status: {} });
const server = http.createServer((req, res) => handler(req, res));
let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
  console.log(`ok ${message}`);
}
const query = (cwd, limit) => `/api/dsh-trivium/changes?cwd=${encodeURIComponent(cwd)}${limit === undefined ? "" : `&limit=${limit}`}`;

try {
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = join(root, "workspace-a"), b = join(root, "workspace-b"), broken = join(root, "workspace-broken"), corrupt = join(root, "workspace-corrupt");
  for (const cwd of [a, b, broken, corrupt]) { mkdirSync(cwd, { recursive: true }); rememberWorkspace(cwd); }

  check(noteChanges(a, Array.from({ length: 203 }, (_, i) => ({ reason: "written", opId: `a-${i}`, preview: `fact ${i}` }))).ok, "first batch is written");
  check(noteChanges(a, Array.from({ length: 4 }, (_, i) => ({ reason: "written", opId: `next-${i}`, preview: `next ${i}` }))).ok, "second batch triggers another trim");
  check(noteChanges(b, [{ reason: "written", opId: "b-only", preview: "other workspace" }]).ok, "second workspace has its own log");
  const response = await fetch(base + query(a, 2));
  const body = await response.json();
  check(response.status === 200 && response.headers.get("cache-control") === "no-store", "HTTP response succeeds and is not cached");
  check(body.ok && body.entries.length === 2 && body.limit === 2, "requested response limit is applied");
  check(body.entries[0].opId === "next-3" && body.entries[1].opId === "next-2", "newest rows are first");
  check(body.total === 200 && body.trimmed === 7, "multiple trims preserve the cumulative dropped count");
  check(body.labels.written?.zh && body.labels.written?.en, "response contains bilingual labels");
  check(!body.entries.some((item) => item.opId === "b-only"), "workspace B rows do not leak into workspace A");
  const other = await (await fetch(base + query(b))).json();
  check(other.total === 1 && other.entries[0].opId === "b-only", "workspace B returns only its own entry");
  const capped = await (await fetch(base + query(a, 9999))).json();
  check(capped.limit === 200 && capped.entries.length === 200, "large limits are capped at the retention bound");
  const fractional = await (await fetch(base + query(a, 1.5))).json();
  check(fractional.limit === 1 && fractional.entries.length === 1, "fractional limits are normalized to whole entries");
  const unknown = await fetch(base + query(join(root, "unlisted")));
  check(unknown.status === 400 && !(await unknown.json()).ok, "unregistered workspaces are rejected");

  const result = { applied: [{ id: 5, action: "merge", type: "decision", text: "changed" }] };
  const inserted = { applied: [{ id: 5, action: "insert", type: "decision", text: "changed" }] };
  const firstTurn = [{ role: "user", messageId: "m1", seq: 1, text: "first change" }];
  const secondTurn = [{ role: "user", messageId: "m2", seq: 2, text: "second change" }];
  for (const [turns, outcome] of [[firstTurn, inserted], [firstTurn, result], [secondTurn, result]]) {
    check(noteChanges(b, rowsForExtract({ result: outcome, sessionId: "same-session", turns })).ok, "change window is written");
  }
  const replayed = await (await fetch(base + query(b))).json();
  check(replayed.total === 3, "insert-to-merge replay deduplicates while a later edit remains visible");
  const fixture = "演示口令 Demo123456";
  const sensitiveRows = rowsForExtract({
    sessionId: "same-session", turns: [{ role: "user", text: fixture }],
    result: {
      adjusted: [{ preview: fixture, removed: ["2027-03-01"] }],
      superseded: [{ from: 3, to: 4, label: fixture }],
    },
  });
  check(noteChanges(b, sensitiveRows).ok, "sensitive-looking audit input is handled");
  check(!readFileSync(changesPath(b), "utf8").includes(fixture), "sensitive-looking values are absent from all persisted fields");
  const sensitive = await (await fetch(base + query(b))).json();
  check(sensitive.entries.slice(0, 2).every((row) => /^[a-f0-9]{64}$/.test(row.opId)), "extraction operation IDs are opaque digests");
  check(sensitive.entries[0].preview === "<redacted>" && sensitive.entries[1].detail === "<redacted>", "preview and detail are redacted in the HTTP result");

  mkdirSync(changesPath(broken), { recursive: true });
  const failed = await fetch(base + query(broken));
  const failure = await failed.json();
  check(failed.status === 500 && failure.ok === false, "filesystem read failure is not presented as an empty log");
  check(!JSON.stringify(failure).includes(root), "filesystem failure does not expose a local path");
  mkdirSync(join(corrupt, ".dsh"), { recursive: true });
  writeFileSync(changesPath(corrupt), '{"reason":"written"}\ninvalid\n', "utf8");
  const damaged = await fetch(base + query(corrupt));
  check(damaged.status === 500 && !(await damaged.json()).ok, "corrupt rows are reported instead of silently dropped");
  let rejected = 0;
  await handler({ socket: { remoteAddress: "203.0.113.9" }, method: "GET", headers: {} }, {
    writeHead(status) { rejected = status; }, end() {},
  });
  check(rejected === 403, "registered handler rejects a non-loopback address");
  console.log(`P56: ${checks}/${checks}`);
} finally {
  await new Promise((done) => server.close(done));
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
}
