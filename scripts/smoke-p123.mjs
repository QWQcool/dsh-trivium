import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import engine from "triviumdb";
import { listTaskCheckpoints, previewTaskChanges, saveTaskCheckpoint, taskChangeCheckpointPath, TASK_CHANGE_LIMITS } from "../lib/task-changes.js";

const { TriviumDB } = engine;
const parent = realpathSync(tmpdir());
const prefix = "dsh-task-changes-p123-";
const root = realpathSync(mkdtempSync(join(parent, prefix)));
const now = () => new Date("2026-10-15T12:00:00.000Z");
const createdAt = "2026-10-01T12:00:00.000Z";
const handles = new Set();
let checks = 0;
const pass = message => { console.log("ok " + message); checks++; };
const errorIs = (status, code) => error => error.status === status && error.code === code;
const options = { timeNow: now };
function open(name) {
  const cwd = join(root, name);
  mkdirSync(join(cwd, ".dsh"), { recursive: true });
  const db = new TriviumDB(join(cwd, ".dsh", "task-fixture.tdb"), { dim: 2, autoBuildQuiver: false, syncMode: "off" });
  handles.add(db);
  return { cwd, db };
}
function put(db, id, fields) { db.insertWithId(id, [1, 0], { status: "active", createdAt, ...fields }); }
function fixture(db) {
  put(db, 1, { type: "entity", name: "Harness synthetic project" });
  put(db, 2, { type: "decision", text: "Keep the localhost worker timeout at 30 seconds." });
  put(db, 3, { type: "preference", text: "Show the per-task trace." });
  put(db, 4, { type: "preference", text: "Do not share unchecked artifacts." });
  put(db, 5, { type: "decision", text: "Use a temporary process before release.", untilAt: "2026-10-16T12:00:00.000Z" });
  put(db, 6, { type: "decision", text: "Read back the original source before release." });
  for (const id of [2, 3, 4, 5, 6]) db.link(id, 1, "about");
  db.flush();
}
const preview = ({cwd,db}, entityId=1, nowOptions=options) => previewTaskChanges(cwd,db,entityId,nowOptions);
const save = ({cwd,db}, token, entityId=1, action, nowOptions=options) => saveTaskCheckpoint(cwd,db,{entityId,viewRevision:token,...(action?{action}:{})},nowOptions);
try {
  const a = open("workspace-a"), b = open("workspace-b");
  fixture(a.db); fixture(b.db);
  const fresh = await preview(a), other = await preview(b);
  assert.equal(fresh.state,"no_checkpoint");
  assert.equal(fresh.currentFacts,6);
  assert.notEqual(fresh.viewRevision,other.viewRevision);
  assert.equal(existsSync(taskChangeCheckpointPath(a.cwd)),false);
  await assert.rejects(()=>save(b,fresh.viewRevision),errorIs(409,"TASK_CHANGES_PREVIEW_CHANGED"));
  assert.equal(existsSync(taskChangeCheckpointPath(b.cwd)),false);
  pass("preview never writes and a token cannot acknowledge an identical scope in a different workspace");

  const saved = await save(a,fresh.viewRevision);
  assert.equal(saved.receipt.action,"remembered");
  assert.equal(saved.state,"unchanged");
  assert.equal(saved.checkpointAt,now().toISOString());
  assert.equal(readFileSync(taskChangeCheckpointPath(a.cwd),"utf8").includes("localhost worker"),false);
  await assert.rejects(()=>save(a,fresh.viewRevision),errorIs(409,"TASK_CHANGES_PREVIEW_CHANGED"));
  pass("confirm persists only hashes and invalidates the old comparison token");

  const noChange = await preview(a);
  a.db.updatePayload(2,{...a.db.getPayload(2), text:"Keep the localhost worker timeout at 90 seconds."});
  a.db.updatePayload(3,{...a.db.getPayload(3), status:"archived"});
  a.db.unlink(4,1,"about");
  put(a.db,7,{type:"decision",text:"Verify the exact stored source revision instead."});
  a.db.link(7,1,"decided");
  a.db.link(7,6,"supersedes");
  put(a.db,8,{type:"experience",text:"Record the local host receipt after restart."});
  a.db.link(1,8,"about");
  put(a.db,9,{type:"experience",text:"Different task, not in scope."});
  const afterExpiry = { timeNow: () => new Date("2026-10-17T12:00:00.000Z") };
  const changed = await preview(a,1,afterExpiry);
  assert.equal(changed.state,"changed");
  assert.deepEqual(changed.changes.map(row=>[row.kind,row.id]),[
    ["updated",2],["archived",3],["left_scope",4],["expired",5],["replaced",6],["added",8],
  ]);
  assert.equal(changed.changes.find(row=>row.kind==="replaced").replacement.id,7);
  assert.ok(!JSON.stringify(changed).includes("Different task"));
  await assert.rejects(()=>save(a,noChange.viewRevision,1,undefined,afterExpiry),errorIs(409,"TASK_CHANGES_PREVIEW_CHANGED"));
  pass("edit, archive, detach, clock-only expiry, replacement and add produce truthful scoped net deltas");

  a.db.flush(); a.db.close(); handles.delete(a.db);
  const reopened = open("workspace-a");
  assert.deepEqual((await preview(reopened,1,afterExpiry)).changes,changed.changes);
  assert.equal((await preview(b)).state,"no_checkpoint");
  pass("checkpoint and comparison survive reopening the native handle");

  const updatedCheckpoint = await save(reopened,changed.viewRevision,1,undefined,afterExpiry);
  reopened.db.updatePayload(1,{...reopened.db.getPayload(1),status:"archived"});
  await assert.rejects(()=>preview(reopened,1,afterExpiry),errorIs(409,"ENTITY_SEARCH_ENTITY_UNAVAILABLE"));
  const checkpoint = listTaskCheckpoints(reopened.cwd).checkpoints[0];
  assert.equal(checkpoint.forgetRevision,updatedCheckpoint.forgetRevision);
  await assert.rejects(()=>save(reopened,saved.forgetRevision,1,"forget",afterExpiry),errorIs(409,"TASK_CHANGES_PREVIEW_CHANGED"));
  assert.equal((await save(reopened,checkpoint.forgetRevision,1,"forget",afterExpiry)).receipt.action,"forgotten");
  assert.deepEqual(listTaskCheckpoints(reopened.cwd).checkpoints,[]);
  pass("an archived entity can be forgotten from the saved list, but a stale removal token cannot");

  const reused = open("workspace-reuse");
  fixture(reused.db);
  await save(reused,(await preview(reused)).viewRevision);
  reused.db.delete(1);
  put(reused.db,1,{type:"entity",name:"Another entity",createdAt:"2026-10-08T12:00:00.000Z"});
  const replacement = await preview(reused);
  assert.equal(replacement.state,"anchor_replaced");
  assert.deepEqual(replacement.changes,[]);
  pass("a recycled numeric entity ID cannot inherit another entity's baseline");

  const big = open("workspace-big");
  put(big.db,1,{type:"entity",name:"A bounded task"});
  for (let id=2; id<=TASK_CHANGE_LIMITS.facts+1; id++) {
    put(big.db,id,{type:"preference",text:"Bounded scope fixture "+id});
    big.db.link(1,id,"about");
  }
  await assert.rejects(()=>preview(big),error=>error.status===422
    && ["TASK_CHANGES_SCOPE_LIMIT","ENTITY_SEARCH_WORK_LIMIT"].includes(error.code));
  assert.equal(existsSync(taskChangeCheckpointPath(big.cwd)),false);
  pass("a scope beyond the full-checkpoint cap fails instead of giving a misleading partial diff");

  writeFileSync(taskChangeCheckpointPath(b.cwd),Buffer.alloc(TASK_CHANGE_LIMITS.bytes+1, 120));
  assert.throws(()=>listTaskCheckpoints(b.cwd),errorIs(409,"TASK_CHANGES_CHECKPOINT_UNREADABLE"));
  await assert.rejects(()=>save(b,other.viewRevision),errorIs(409,"TASK_CHANGES_CHECKPOINT_UNREADABLE"));
  assert.equal(readFileSync(taskChangeCheckpointPath(b.cwd)).length,TASK_CHANGE_LIMITS.bytes+1);
  pass("oversized/corrupt checkpoint fails closed and is not overwritten");

  console.log("P123 task memory changes: "+checks+"/"+checks);
} finally {
  for (const db of handles) db.close();
  if (dirname(root) === parent && basename(root).startsWith(prefix)) rmSync(root, { recursive: true, force: true });
}
