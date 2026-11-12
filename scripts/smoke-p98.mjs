/** Workspace write ownership through the production client's request handlers.
 * Reuse p26's controlled transport without running its frozen UI checks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const script = new URL("./smoke-p26.mjs", import.meta.url);
const prelude = readFileSync(script, "utf8").split("const tests = [")[0]
  .replace('from "../lib/store.js"', 'from "' + new URL("../lib/store.js", import.meta.url).href + '"')
  .replace('new URL("../lib/client.js", import.meta.url)', 'new URL("' + new URL("../lib/client.js", import.meta.url).href + '")');
const fixture = await import("data:text/javascript;base64," + Buffer.from(prelude
  + "\nexport { loaded, openPage, changeWorkspace, expandEntry, status, A, B };").toString("base64"));
const { loaded, openPage, changeWorkspace, expandEntry, status, A, B } = fixture;
let checks = 0;
const node = (text) => ({ id: 2, type: "preference", name: "item", text });

// A handler captured from a prior screen must fail closed even if invoked late.
const panel = await loaded([node("workspace A fact")]);
await expandEntry(panel, 2);
const oldArchive = panel.button("Archive").props.onClick;
const oldDelete = panel.button("Delete").props.onClick;
await changeWorkspace(panel, B);
oldArchive();
oldDelete();
await panel.flush();
assert.equal(panel.requests.filter((r) => r.options.method === "POST").length, 0);
checks++;

await panel.reply(panel.take("status"), { ...status, cwd: B });
await panel.reply(panel.take("nodes"), { nodes: [node("workspace B fact")] });
await panel.reply(panel.take("external"), { files: [] });
await expandEntry(panel, 2);
panel.button("Archive").props.onClick();
await panel.flush();
const request = panel.take("nodes/2/archive");
assert.equal(request.url.searchParams.get("cwd"), B);
checks++;

// A confirmation already awaiting a decision is cancelled by a workspace switch.
const confirming = await loaded([node("workspace A fact")]);
await expandEntry(confirming, 2);
confirming.button("Delete").props.onClick();
await confirming.flush();
await changeWorkspace(confirming, B);
await confirming.flush();
assert.equal(confirming.requests.filter((r) => r.options.method === "POST").length, 0);
checks++;

// A late deferred-write read cannot restore another library's conversation.
const reading = await loaded([]);
await openPage(reading, "runs");
const stale = reading.take("pending");
await changeWorkspace(reading, B);
await reading.reply(reading.take("status"), { ...status, cwd: B });
await reading.reply(reading.take("pending"), { ok: true, windows: [], turns: 0 });
await reading.reply(stale, { ok: true, windows: [{ sessionId: "old", turns: 1, preview: "PRIVATE_A" }], turns: 1 });
assert.equal(reading.text().includes("PRIVATE_A"), false);
checks++;

console.log(`P98 write ownership: ${checks}/${checks}`);
