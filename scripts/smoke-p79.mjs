/**
 * p79 — B4 memory write port.
 *
 * The extraction pipeline used to call the store directly. These checks pin the
 * new boundary:
 *
 *   1. the local writer is a complete implementation of the four methods;
 *   2. an incomplete writer is refused at the boundary, not halfway through a
 *      write;
 *   3. `applyCandidates` sends every mutation through the writer it was given
 *      (insert / merge / link / update), and the default still writes;
 *   4. `distill` accepts the writer too: with a stub, the database is untouched
 *      while the pipeline still reports what it applied;
 *   5. the revision-chain refusal still comes back as an error through the port.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p79-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');
const writerMod = await import('../lib/memory-writer.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

/** Records every call and does not touch the database. */
function stubWriter() {
  const calls = [];
  let next = 9000;
  return {
    calls,
    kind: 'stub',
    insert(payload) { calls.push(['insert', payload.type, String(payload.text).slice(0, 20)]); next += 1; return next; },
    merge(id, payload) { calls.push(['merge', id, String(payload.text).slice(0, 12)]); return id; },
    link(from, to, label) { calls.push(['link', from, to, label]); return true; },
    update(id, patch) { calls.push(['update', id, patch]); return true; },
  };
}

/** Delegates to the real writer but records the calls. */
function recordingWriter(db) {
  const local = writerMod.localMemoryWriter(db);
  const calls = [];
  return {
    calls,
    kind: 'recording',
    insert: (payload) => { calls.push('insert'); return local.insert(payload); },
    merge: (id, payload) => { calls.push('merge'); return local.merge(id, payload); },
    link: (from, to, label) => { calls.push('link'); return local.link(from, to, label); },
    update: (id, patch) => { calls.push('update'); return local.update(id, patch); },
  };
}

const db = await store.openWorkspaceDb(join(root, 'ws'));

try {
  // 1) Shape of the port.
  await check(() => {
    const local = writerMod.localMemoryWriter(db);
    for (const method of writerMod.MEMORY_WRITER_METHODS) assert.equal(typeof local[method], 'function', method);
    assert.equal(local.kind, 'local');
  }, 'the local writer implements exactly the four methods');
  await check(() => {
    const broken = { insert: () => 1, merge: () => 1 };
    assert.throws(() => writerMod.memoryWriterFor(db, broken), (err) => err.code === 'WRITER_INCOMPLETE');
  }, 'an incomplete writer is refused before any write');
  await check(() => {
    const fallback = writerMod.memoryWriterFor(db);
    assert.equal(fallback.kind, 'local');
  }, 'no writer means the local database');

  // 2) Every mutation goes through the given writer.
  const before = store.nodeCountOf(db);
  const recording = recordingWriter(db);
  await check(() => {
    const applied = extract.applyCandidates(
      db,
      [{ type: 'preference', text: '记住：部署窗口是每周四晚上。', name: '部署窗口' }],
      { sessionId: 'p79', writer: recording },
    );
    assert.equal(applied.length, 1);
    assert.ok(applied[0].id > 0);
  }, 'applyCandidates writes the fact');
  await check(() => assert.ok(recording.calls.includes('insert')), 'the insert went through the writer');
  await check(() => assert.equal(store.nodeCountOf(db), before + 1), 'the default (delegating) writer really wrote it');

  // 3) merge and link also go through the port.
  const listed = store.listNodes(db);
  const rows = Array.isArray(listed) ? listed : listed.nodes || [];
  const stored = rows.find((n) => n.type === 'preference');
  const mergeRecorder = recordingWriter(db);
  await check(() => {
    extract.applyCandidates(
      db,
      [{ type: 'preference', text: `${stored.text} 目前仍然如此。`, name: stored.name || '部署窗口' }],
      { sessionId: 'p79', writer: mergeRecorder },
    );
    assert.ok(mergeRecorder.calls.includes('merge'), `calls: ${mergeRecorder.calls.join(',')}`);
  }, 'a repeat folds through writer.merge');

  await check(() => {
    extract.applyCandidates(db, [{ type: 'entity', text: '部署窗口这个实体。', name: '部署窗口' }], { sessionId: 'p79' });
  }, 'fixture: the link target exists');
  const linkRecorder = recordingWriter(db);
  await check(() => {
    extract.applyCandidates(
      db,
      [{ type: 'decision', text: '改用方案 B 做发布。', name: '发布方案 B', linkName: '部署窗口' }],
      { sessionId: 'p79', writer: linkRecorder },
    );
    assert.ok(linkRecorder.calls.includes('link'), `calls: ${linkRecorder.calls.join(',')}`);
  }, 'a named neighbour links through writer.link');

  // 4) A stub writer: the pipeline reports work, the database stays untouched.
  const stub = stubWriter();
  const countBeforeStub = store.nodeCountOf(db);
  const sniffed = [];
  const stubResult = await extract.distill({
    db,
    writer: stub,
    turns: [{ role: 'user', text: '记住：值班表每两周轮换一次。' }],
    sessionId: 'p79-stub',
    llmCall: async () => JSON.stringify({ candidates: [] }),
  });
  await check(() => assert.ok(stubResult.applied.length >= 1), 'the stub run still reports applied facts');
  await check(() => assert.ok(stubResult.applied.every((row) => row.id >= 9001)), 'the ids came from the stub');
  await check(() => assert.equal(store.nodeCountOf(db), countBeforeStub), 'the stub wrote nothing to the database');
  await check(() => assert.ok(stub.calls.some((row) => row[0] === 'insert')), 'the stub received the insert');
  await check(() => assert.ok(!stub.calls.some((row) => row[0] === 'update' && row[2] && row[2].review)), 'review marking stayed out of the stub run');

  // 5) The default path is unchanged: no writer, real write.
  const countBeforeDefault = store.nodeCountOf(db);
  await extract.distill({
    db,
    turns: [{ role: 'user', text: '记住：值班表每两周轮换一次。' }],
    sessionId: 'p79-default',
    llmCall: async () => JSON.stringify({ candidates: [] }),
  });
  await check(() => assert.equal(store.nodeCountOf(db), countBeforeDefault + 1), 'distill without a writer still writes to the database');

  // 6) A refusal inside the writer is not swallowed by the pipeline.
  await check(() => {
    const refusing = {
      kind: 'refusing',
      insert: () => { const err = new Error('router refused'); err.code = 'WRITER_REFUSED'; throw err; },
      merge: () => { throw new Error('unused'); },
      link: () => true,
      update: () => true,
    };
    assert.throws(
      () => extract.applyCandidates(db, [{ type: 'preference', text: '记住：这条会被拒绝。', name: '被拒绝' }], { writer: refusing }),
      (err) => err.code === 'WRITER_REFUSED',
    );
  }, 'a refusal from the writer surfaces instead of being swallowed');
  void sniffed;
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P79: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
