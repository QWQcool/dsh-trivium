/**
 * p81 — stage 1 part B prototype: one writer, many callers.
 *
 * The router exists to turn "defer" into "queue": a worker whose extraction
 * loses a file lock today leaves its window pending, and a pending window in a
 * work-item directory that is never opened again is a lost fact. This test
 * drives two real sockets against one router and asserts:
 *
 *   1. the router's `MemoryWriter` is accepted by the port (no local fallback);
 *   2. concurrent callers all land: every write is applied exactly once;
 *   3. ids come back to the caller that asked, in the order it asked;
 *   4. a failing operation fails at the caller (no silent success);
 *   5. no router → `ROUTER_UNAVAILABLE`, and nothing is written locally;
 *   6. after `close()` the endpoint is gone, and a later client fails the same way.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect as connectRaw } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p81-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const store = await import('../lib/store.js');
const { createRouterClient, routerEndpoint, startRouter } = await import('../lib/router.js');
const { memoryWriterFor } = await import('../lib/memory-writer.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const ws = join(root, 'ws');
const other = join(root, 'no-router');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 5) Before any router exists: the client must say so, and must not write.
await check(async () => {
  const client = createRouterClient({ cwd: other });
  await assert.rejects(() => client.ready, (err) => err.code === 'ROUTER_UNAVAILABLE');
  await assert.rejects(
    () => client.writer.insert({ type: 'preference', name: 'x', text: 'x' }),
    (err) => err.code === 'ROUTER_UNAVAILABLE',
  );
  assert.equal(store.listOpenWorkspaces().some((row) => row.cwd === other), false, 'no local store was opened');
  await client.close();
}, 'no router means ROUTER_UNAVAILABLE, with no silent local write');

const router = await startRouter({ cwd: ws });
try {
  // 1) The port accepts it.
  await check(() => {
    const writer = createRouterClient({ cwd: ws }).writer;
    assert.equal(writer.kind, 'router');
    assert.equal(memoryWriterFor(null, writer), writer);
    assert.throws(() => memoryWriterFor(null, { insert: () => 1 }), (err) => err.code === 'WRITER_INCOMPLETE');
  }, 'the router writer satisfies the memory writer port');

  const a = createRouterClient({ cwd: ws });
  const b = createRouterClient({ cwd: ws });
  await Promise.all([a.ready, b.ready]);

  // 2) Sequential writes keep the caller's order and come back with ids.
  const seqA = [];
  for (let i = 0; i < 5; i += 1) {
    seqA.push(await a.writer.insert({ type: 'preference', name: `a-${i}`, text: `a-${i}` }));
  }
  await check(() => assert.equal(new Set(seqA).size, 5), 'every insert returns its own id');
  await check(() => assert.deepEqual(seqA, [...seqA].sort((x, y) => x - y)), 'ids increase for a caller that waits');

  // 3) Concurrent callers: 2 x 10 writes fired at once, none lost.
  const burst = [];
  for (let i = 0; i < 10; i += 1) {
    burst.push(a.writer.insert({ type: 'preference', name: `burst-a-${i}`, text: `burst-a-${i}` }));
    burst.push(b.writer.insert({ type: 'preference', name: `burst-b-${i}`, text: `burst-b-${i}` }));
  }
  const ids = await Promise.all(burst);
  await check(() => assert.equal(new Set(ids).size, 20), '20 concurrent writes get 20 distinct ids');
  await sleep(150);
  const routerDb = await store.openWorkspaceDb(ws);
  const facts = store.findByType(routerDb, 'preference');
  await check(() => assert.equal(facts.length, 25), `all 25 facts landed exactly once (got ${facts.length})`);
  await check(() => assert.deepEqual(facts.map((row) => row.id).sort((x, y) => x - y), ids.concat(seqA).sort((x, y) => x - y)), 'the applied ids are exactly the ones the callers were told');

  // 3b) Queue depth is observable: the burst had to queue, and it drained.
  await check(async () => {
    await sleep(200);
    const stats = router.stats();
    assert.equal(stats.queued, 0, 'the queue drains');
    assert.ok(stats.maxQueued >= 1, `a burst was queued (max ${stats.maxQueued})`);
    assert.ok(stats.applied >= 25, `every write is counted as applied (${stats.applied})`);
    assert.equal(stats.failed, 0, 'no failures were counted');
  }, 'the router reports its queue depth and applied count');

  /*
   * 4) The error channel, tested where it is deterministic. The store's own
   * refusals (a missing id, a dangling link) are lenient by design — it returns
   * nothing rather than throwing — so the router's error path is exercised with
   * an unknown op and with a malformed line, both over a raw socket.
   */
  const raw = (line) => new Promise((resolve, reject) => {
    const socket = connectRaw(router.endpoint);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const reply = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      socket.end();
      resolve(reply);
    });
    socket.on('connect', () => socket.write(line));
  });
  await check(async () => {
    const reply = await raw(`${JSON.stringify({ id: 7, op: 'explode', args: {} })}\n`);
    assert.equal(reply.id, 7);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'ROUTER_UNKNOWN_OP');
  }, 'an unknown operation comes back as a coded failure');
  await check(async () => {
    const reply = await raw('{not json}\n');
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'ROUTER_BAD_REQUEST');
  }, 'a malformed request is answered, not ignored');

  await a.close();
  await b.close();
} finally {
  await router.close();
  store.closeAll();
}

// 6) After close, the endpoint is gone.
await check(async () => {
  const late = createRouterClient({ cwd: ws });
  await assert.rejects(() => late.ready, (err) => err.code === 'ROUTER_UNAVAILABLE');
  await late.close();
}, 'a closed router stops accepting clients');

await check(() => assert.equal(routerEndpoint(ws), routerEndpoint(ws)), 'the endpoint is stable per workspace');
await check(() => assert.notEqual(routerEndpoint(ws), routerEndpoint(other)), 'different workspaces get different endpoints');

rmSync(root, { recursive: true, force: true });
console.log(`P81: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
