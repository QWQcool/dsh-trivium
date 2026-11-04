/**
 * p84 — stage 1 acceptance: three workers on one repository.
 *
 * The roadmap's acceptance for stage 1 is "三个 Worker 并行处理同一仓库，事实不重复、
 * 不丢、短地图不串味". This test builds that shape without a Super-agent: three real
 * child processes, each in its own work-item directory under one repository, with
 * the repository's library owned by a single router.
 *
 * What has to hold:
 *
 *   1. every worker can read the parent's map (through the router, which owns the
 *      only database handle — a second handle is what the engine refuses);
 *   2. a fact two workers both report is stored **once**, whichever order they
 *      arrive in — the duplicate decision needs the database, so it must happen
 *      in the router, not in the worker;
 *   3. nothing is lost: every distinct fact lands;
 *   4. no worker creates its own library: the work-item directory stays clean;
 *   5. an `inherit` read of a *different* parent does not leak the repository's
 *      facts (the map is scoped to the library it was built from).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKER_FLAG = '--worker';

/** Child: read the inherited map, then send two candidates to the router. */
async function runWorker(repo, itemDir, label) {
  const { createRouterClient } = await import('../lib/router.js');
  const { readInheritedMap } = await import('../lib/inherit.js');

  const client = createRouterClient({ cwd: repo });
  await client.ready;

  let localRead = null;
  try {
    const inherited = await readInheritedMap(itemDir, { budget: 400 });
    localRead = { ok: inherited.ok, via: inherited.via || null, reason: inherited.reason || null };
  } catch (err) {
    localRead = { ok: false, reason: 'threw:' + String(err?.message || err).slice(0, 60) };
  }

  const map = await client.map(400);
  const applied = await client.apply(
    [
      // The same sentence from all three workers: one fact, not three.
      { type: 'decision', name: '发布窗口', text: '发布窗口固定在每周四晚上。' },
      // One fact per worker. The cue matters: without it the candidate pipeline
      // drops the line as "not a stated fact", which is the product rule, not a
      // batching problem.
      { type: 'preference', name: `${label}-only`, text: `记住：${label} 只在自己的目录里提交代码。` },
    ],
    { sessionId: label, via: 'router' },
  );
  await client.close();
  process.stdout.write(
    `${JSON.stringify({
      label,
      localRead,
      mapTokens: map.tokens,
      mapHasBaseline: String(map.text || '').includes('鉴权'),
      applied: applied.length,
      ids: applied.map((row) => row.id),
      actions: applied.map((row) => row.action),
    })}\n`,
  );
}

function spawnWorker(repo, itemDir, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, WORKER_FLAG, repo, itemDir, label], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`worker ${label} exited ${code}: ${err.slice(0, 500)}`));
        return;
      }
      resolve(out.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    });
  });
}

if (process.argv[2] === WORKER_FLAG) {
  const [, , , repo, itemDir, label] = process.argv;
  await runWorker(repo, itemDir, label);
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'trivium-p84-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
// Both the router and the inherited read sit behind the stage 1 switch; the
// children inherit this env var and therefore the same setting (p85 pins the off
// default).
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ scopeInheritance: true }), 'utf8');

const store = await import('../lib/store.js');
const { startRouter } = await import('../lib/router.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const repo = join(root, 'repo');
const items = ['item-1', 'item-2', 'item-3'].map((name) => join(repo, name));
mkdirSync(repo, { recursive: true });
for (const dir of items) mkdirSync(dir, { recursive: true });

// The repository's own library, on disk before any worker starts.
const seed = await store.openWorkspaceDb(repo);
store.insertNode(seed, { type: 'entity', name: '鉴权方式', text: '本仓库鉴权走 header X。' });
store.insertNode(seed, { type: 'preference', name: '包管理器', text: '本仓库用 npm，不用 pnpm。' });
store.closeAll();

const router = await startRouter({ cwd: repo });
let rows;
try {
  const runs = items.map((dir, index) => spawnWorker(repo, dir, `w${index + 1}`));
  rows = (await Promise.all(runs)).flat();
} finally {
  await router.close();
  // The router reached the database through the store cache; drop the closed
  // handle before the assertions open their own.
  store.closeAll();
}

try {
  await check(() => assert.equal(rows.length, 3), 'all three workers ran');

  // 1) The inherited map is readable in every worker and carries the baseline.
  await check(() => assert.ok(rows.every((row) => row.mapHasBaseline), `a worker missed the baseline (${JSON.stringify(rows.map((r) => r.mapTokens))})`), 'every worker sees the baseline facts');
  await check(() => assert.ok(rows.every((row) => row.mapTokens > 0)), 'the inherited map is empty');
  /*
   * The engine refuses a second handle, so in this shape the file path is closed
   * and `readInheritedMap` has to answer through the router. Measured, not
   * assumed: the assertion is on `via`, and the raw reasons are printed.
   */
  console.log('   inherit path per worker: ' + JSON.stringify(rows.map((r) => r.localRead)));
  await check(() => assert.ok(rows.every((row) => row.localRead && row.localRead.ok)), 'inherit failed for a worker');
  await check(() => assert.ok(rows.every((row) => row.localRead.via === 'router')), `a worker did not read through the router (${JSON.stringify(rows.map((r) => r.localRead.via))})`);

  // 2) + 3) The shared fact is stored once; every distinct fact lands.
  const db = await store.openWorkspaceDb(repo);
  const decisions = store.findByType(db, 'decision').filter((row) => String(row.payload?.name || '') === '发布窗口');
  await check(() => assert.equal(decisions.length, 1), `the shared fact was stored ${decisions.length} times`);
  const preferences = store.findByType(db, 'preference');
  const own = preferences.filter((row) => String(row.payload?.name || '').endsWith('-only'));
  await check(() => assert.equal(own.length, 3), `each worker's own fact landed (${own.length}/3)`);
  await check(() => assert.equal(preferences.filter((row) => String(row.payload?.name || '') === '包管理器').length, 1), 'the seeded fact was not duplicated');

  // 4) No worker created its own library.
  await check(() => assert.equal(items.filter((dir) => existsSync(join(dir, '.dsh', 'trivium.tdb'))).length, 0), 'a work-item directory created its own library');

  // 5) The applied report matches what is on disk.
  const shared = rows.flatMap((row) => row.actions);
  await check(() => assert.equal(shared.filter((action) => action === 'insert').length, 4), `expected 4 inserts (1 shared + 3 own), got ${shared.filter((a) => a === 'insert').length}`);
  await check(() => assert.equal(shared.filter((action) => action === 'merge').length, 2), `expected 2 merges of the shared fact, got ${shared.filter((a) => a === 'merge').length}`);
  await check(() => {
    const allIds = new Set(rows.flatMap((row) => row.ids));
    assert.equal(allIds.size, 4, `four distinct ids expected, got ${allIds.size}`);
  }, 'the workers were told about four distinct nodes');

  store.closeAll();

  // 6) A worker outside this repository inherits nothing from it.
  const other = join(root, 'other-repo', 'item-x');
  mkdirSync(other, { recursive: true });
  const { readInheritedMap } = await import('../lib/inherit.js');
  const stray = await readInheritedMap(other);
  await check(() => assert.equal(stray.ok, false), 'an unrelated directory inherited a library');
  await check(() => assert.equal(stray.reason, 'no-parent-db'), `unexpected reason ${stray.reason}`);
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}

console.log(`P84: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
