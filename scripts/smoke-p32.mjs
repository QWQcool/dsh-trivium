import assert from "node:assert/strict";
import { createExtractScheduler } from "../lib/extract-scheduler.js";

let time = 0, seq = 0, calls = [], saved = [], finish;
const timers = new Map();
const scheduler = createExtractScheduler({
  now: () => time,
  setTimer: (fn, delay) => { const id = ++seq; timers.set(id, { fn, due: time + delay }); return id; },
  clearTimer: (id) => timers.delete(id),
  run: async (turns) => { calls.push(turns.map((x) => x.text)); return new Promise((resolve) => { finish = resolve; }); },
  persist: (buf, error) => saved.push({ turns: buf.turns.map((x) => x.text), error }),
});
const tick = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const add = (buf, text) => { buf.turns.push({ role: "user", text }); buf.dirty = true; };
const buf = { turns: [], dirty: false };
add(buf, "first");
scheduler.schedule(buf, {});
assert.equal([...timers.values()][0].due, 60_000);
time = 60_000;
const timer = [...timers.entries()][0]; timers.delete(timer[0]); timer[1].fn();
await tick(); assert.equal(calls.length, 1);
add(buf, "arrived during extraction");
scheduler.schedule(buf, {}, "compaction/end");
await tick(); assert.equal(calls.length, 1, "compaction cannot duplicate an in-flight batch");
finish(true); await tick();
assert.deepEqual(buf.turns.map((x) => x.text), ["arrived during extraction"]);
assert.equal([...timers.values()][0].due, 360_000, "cooldown schedules its own wakeup");
assert.deepEqual(saved.at(-1).turns, ["arrived during extraction"]);
time = 360_000;
const next = [...timers.entries()][0]; timers.delete(next[0]); next[1].fn();
await tick(); assert.equal(calls.length, 2);
finish(false); await tick();
assert.equal(buf.turns.length, 1, "failure does not consume the batch");
assert.equal(timers.size, 0, "failure must not cause an unlimited paid retry loop");
time += 300_000;
const retry = scheduler.schedule(buf, {}, "compaction/end"); await tick();
assert.equal(calls.length, 3, "failure is not a successful dedupe entry");
finish(true); await retry;
assert.equal(buf.turns.length, 0);
add(buf, "arrived during extraction");
await scheduler.schedule(buf, {}, "compaction/end");
assert.equal(calls.length, 3, "identical successful batch is skipped and drained");
assert.equal(buf.turns.length, 0);
add(buf, "after dedupe");
const last = scheduler.schedule(buf, {}, "compaction/end"); await tick();
assert.deepEqual(calls.at(-1), ["after dedupe"]);
add(buf, "survives dispose"); scheduler.dispose(buf); finish(true); await last;
assert.deepEqual(saved.at(-1).turns, ["survives dispose"]);
assert.equal(timers.size, 0);
scheduler.disposeAll();
console.log("P32 scheduler passed: snapshot isolation, single flight, eventual wakeup, bounded failure, retry, successful dedupe, disposal");
