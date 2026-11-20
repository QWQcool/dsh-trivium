/**
 * p119 — bounded directory import for document evidence (P2-A).
 *
 * The panel could only take text typed into one document. This adds an explicit
 * directory import with the same guarantees: bounded count/size/depth, no
 * deletion, idempotent re-import, and a revision notice that names the facts the
 * change affects instead of silently replacing their quotes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'trivium-p119-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const store = await import('../lib/store.js');
const evidence = await import('../lib/document-evidence.js');

let checks = 0;
let failures = 0;

async function check(label, fn) {
  checks += 1;
  try {
    await fn();
    console.log('ok ' + label);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}: ${error.message || error}`);
  } finally {
    try { store.closeAll(); } catch { /* closed */ }
  }
}

const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function workspace(name) {
  const cwd = join(root, name);
  const db = await store.openWorkspaceDb(cwd);
  return { db, cwd };
}

function plant(dir) {
  mkdirSync(join(dir, 'nested'), { recursive: true });
  mkdirSync(join(dir, '.hidden'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'a.md'), '# 发布说明\n\n灰度比例固定为 5%。\n', 'utf8');
  writeFileSync(join(dir, 'b.txt'), '备份保留 14 天。\n', 'utf8');
  writeFileSync(join(dir, 'nested', 'c.md'), '报表游标可以复用 24 小时。\n', 'utf8');
  writeFileSync(join(dir, '.hidden', 'secret.md'), '不应导入。\n', 'utf8');
  writeFileSync(join(dir, 'node_modules', 'dep.md'), '不应导入。\n', 'utf8');
  writeFileSync(join(dir, 'big.md'), '大文件。'.repeat(400), 'utf8');
  writeFileSync(join(dir, 'image.png'), 'not text', 'utf8');
}

try {
  await check('an explicit directory imports only text files and reports every skip', async () => {
    const { db, cwd } = await workspace('ws-import');
    const docs = join(cwd, 'docs');
    plant(docs);
    const result = evidence.importEvidenceDirectory(db, { dir: docs, limit: 8, maxFileBytes: 1024, maxDepth: 2 });
    assert(result.counts.added === 3, `added ${result.counts.added}`);
    const reasons = result.skipped.map((row) => `${row.path}:${row.reason}`);
    assert(reasons.includes('big.md:too-large'), `too-large missing: ${reasons}`);
    assert(reasons.some((row) => row.endsWith(':extension')), `extension missing: ${reasons}`);
    assert(reasons.some((row) => row.startsWith('.hidden')), `hidden dir missing: ${reasons}`);
    assert(reasons.some((row) => row.startsWith('node_modules')), `dependency dir missing: ${reasons}`);
    const listed = evidence.evidenceDocuments(db, { limit: 10 });
    assert(listed.length === 3, `documents ${listed.length}`);
  });

  await check('re-importing unchanged files changes nothing', async () => {
    const { db, cwd } = await workspace('ws-repeat');
    const docs = join(cwd, 'docs');
    plant(docs);
    evidence.importEvidenceDirectory(db, { dir: docs, limit: 8, maxFileBytes: 1024, maxDepth: 2 });
    const again = evidence.importEvidenceDirectory(db, { dir: docs, limit: 8, maxFileBytes: 1024, maxDepth: 2 });
    assert(again.counts.added === 0, `added ${again.counts.added}`);
    assert(again.counts.unchanged === 3, `unchanged ${again.counts.unchanged}`);
    assert(again.counts.updated === 0, `updated ${again.counts.updated}`);
  });

  await check('a changed file produces one revision and names the facts that need review', async () => {
    const { db, cwd } = await workspace('ws-revision');
    const docs = join(cwd, 'docs');
    plant(docs);
    evidence.importEvidenceDirectory(db, { dir: docs, limit: 8, maxFileBytes: 1024, maxDepth: 2 });
    const [document] = evidence.evidenceDocuments(db, { sourceId: 'a.md', limit: 1 });
    const factId = store.insertNode(db, { type: 'decision', name: '灰度比例', text: '灰度比例固定为 5%。' });
    evidence.attachDocumentEvidence(db, { factId, documentId: Number(document.documentId), revision: document.revision, quote: '灰度比例固定为 5%。' });
    writeFileSync(join(docs, 'a.md'), '# 发布说明\n\n灰度比例固定为 9%。\n', 'utf8');
    const result = evidence.importEvidenceDirectory(db, { dir: docs, limit: 8, maxFileBytes: 1024, maxDepth: 2 });
    assert(result.counts.updated === 1, `updated ${result.counts.updated}`);
    const notice = result.updated[0];
    assert(notice.sourceId === 'a.md', `notice source ${notice.sourceId}`);
    assert(notice.affectedFactIds.includes(factId), `affected ${JSON.stringify(notice.affectedFactIds)}`);
    assert(notice.revision && notice.revision !== document.revision, 'the revision did not change');
  });

  await check('a deleted file is not deleted from memory', async () => {
    const { db, cwd } = await workspace('ws-delete');
    const docs = join(cwd, 'docs');
    plant(docs);
    evidence.importEvidenceDirectory(db, { dir: docs, limit: 8, maxFileBytes: 1024, maxDepth: 2 });
    rmSync(join(docs, 'b.txt'));
    const result = evidence.importEvidenceDirectory(db, { dir: docs, limit: 8, maxFileBytes: 1024, maxDepth: 2 });
    assert(result.counts.unchanged === 2, `unchanged ${result.counts.unchanged}`);
    const listed = evidence.evidenceDocuments(db, { limit: 10 });
    assert(listed.length === 3, `documents ${listed.length}`);
    assert(listed.some((row) => row.sourceId === 'b.txt'), 'the deleted file lost its stored source');
  });

  await check('the import limit truncates instead of growing without bound', async () => {
    const { db, cwd } = await workspace('ws-limit');
    const docs = join(cwd, 'docs');
    plant(docs);
    const result = evidence.importEvidenceDirectory(db, { dir: docs, limit: 1, maxFileBytes: 1024, maxDepth: 2 });
    assert(result.counts.added === 1, `added ${result.counts.added}`);
    assert(result.skipped.some((row) => row.reason === 'limit'), `limit skip missing: ${JSON.stringify(result.skipped)}`);
  });

  await check('a missing or non-directory path is refused', async () => {
    const { db, cwd } = await workspace('ws-bad');
    let code = '';
    try { evidence.importEvidenceDirectory(db, { dir: join(cwd, 'nope') }); } catch (error) { code = error.code; }
    assert(code === 'DOCUMENT_DIRECTORY_NOT_FOUND', `missing dir returned ${code}`);
    code = '';
    writeFileSync(join(cwd, 'file.md'), 'x', 'utf8');
    try { evidence.importEvidenceDirectory(db, { dir: join(cwd, 'file.md') }); } catch (error) { code = error.code; }
    assert(code === 'DOCUMENT_INVALID', `file path returned ${code}`);
    code = '';
    try { evidence.importEvidenceDirectory(db, { dir: cwd, limit: 0 }); } catch (error) { code = error.code; }
    assert(code === 'DOCUMENT_INVALID', `bad limit returned ${code}`);
  });
} finally {
  try { store.closeAll(); } catch { /* closed */ }
  rmSync(root, { recursive: true, force: true });
}

console.log(`P119: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
