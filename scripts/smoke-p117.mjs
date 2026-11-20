/**
 * p117 — source attribution for rewritten candidates (P1-A v2).
 *
 * The 0.9.x pipeline already rejects exact tool echoes. This test covers the
 * next layer: a candidate that restates a memory the agent just read, in
 * different words, must not become a second current fact; it has to wait in the
 * pending list with the read it came from. A restatement the user actually typed
 * must still be written, and a changed number is a new fact rather than a
 * paraphrase.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'trivium-p117-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');
const source = await import('../lib/source-events.js');

let checks = 0;
let failures = 0;
let workspace = 0;
const NAME = '报表游标';
const BODY = '报表游标可以复用 24 小时。';

async function check(label, fn) {
  checks += 1;
  try {
    await fn();
    console.log('ok ' + label);
  } catch (error) {
    failures += 1;
    console.error('FAIL ' + label + ': ' + (error.message || error));
  }
}

async function open({ body = BODY, type = 'decision' } = {}) {
  const cwd = join(root, `ws-${++workspace}`);
  const db = await store.openWorkspaceDb(cwd);
  const entityId = store.insertNode(db, { type: 'entity', name: '报表服务', text: '报表服务实体。' });
  const factId = store.insertNode(db, { type, name: NAME, text: body });
  store.ensureLink?.(db, factId, entityId, 'about');
  return { db, entityId, factId };
}

const user = (text, seq = 11) => source.turnFromEvent({
  type: 'user/message', seq, time: 1794820542000,
  data: { id: `user-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const read = (id, payload) => source.turnFromEvent({
  type: 'tool/result', seq: 24, time: 1794820543000,
  data: {
    turn: 1, step: 1,
    message: {
      id: 'tool-24', role: 'tool', source: { kind: 'tool', callId: 'call-24' }, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ id, payload, edges: [], incoming: [] }) }],
    },
  },
}, { name: 'ctx_read' });

async function run(db, turns, candidates) {
  return extract.distill({
    db,
    turns,
    sessionId: 'synthetic-p117',
    now: new Date('2026-11-20T00:00:00.000Z'),
    llmCall: async () => JSON.stringify({ candidates }),
  });
}

const written = (db, text) => db.allNodeIds().some((id) => String(db.get(id)?.payload?.text || '').includes(text));

try {
  await check('an exact read echo is rejected before the source gate', async () => {
    const { db, factId } = await open();
    const result = await run(db, [user('请读一下报表游标那条记忆。'), read(factId, { type: 'decision', name: NAME, text: BODY, status: 'active' })],
      [{ type: 'decision', name: NAME, text: BODY, quote: BODY }]);
    if (result.applied.length !== 0) throw new Error(`applied ${result.applied.length}`);
    if (!result.skipped.some((row) => row.reason === 'memory-read-echo')) throw new Error(JSON.stringify(result.skipped));
    store.closeAll();
  });

  await check('a rewrite of the read fact does not become a second current fact', async () => {
    const { db, factId } = await open();
    const result = await run(db, [user('报表游标能复用多久？'), read(factId, { type: 'decision', name: NAME, text: BODY, status: 'active' })],
      [{ type: 'decision', name: NAME, text: '报表游标可复用的时长是 24 小时。', quote: '' }]);
    if (result.applied.length !== 0) throw new Error(`applied ${JSON.stringify(result.applied)}`);
    if (written(db, '可复用的时长')) throw new Error('the rewrite reached memory');
    if (result.unverified.length !== 1) throw new Error(`pending ${result.unverified.length}`);
    const held = result.unverified[0];
    if (held.reason !== 'memory-read-unverified') throw new Error(`reason ${held.reason}`);
    if (!Array.isArray(held.readIds) || !held.readIds.includes(Number(factId))) throw new Error(`readIds ${JSON.stringify(held.readIds)}`);
    store.closeAll();
  });

  await check('a restatement the user typed is written, not parked', async () => {
    const { db, factId } = await open();
    const result = await run(db, [user(`更正：报表游标可复用的时长是 12 小时。`), read(factId, { type: 'decision', name: NAME, text: BODY, status: 'active' })],
      [{ type: 'decision', name: NAME, text: '报表游标可复用的时长是 12 小时。', quote: '报表游标可复用的时长是 12 小时。' }]);
    if (result.applied.length !== 1) throw new Error(`applied ${result.applied.length} pending ${JSON.stringify(result.unverified)}`);
    if (!written(db, '12 小时')) throw new Error('the user sentence was not stored');
    store.closeAll();
  });

  await check('an unchanged paraphrase plus a new user fact writes only the new fact', async () => {
    const { db, factId } = await open();
    const result = await run(db, [user('请读一下报表游标；另外记住：报表导出目录是 out/。'), read(factId, { type: 'decision', name: NAME, text: BODY, status: 'active' })],
      [
        { type: 'decision', name: NAME, text: '报表游标可复用的时长是 24 小时。', quote: '' },
        { type: 'preference', name: '导出目录', text: '报表导出目录是 out/。', quote: '记住：报表导出目录是 out/。' },
      ]);
    if (!written(db, 'out/')) throw new Error('the new fact was lost');
    if (written(db, '可复用的时长')) throw new Error('the paraphrase reached memory');
    if (result.unverified.length !== 1) throw new Error(`pending ${result.unverified.length}`);
    store.closeAll();
  });

  await check('a cross-type copy of a read fact is parked with its read id', async () => {
    const { db, factId } = await open({ type: 'preference' });
    const result = await run(db, [user('请读一下报表游标那条记忆。'), read(factId, { type: 'preference', name: NAME, text: BODY, status: 'active' })],
      [{ type: 'decision', name: NAME, text: '报表游标可复用的时长是 24 小时。', quote: '' }]);
    if (result.applied.length !== 0) throw new Error(`applied ${result.applied.length}`);
    if (result.unverified.length !== 1) throw new Error(`pending ${result.unverified.length}`);
    if (!result.unverified[0].readIds?.includes(Number(factId))) throw new Error(JSON.stringify(result.unverified[0]));
    store.closeAll();
  });

  await check('a changed number with no read evidence still waits for a source', async () => {
    const { db } = await open();
    const result = await run(db, [user('报表游标能复用多久？')],
      [{ type: 'decision', name: NAME, text: '报表游标可以复用 6 小时。', quote: '' }]);
    if (result.applied.length !== 0) throw new Error('an unsourced number change was written');
    if (result.unverified.length !== 1) throw new Error(`pending ${result.unverified.length}`);
    store.closeAll();
  });

  await check('the same number stated by the user replaces instead of duplicating', async () => {
    const { db } = await open();
    const result = await run(db, [user('更新一下：报表游标可以复用 6 小时。')],
      [{ type: 'decision', name: NAME, text: '报表游标可以复用 6 小时。', quote: '报表游标可以复用 6 小时。' }]);
    if (result.applied.length !== 1) throw new Error(`applied ${result.applied.length}`);
    const bodies = db.allNodeIds().map((id) => String(db.get(id)?.payload?.text || '')).filter((text) => text.includes('报表游标可以复用'));
    if (bodies.length !== 2) throw new Error(`bodies ${JSON.stringify(bodies)}`);
    store.closeAll();
  });
} finally {
  try { store.closeAll(); } catch { /* closed */ }
  rmSync(root, { recursive: true, force: true });
}

console.log(`P117: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
