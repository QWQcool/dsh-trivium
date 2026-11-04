/**
 * p85 — the stage 1 switch, and the promise that "off means 0.8.3".
 *
 * `ROADMAP-AND-SUPERAGENT.md` §160 requires an escape hatch: scope inheritance and
 * the multi-writer router must be behind a switch that is **off by default**, and
 * with the switch off the plugin must behave exactly like 0.8.3.
 *
 * This test pins both directions:
 *
 *   1. no setting file → inheritance and the router refuse, with a code, before
 *      opening a handle or dialling a socket;
 *   2. `scopeInheritance: true` → both work;
 *   3. an explicit `allow` overrides the file in either direction (so a caller
 *      can force the switch without editing user settings);
 *   4. the default write path is unchanged: same file, same scope resolution.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p85-'));
process.env.DSH_HOME = join(root, 'home');
const settingsFile = join(root, 'settings.json');
process.env.DSH_TRIVIUM_SETTINGS = settingsFile;

const store = await import('../lib/store.js');
const settings = await import('../lib/settings.js');
const inherit = await import('../lib/inherit.js');
const { createRouterClient, startRouter } = await import('../lib/router.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const repo = join(root, 'repo');
const item = join(repo, 'item-1');
const setSwitch = (value) => writeFileSync(settingsFile, JSON.stringify(value === null ? {} : { scopeInheritance: value }), 'utf8');

try {
  // 1) Default: off.
  await check(() => assert.equal(settings.scopeInheritanceOf(), false), 'the switch is off when the key is missing');
  await check(() => assert.equal(settings.scopeInheritanceOf({ scopeInheritance: 'true' }), false), 'only a real boolean enables it');
  await check(async () => {
    const result = await inherit.readInheritedMap(item);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'disabled');
  }, 'inheritance is off by default');
  await check(async () => {
    await assert.rejects(() => startRouter({ cwd: repo }), (err) => err.code === 'SCOPE_DISABLED');
  }, 'the router refuses to start while the switch is off');
  await check(async () => {
    const client = createRouterClient({ cwd: repo });
    await assert.rejects(() => client.ready, (err) => err.code === 'SCOPE_DISABLED');
    await assert.rejects(() => client.writer.insert({ type: 'preference', name: 'x', text: 'x' }), (err) => err.code === 'SCOPE_DISABLED');
  }, 'a router client refuses while the switch is off');
  await check(() => assert.equal(existsSync(join(repo, '.dsh')), false), 'the refused paths created no directory');

  // 2) On.
  setSwitch(true);
  await check(() => assert.equal(settings.scopeInheritanceOf(), true), 'the switch reads the setting file');
  const router = await startRouter({ cwd: repo });
  try {
    const client = createRouterClient({ cwd: repo });
    await client.ready;
    const id = await client.writer.insert({ type: 'preference', name: 'switched', text: '记住：开关打开后可以写入。' });
    await check(() => assert.ok(Number.isFinite(id) && id > 0), 'the router writes once enabled');
    const applied = await client.apply([{ type: 'preference', name: 'switched', text: '记住：开关打开后可以写入。' }], { sessionId: 'p85' });
    await check(() => assert.equal(applied.length, 1), 'the apply operation works once enabled');
    const map = await client.map(200);
    await check(() => assert.equal(typeof map.text, 'string'), 'the map operation works once enabled');
    await client.close();
    const inherited = await inherit.readInheritedMap(item, { allow: true });
    await check(() => assert.equal(inherited.ok, true), `inheritance works once enabled (${inherited.reason || inherited.via})`);
    await check(() => assert.equal(inherited.via, 'router'), 'with a router running, the inherited map comes from it');
  } finally {
    await router.close();
    store.closeAll();
  }

  // 3) An explicit argument wins over the file, both ways.
  await check(async () => {
    const blocked = await inherit.readInheritedMap(item, { allow: false });
    assert.equal(blocked.reason, 'disabled');
  }, 'allow:false overrides an enabled file');
  await check(async () => {
    await assert.rejects(() => startRouter({ cwd: repo, allow: false }), (err) => err.code === 'SCOPE_DISABLED');
  }, 'the router honours an explicit refusal');
  setSwitch(null);
  await check(async () => {
    const forced = await startRouter({ cwd: repo, allow: true });
    await forced.close();
    // The router closed the handle it owned; drop the stale cache entry so the
    // default-path check below opens a live one.
    store.closeAll();
  }, 'allow:true overrides a missing setting');

  // 4) Off changes nothing about the default write path.
  await check(() => {
    const resolved = store.resolveScope(repo);
    assert.equal(resolved.scope, 'workspace');
    assert.equal(resolved.path, join(repo, '.dsh', 'trivium.tdb'));
    assert.equal(store.dbPathFor(repo), join(repo, '.dsh', 'trivium.tdb'));
  }, 'the default scope still resolves to the workspace library');
  await check(async () => {
    const db = await store.openWorkspaceDb(repo);
    const id = store.insertNode(db, { type: 'preference', name: 'plain', text: '记住：默认路径不受开关影响。' });
    store.closeAll();
    assert.ok(id > 0);
    assert.equal(existsSync(join(repo, '.dsh', 'trivium.tdb')), true, 'the fact landed in the workspace library');
  }, 'the default write path is unaffected by the switch');
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}

console.log(`P85: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
