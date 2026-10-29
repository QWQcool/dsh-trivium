/** Public write guard and malformed-chain projection; synthetic native stores only. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p31-"));
process.env.DSH_HOME = join(root, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
const store = await import("../lib/store.js");
const { makeRevisionResolver, supersede } = await import("../lib/revisions.js");
const { registerTools } = await import("../lib/tools.js");
const { selectContextRecords } = await import("../lib/context-budget.js");
const tools = new Map();
registerTools({ effect: (fn) => fn(), tools: { register(t) { tools.set(t.name, t); return () => {}; } }, on() {} }, {});
const snapshot = (db) => JSON.stringify(db.allNodeIds().map(Number).sort((a, b) => a - b).map((id) => db.get(id)));
let checks = 0, failed = 0;
const check = (ok, label) => { checks++; if (ok) console.log("ok  " + label); else { failed++; console.error("FAIL " + label); } };

try {
  const cwd = join(root, "public");
  const db = await store.openWorkspaceDb(cwd);
  const old = store.insertNode(db, { type: "decision", name: "OriginalPolicy", text: "The original reviewed policy." });
  const before = snapshot(db);
  const exec = { agent: { session: { id: "p31", header: { cwd } } } };
  const response = await tools.get("ctx_remember").execute({ type: "decision", name: "UnconfirmedReplacement", text: "An unconfirmed different policy.", link_to: old, link_label: "supersedes" }, exec);
  check(String(response).startsWith("Refused:"), "REV-31 ctx_remember cannot bypass human confirmation through link_label");
  check(snapshot(db) === before, "REV-31 rejected remember leaves no payload, node or edge behind");
  const ordinary = await tools.get("ctx_remember").execute({ type: "preference", text: "Keep this supported business relationship.", link_to: old, link_label: "about" }, exec);
  check(String(ordinary).startsWith("Remembered id="), "REV-31 normal remember-and-link still works");
  check(String(await tools.get("ctx_link").execute({ from: old, to: old, label: "supersedes" }, exec)).startsWith("Refused:"), "REV-31 ctx_link keeps its existing revision guard");

  for (const kind of ["cycle", "fork", "too-long", "non-decision", "missing-node"]) {
    const badCwd = join(root, kind);
    const bad = await store.openWorkspaceDb(badCwd);
    const ids = Array.from({ length: kind === "too-long" ? 34 : kind === "fork" ? 3 : 2 }, (_, i) => store.insertNode(bad, { type: "decision", name: `${kind} Policy ${i}`, text: `G4_${kind}_${i} unique synthetic policy.`, uri: `test://${kind}/${i}` }));
    if (kind === "cycle") {
      assert.equal(supersede(bad, { oldId: ids[0], successorId: ids[1] }).ok, true);
      assert.equal(store.ensureLink(bad, ids[0], ids[1], "supersedes"), true, "reverse edge, not the already-existing edge");
    } else if (kind === "fork") {
      bad.link(ids[1], ids[0], "supersedes", 0.8);
      bad.link(ids[2], ids[0], "supersedes", 0.8);
    } else if (kind === "too-long") {
      for (let i = 1; i < ids.length; i++) bad.link(ids[i], ids[i - 1], "supersedes", 0.8);
    } else {
      bad.link(ids[1], ids[0], "supersedes", 0.8);
      if (kind === "non-decision") bad.updatePayload(ids[1], { ...bad.get(ids[1]).payload, type: "entity" });
      else bad.delete(ids[1]);
    }
    const resolver = makeRevisionResolver(bad);
    // The native delete may remove incident edges; a truly absent requested node
    // must still fail closed, without claiming a reachable dangling edge exists.
    const probes = kind === "missing-node" ? [ids[1]] : kind === "cycle" ? ids.slice(0, 2) : ids;
    check(probes.every((id) => !store.currentHeadOf(bad, id).ok && resolver(id) === null), `REV-31 ${kind} is unavailable from every affected node`);
    const plan = selectContextRecords({ recall: probes.map((id) => ({ id, type: "decision", l0: "corrupt candidate" })), resolveCurrent: resolver });
    check(plan.records.length === 0, `REV-31 ${kind} does not enter automatic context`);
    if (kind !== "missing-node") {
      const text = await tools.get("ctx_find").execute({ query: kind }, { agent: { session: { id: kind, header: { cwd: badCwd } } } });
      check(!String(text).includes(`G4_${kind}`), `REV-31 ${kind} is not exposed as a current fact by ctx_find`);
    }
  }
} finally { store.closeAll(); rmSync(root, { recursive: true, force: true }); }
console.log(`P31 revision gates: ${checks - failed}/${checks}`);
if (failed) process.exitCode = 1;
