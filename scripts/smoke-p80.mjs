/**
 * p80 — stage 1 part A: read-only inheritance.
 *
 * The contract under test:
 *
 *   1. `inherit` resolves to a real description: parent path for reading, the
 *      child's own path for writing;
 *   2. the parent's short map can be read into a worker, within the same token
 *      budget the local map uses;
 *   3. reading never writes: the parent file is byte-identical and its mtime is
 *      unchanged, and no directory is created for a parent that has nothing;
 *   4. a missing or unreadable parent is a quiet "no context this turn", never
 *      an exception in the worker's own turn;
 *   5. writes stay local — inheritance adds context, it does not move the store;
 *   6. `parent` still refuses, and the default scope is untouched.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p80-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
// Stage 1 is behind a switch that defaults to off (p85 pins the default).
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ scopeInheritance: true }), 'utf8');

const store = await import('../lib/store.js');
const inherit = await import('../lib/inherit.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const hashOf = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// One level down, like a work item inside its repository checkout.
const parent = join(root, 'repo');
const child = join(parent, 'item-1');
const childElsewhere = join(root, 'lonely', 'item-2');
mkdirSync(child, { recursive: true });
mkdirSync(childElsewhere, { recursive: true });

try {
  // 1) Shape of the resolved scope.
  await check(() => {
    const resolved = store.resolveScope(child, 'inherit');
    assert.equal(resolved.implemented, true);
    assert.equal(resolved.mode, 'read-parent');
    assert.equal(resolved.cwd, child);
    assert.equal(resolved.parentCwd, parent);
    assert.equal(resolved.parentPath, join(parent, '.dsh', 'trivium.tdb'));
    assert.equal(resolved.path, join(child, '.dsh', 'trivium.tdb'), 'writes stay in the child');
  }, 'inherit resolves to read-parent with a local write path');
  await check(() => assert.equal(store.dbPathFor(child, 'inherit'), join(child, '.dsh', 'trivium.tdb')), 'dbPathFor(inherit) is the child store');
  await check(() => assert.throws(() => store.dbPathFor(child, 'parent'), (err) => err.code === 'SCOPE_NOT_IMPLEMENTED'), 'parent still refuses');
  await check(() => assert.throws(() => store.dbPathFor(child, 'nonsense'), (err) => err.code === 'UNKNOWN_SCOPE'), 'an unknown scope is still an error');

  // 2) No parent store yet: a quiet no-context, and nothing created.
  await check(async () => {
    const result = await inherit.readInheritedMap(child);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-parent-db');
    assert.equal(result.tokens, 0);
  }, 'a parent with no library returns no-parent-db');
  await check(() => assert.equal(existsSync(join(parent, '.dsh')), false), 'reading did not create the parent .dsh');
  await check(() => {
    const info = inherit.inheritedParent(child);
    assert.equal(info.available, false);
    assert.equal(info.parentCwd, parent);
  }, 'inheritedParent reports the missing library without throwing');

  // 3) The parent has facts: the worker can read them.
  const parentDb = await store.openWorkspaceDb(parent);
  store.insertNode(parentDb, { type: 'decision', name: 'deploy-window', text: 'deploy-window is Thursday' });
  store.insertNode(parentDb, { type: 'preference', name: 'pkg-manager', text: 'use pnpm everywhere' });
  store.closeAll();
  const parentFile = join(parent, '.dsh', 'trivium.tdb');
  const beforeHash = hashOf(parentFile);
  const beforeMtime = statSync(parentFile).mtimeMs;
  await check(() => assert.equal(inherit.inheritedParent(child).available, true), 'the parent library is reported as available');
  const inherited = await inherit.readInheritedMap(child, { budget: 400 });
  await check(() => assert.equal(inherited.ok, true), 'the parent map is readable');
  await check(() => assert.ok(inherited.text.includes('deploy-window')), `the parent map names its facts (${inherited.text.slice(0, 80)})`);
  await check(() => assert.ok(inherited.tokens > 0 && inherited.tokens <= 400), `the inherited map stays inside the budget (${inherited.tokens})`);
  await check(() => assert.equal(inherited.parentCwd, parent), 'the result names the parent it read');

  // 4) Reading is not writing.
  await check(() => assert.equal(hashOf(parentFile), beforeHash), 'the parent file is byte-identical after the read');
  await check(() => assert.equal(statSync(parentFile).mtimeMs, beforeMtime), 'the parent file mtime did not move');
  await check(() => assert.equal(existsSync(join(child, '.dsh')), false), 'reading the parent did not create the child store either');

  // 5) Writes still land in the child.
  const parentHandle = await store.openWorkspaceDb(parent);
  const beforeParentNodes = store.nodeCountOf(parentHandle);
  const childDb = await store.openWorkspaceDb(child, { scope: 'inherit' });
  store.insertNode(childDb, { type: 'preference', name: 'local-only', text: 'this belongs to the work item' });
  await check(() => assert.equal(store.nodeCountOf(childDb), 2), 'the child store holds its own fact plus the workspace root');
  await check(() => assert.equal(store.nodeCountOf(parentHandle), beforeParentNodes), 'the parent library did not grow');
  await check(() => assert.equal(store.dbPathFor(child, 'inherit'), join(child, '.dsh', 'trivium.tdb')), 'the write path is still the child');

  /*
   * 5b) A real, not injected, failure: this process already holds the parent
   * read-write (step 5), and the engine refuses a second handle. A worker only
   * reads the parent and writes its own store, so this does not happen in
   * production — but if it ever does, it must degrade, not throw into the turn.
   */
  await check(async () => {
    const conflicted = await inherit.readInheritedMap(child);
    assert.equal(conflicted.ok, false);
    assert.equal(conflicted.reason, 'unreadable');
    assert.equal(conflicted.tokens, 0);
  }, 'a parent already open in this process degrades instead of throwing');
  store.closeAll();

  // 6) A parent that cannot be opened is not an error for the worker.
  await check(async () => {
    const result = await inherit.readInheritedMap(child, {
      openReadOnly: () => { const err = new Error('TDB_ERROR: database is already opened'); throw err; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreadable');
    assert.equal(result.tokens, 0);
  }, 'an unreadable parent degrades to no context');

  // 7) A directory whose parent has nothing stored is still just no-context.
  await check(async () => {
    const result = await inherit.readInheritedMap(childElsewhere);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-parent-db');
  }, 'a sibling tree with no parent library degrades quietly');

  /*
   * 8) The budget is a real limit, not decoration — with a floor. The map always
   * prints its header line, so a budget below the header still costs ~41 tokens;
   * what a small budget buys is fewer entries, never fewer headers.
   */
  await check(async () => {
    const tiny = await inherit.readInheritedMap(child, { budget: 40 });
    assert.equal(tiny.ok, true);
    assert.ok(tiny.tokens < inherited.tokens, `a smaller budget reads less (${tiny.tokens} < ${inherited.tokens})`);
    assert.ok((tiny.entries || []).length <= (inherited.entries || []).length, 'a smaller budget never names more entries');
    assert.ok(tiny.tokens <= 60, `a tiny budget still pays the header floor (${tiny.tokens})`);
  }, 'a smaller budget is honoured down to the header floor');
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}

console.log(`P80: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
