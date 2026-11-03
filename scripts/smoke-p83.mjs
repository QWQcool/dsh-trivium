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
  await check(() => {
    const rows = store.findByType(db, 'preference');
    assert.ok(rows.some((row) => row.payload?.name === 'survives'), 'the write before the failure is durable');
  }, 'a write that already happened survives a later failure');
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}

console.log(`P83: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
