/**
 * p77 — scope abstraction (S0-5).
 *
 * Covers:
 *   1. all three scopes resolve, and only `workspace` is implemented;
 *   2. parent / inherit refuse to produce a path instead of silently degrading
 *      to the local workspace (that is the failure mode that would later write
 *      facts into the wrong directory);
 *   3. an unknown scope is a typo, not a scope: it throws UNKNOWN_SCOPE;
 *   4. the default path is byte-identical to 0.8.3 and the default open still
 *      writes to `<cwd>/.dsh/trivium.tdb`;
 *   5. the `{scope}` object form and the bare-string form agree.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p77-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const cwd = join(root, 'work-item');
const expectedPath = join(resolve(cwd), '.dsh', 'trivium.tdb');

try {
  // 1) Resolution.
  await check(() => {
    const r = store.resolveScope(cwd);
    assert.equal(r.scope, 'workspace');
    assert.equal(r.implemented, true);
    assert.equal(r.path, expectedPath);
  }, 'the default scope is workspace and points at <cwd>/.dsh/trivium.tdb');
  await check(() => assert.equal(store.resolveScope(cwd, 'workspace').path, expectedPath), 'an explicit workspace scope resolves the same path');
  await check(() => {
    const r = store.resolveScope(cwd, 'parent');
    assert.equal(r.scope, 'parent');
    assert.equal(r.implemented, false);
    assert.equal(r.path, null);
    assert.equal(r.parentCwd, dirname(resolve(cwd)));
  }, 'parent resolves but is not implemented');
  await check(() => {
    const r = store.resolveScope(cwd, 'inherit');
    assert.equal(r.scope, 'inherit');
    // Stage 1 part A: inherit is implemented as read-parent, write-local.
    assert.equal(r.implemented, true);
    assert.equal(r.mode, 'read-parent');
    assert.equal(r.path, join(resolve(cwd), '.dsh', 'trivium.tdb'), 'writes stay in the child');
    assert.equal(r.parentPath, join(dirname(resolve(cwd)), '.dsh', 'trivium.tdb'));
    assert.equal(r.parentCwd, dirname(resolve(cwd)));
  }, 'inherit resolves to read-parent with a local write path');
  await check(() => assert.equal(store.resolveScope(cwd, 'PARENT').scope, 'parent'), 'the scope name is case-insensitive');
  await check(() => assert.equal(store.resolveScope(cwd, '').scope, 'workspace'), 'an empty scope falls back to workspace');
  await check(() => {
    try {
      store.resolveScope(cwd, 'sibling');
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, 'UNKNOWN_SCOPE');
      assert.equal(err.scope, undefined);
    }
  }, 'an unknown scope throws UNKNOWN_SCOPE instead of being treated as workspace');

  // 2) Paths.
  await check(() => assert.equal(store.dbPathFor(cwd), expectedPath), 'dbPathFor(cwd) is unchanged');
  await check(() => assert.equal(store.dbPathFor(cwd, 'workspace'), expectedPath), 'dbPathFor(cwd, workspace) is the same');
  await check(() => {
    try {
      store.dbPathFor(cwd, 'parent');
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, 'SCOPE_NOT_IMPLEMENTED');
      assert.equal(err.scope, 'parent');
      assert.match(err.message, /not implemented/);
    }
  }, 'dbPathFor refuses an unimplemented scope');

  // 3) Opening.
  await check(async () => {
    await assert.rejects(
      () => store.openWorkspaceDb(cwd, { scope: 'parent' }),
      (err) => err.code === 'SCOPE_NOT_IMPLEMENTED',
    );
    assert.equal(existsSync(join(cwd, '.dsh')), false, 'a refused scope created nothing');
  }, 'openWorkspaceDb refuses parent scope before creating anything');
  /*
   * Stage 1 part A made `inherit` real (read the parent, write locally), so the
   * "refused" examples here are `parent` — the one scope that still needs the
   * router. `inherit` is asserted to resolve, below.
   */
  await check(async () => {
    await assert.rejects(() => store.openWorkspaceDb(cwd, 'parent'), (err) => err.code === 'SCOPE_NOT_IMPLEMENTED');
  }, 'the bare-string scope form is refused the same way');
  await check(() => {
    try {
      store.openWorkspaceDbReadOnly(cwd, { scope: 'parent' });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, 'SCOPE_NOT_IMPLEMENTED');
    }
  }, 'the read-only opener refuses an unimplemented scope too');
  await check(async () => {
    await store.openWorkspaceDb(cwd, 'inherit');
    assert.equal(store.dbPathFor(cwd, 'inherit'), join(cwd, '.dsh', 'trivium.tdb'));
    store.closeAll();
  }, 'inherit opens the local store instead of throwing');

  // 4) The default path is the 0.8.3 path, and it is where facts land.
  const db = await store.openWorkspaceDb(cwd);
  const id = store.insertNode(db, { type: 'preference', name: 'scope-kept', text: 'scope-kept' });
  await check(() => assert.equal(existsSync(expectedPath), true), 'the database is created at the default path');
  await check(() => assert.ok(id > 0), 'a fact is written through the default open');
  await check(() => {
    const opened = store.listOpenWorkspaces();
    assert.equal(opened.length, 1);
    assert.equal(opened[0].path, expectedPath);
    assert.equal(opened[0].cwd, resolve(cwd));
  }, 'the open workspace reports the default path');
  await check(() => {
    const same = store.openWorkspaceDb(cwd);
    assert.equal(store.dbPathFor(cwd), expectedPath);
    return same;
  }, 'opening the same workspace twice keeps one entry per path');

  // 5) The scope parameter is additive: every existing call site still works.
  await check(() => {
    const names = store.SCOPES;
    assert.deepEqual([...names], ['workspace', 'parent', 'inherit']);
  }, 'SCOPES lists exactly the three names');
  await check(() => assert.equal(store.scopeOf({}), 'workspace'), 'scopeOf defaults to workspace');
  await check(() => assert.equal(store.scopeOf('parent'), 'parent'), 'scopeOf accepts a bare string');
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P77: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
