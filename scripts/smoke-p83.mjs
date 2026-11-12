/**
 * p83 — one flush for a bulk write, not one per fact.
 *
 * Every mutation used to pay `db.flush()` (measured ~91 ms on this machine), so a
 * multi-fact import cost seconds of pure durability. `importExternal` and the
 * chip paste now run inside `runDeferredWrites` and flush once at the end.
 *
 * What this test pins:
 *
 *   1. an import of a dozen facts costs a couple of flushes, not one per fact;
 *   2. every fact still lands, and re-importing the same file adds nothing;
 *   3. the chip paste keeps its existing semantics (one body = one fact) and
 *      still writes the pins in the same batch;
 *   4. the batch is flushed even when the write path throws halfway — a write
 *      that already happened may not be lost because a later one failed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p83-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const store = await import('../lib/store.js');
const pins = await import('../lib/pins.js');
const markdownMod = await import('../lib/markdown.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const ws = join(root, 'ws');
const db = await store.openWorkspaceDb(ws);

// Count flushes without changing behaviour.
let flushes = 0;
const rawFlush = db.flush.bind(db);
db.flush = () => { flushes += 1; return rawFlush(); };
const resetCount = () => { flushes = 0; };
const factCount = () => store.findByType(db, 'preference').length + store.findByType(db, 'decision').length;

const IMPORT_LINES = [
  '记住：发布窗口固定在每周四晚上。',
  '记住：鉴权统一走 header X，不再用 query 参数。',
  '记住：数据库迁移必须先在小库上验证。',
  '记住：日志保留 30 天，超期归档。',
  '记住：接口变更要提前一周通知下游。',
  '记住：前端构建产物不提交到仓库。',
  '记住：线上故障优先回滚再定位。',
  '记住：新增依赖要写明许可证与体积影响。',
  '记住：配置里的密钥一律走环境变量。',
  '记住：每周五下午做一次依赖升级检查。',
  '记住：文档改动与代码改动分开提交。',
  '记住：发布前必须跑全量回归。',
];

try {
  // 1) Bulk import: one file, twelve facts, a couple of flushes.
  const claude = join(ws, 'CLAUDE.md');
  writeFileSync(claude, `${IMPORT_LINES.map((line) => `- ${line}`).join('\n')}\n`, 'utf8');
  const beforeImport = factCount();
  resetCount();
  const imported = markdownMod.importExternal(db, { cwd: ws, ids: ['claude-workspace'] });
  const afterImport = factCount();
  await check(() => assert.equal(imported.ok, true, imported.message || 'import failed'), 'the import reports success');
  await check(() => assert.ok(afterImport - beforeImport >= 8, `most lines become facts (${afterImport - beforeImport})`), 'the import writes most of the file');
  await check(() => assert.ok(flushes <= 3, `the whole import cost ${flushes} flush(es), not one per fact`), 'the import is one batch');
  await check(() => assert.ok(flushes < afterImport - beforeImport, 'fewer flushes than facts'), 'flushes do not scale with facts');

  // 2) Re-import: merges, no new nodes, still one batch.
  const beforeRepeat = factCount();
  resetCount();
  const again = markdownMod.importExternal(db, { cwd: ws, ids: ['claude-workspace'] });
  await check(() => assert.equal(factCount(), beforeRepeat, 'a repeat import adds no facts'), 'a repeat import does not duplicate');
  await check(() => assert.ok(flushes <= 3, `the repeat import cost ${flushes} flush(es)`), 'merges are batched too');
  await check(() => assert.equal(again.ok, true), 'the repeat import reports success');

  // 3) Chip paste: one body is one fact by design, and the pin rides the batch.
  resetCount();
  const chip = pins.addChipsFromText(db, '记住：芯片粘贴的正文算一条事实。', { sessionId: 'p83', pin: true });
  await check(() => assert.equal(chip.ok, true, chip.message), 'a chip paste is accepted');
  await check(() => assert.ok(flushes <= 2, `the paste cost ${flushes} flush(es)`), 'the paste and its pin are one batch');
  await check(() => {
    const pinned = pins.livePinIds(db, 'p83');
    assert.ok(chip.ids.every((id) => pinned.includes(id)), 'every new id is pinned');
  }, 'the pins land with the batch');

  // 4) Failure path: an earlier write survives a later failure.
  resetCount();
  let threw = false;
  try {
    store.runDeferredWrites(db, () => {
      store.insertNode(db, { type: 'preference', name: 'survives', text: '这条在失败前就写好了。' });
      const err = new Error('later candidate failed');
      err.code = 'SYNTHETIC';
      throw err;
    });
  } catch {
    threw = true;
  } finally {
    store.flushWorkspaceDb(db);
  }
  await check(() => assert.equal(threw, true), 'the failure still surfaces');
  // "Durable" has to mean "still there after reopening the file group", not
  // "visible through the handle that performed the write" (assertion audit).
  store.closeAll();
  const reopened = await store.openWorkspaceDb(ws);
  await check(() => {
    const rows = store.findByType(reopened, 'preference');
    assert.ok(rows.some((row) => row.payload?.name === 'survives'), 'the write before the failure is durable across a reopen');
  }, 'a write that already happened survives a later failure (after reopen)');

  /*
   * 5) The real import response must admit a partial commit (F86-03). A batch
   * is not a transaction: earlier writes are already durable when a later
   * candidate throws, and the caller needs to be told, not handed a bare 500.
   */
  const ws2 = join(root, 'ws2');
  const db2 = await store.openWorkspaceDb(ws2);
  writeFileSync(join(ws2, 'CLAUDE.md'), `${IMPORT_LINES.slice(0, 4).map((line) => `- ${line}`).join('\n')}\n`, 'utf8');
  const before2 = db2.allNodeIds().length;
  const rawInsert2 = db2.insert.bind(db2);
  let inserts2 = 0;
  db2.insert = (...args) => { if (++inserts2 === 3) throw new Error('synthetic third insert failure'); return rawInsert2(...args); };
  const partial = markdownMod.importExternal(db2, { cwd: ws2, ids: ['claude-workspace'] });
  db2.insert = rawInsert2;
  await check(() => {
    assert.equal(partial.ok, false);
    assert.equal(partial.partial, true);
    assert.equal(partial.newNodesBeforeFailure, 2, `two writes were durable before the failure (${partial.newNodesBeforeFailure})`);
    assert.equal(partial.created, null, 'unknown created action count is not a false zero');
    assert.equal(partial.merged, null, 'earlier merges cannot be inferred from node growth');
    assert.equal(partial.applied, null, 'unknown applied action count is not a false zero');
    assert.equal(partial.skipped, null, 'parse skips alone do not establish the total skipped count');
    assert.ok(partial.retryHint, 'the caller is told how to retry');
  }, 'a failed import reports a partial commit instead of a bare throw');
  store.closeAll();
  const reopened2 = await store.openWorkspaceDb(ws2);
  await check(
    () => assert.equal(reopened2.allNodeIds().length - before2, 2),
    'the partial commit really is durable after reopen',
  );

  // Chip archive/delete is another synchronous batch. A response can only
  // acknowledge it after the single final flush, including partial failures.
  const bulkWorkspace = join(root, 'chip-bulk');
  const bulkDb = await store.openWorkspaceDb(bulkWorkspace);
  const ids = [];
  store.runDeferredWrites(bulkDb, () => {
    for (let i = 0; i < 6; i++) ids.push(store.insertNode(bulkDb, {
      type: 'preference', name: 'BatchCanary' + i, text: 'BatchCanary' + i + ' remains searchable.',
    }));
  });
  store.flushWorkspaceDb(bulkDb);
  let bulkFlushes = 0;
  const bulkFlush = bulkDb.flush.bind(bulkDb);
  bulkDb.flush = () => { bulkFlushes++; return bulkFlush(); };
  const archived = pins.batchChipAction(bulkDb, { action: 'archive', ids: ids.slice(0, 4) });
  await check(() => {
    assert.equal(archived.count, 4);
    assert.equal(bulkFlushes, 1);
    assert.ok(ids.slice(0, 4).every((id) => bulkDb.get(id).payload.status === 'archived'));
    assert.deepEqual(store.findByType(bulkDb, 'preference').map((row) => row.id).sort(), ids.slice(4));
    assert.deepEqual(pins.listChips(bulkDb).map((row) => row.id).sort(), ids.slice(4));
    assert.equal(store.searchNodes(bulkDb, 'BatchCanary0').length, 0);
    assert.ok(store.searchNodes(bulkDb, 'BatchCanary4').some((row) => row.id === ids[4]));
  }, 'chip archives flush once and preserve current search visibility');
  bulkFlushes = 0;
  const removed = pins.batchChipAction(bulkDb, { action: 'delete', ids: ids.slice(4) });
  await check(() => {
    assert.equal(removed.count, 2);
    assert.equal(bulkFlushes, 1);
    assert.ok(ids.slice(4).every((id) => !bulkDb.get(id)));
  }, 'chip deletes keep their semantics with one final flush');
  bulkFlushes = 0;
  pins.batchChipAction(bulkDb, { action: 'archive', ids: [] });
  pins.batchChipAction(bulkDb, { action: 'delete', ids: [999999] });
  await check(() => assert.equal(bulkFlushes, 0), 'empty or missing-only chip batches do not add a flush');
  const prior = store.insertNode(bulkDb, { type: 'decision', name: 'prior', text: 'prior protected decision' });
  const successor = store.insertNode(bulkDb, { type: 'decision', name: 'successor', text: 'successor protected decision' });
  store.ensureLink(bulkDb, successor, prior, 'supersedes');
  bulkFlushes = 0;
  const protectedBatch = pins.batchChipAction(bulkDb, { action: 'delete', ids: [prior, successor] });
  await check(() => {
    assert.equal(protectedBatch.count, 0);
    assert.deepEqual(protectedBatch.blocked, [prior, successor]);
    assert.equal(bulkFlushes, 0);
    assert.ok(bulkDb.get(prior) && bulkDb.get(successor));
  }, 'protected-only chip batches keep the revision guard without adding a flush');

  for (const action of ['archive', 'delete']) {
    const failureWorkspace = join(root, 'chip-partial-' + action);
    const engine = await store.openWorkspaceDb(failureWorkspace);
    const first = store.insertNode(engine, { type: 'preference', text: 'first mutation must survive' });
    const second = store.insertNode(engine, { type: 'preference', text: 'second mutation is interrupted' });
    const method = action === 'archive' ? 'updatePayload' : 'delete';
    const original = engine[method].bind(engine);
    let calls = 0;
    engine[method] = (...args) => {
      if (++calls === 2) throw new Error('synthetic second chip mutation failure');
      return original(...args);
    };
    await check(() => assert.throws(
      () => pins.batchChipAction(engine, { action, ids: [first, second] }),
      /synthetic second chip mutation failure/,
    ), action + ' batch reports a later mutation failure');
    engine[method] = original;
    store.closeAll();
    const durable = await store.openWorkspaceDb(failureWorkspace);
    await check(() => {
      if (action === 'archive') assert.equal(durable.get(first).payload.status, 'archived');
      else assert.equal(durable.get(first), null);
      assert.equal(durable.get(second).payload.status, 'active');
    }, action + ' completed before failure survives reopening');
  }
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}

console.log(`P83: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
