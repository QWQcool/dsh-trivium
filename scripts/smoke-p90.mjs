/**
 * p90 — the HTTP surface of the diagnostics contract.
 *
 * The status document is what the panel, the reviewer's scripts and any future
 * integration read; a regression there is invisible to the pure-library tests.
 * This pins the parts that were only ever checked by hand:
 *
 *   1. `/status` answers for a known workspace with the documented shape
 *      (`diagnosticsScope: "workspace"` and the four "last …" keys present,
 *      even when their value is null);
 *   2. a stored embedding key never travels back out — not in `/status`, not in
 *      the `/settings` response;
 *   3. an unknown `cwd` is answered explicitly instead of being silently
 *      replaced by the active workspace;
 *   4. the P-route list refuses an unknown workspace the same way.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p90-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const store = await import('../lib/store.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const ws = join(root, 'ws');
const db = await store.openWorkspaceDb(ws);
store.insertNode(db, { type: 'preference', name: 'pkg', text: '包管理器用 npm。' });

const SECRET = 'sk-p90-0123456789abcdef';
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ embeddingApiKey: SECRET, embeddingModel: 'stub' }), 'utf8');

const { registerMemoryApi } = await import('../lib/server.js');
const { createServer } = await import('node:http');
let handler = null;
registerMemoryApi({ webServer: { register(x) { handler = x.handler; return () => {}; } } }, { liveOptions: () => ({}), status: {} });
const server = createServer((req, res) => handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/dsh-trivium`;
const cwd = encodeURIComponent(ws);

try {
  let statusText = '';
  await check(async () => {
    const res = await fetch(`${base}/status?cwd=${cwd}`);
    statusText = await res.text();
    const body = JSON.parse(statusText);
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.diagnosticsScope, 'workspace');
    for (const key of ['lastExtract', 'lastScreen', 'lastMapInjection', 'mapInjections']) {
      assert.ok(Object.prototype.hasOwnProperty.call(body, key), `missing ${key}`);
    }
    assert.ok(body.version, 'the version is reported');
  }, 'GET /status answers with the documented shape');

  await check(() => assert.equal(statusText.includes(SECRET), false), 'the embedding key never appears in /status');

  await check(async () => {
    const res = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recallMode: 'off' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'embeddingApiKey') && body.embeddingApiKey, false, 'the key is not echoed back');
  }, 'POST /settings never echoes the stored key');

  await check(async () => {
    const res = await fetch(`${base}/status?cwd=${encodeURIComponent(join(root, 'nope'))}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.cwd, '', 'an unknown workspace is not silently replaced by the active one');
    assert.equal(body.nodeCount, 0);
  }, 'GET /status reports an unknown workspace as empty, not as the active one');

  await check(async () => {
    const res = await fetch(`${base}/supersede-proposals?cwd=${encodeURIComponent(join(root, 'nope'))}`);
    assert.equal(res.status, 400);
  }, 'GET /supersede-proposals refuses an unknown workspace');

  await check(async () => {
    const res = await fetch(`${base}/supersede-proposals?cwd=${cwd}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.proposals, []);
  }, 'GET /supersede-proposals answers an empty list for a known workspace');

  await check(async () => {
    const res = await fetch(`${base}/nodes?cwd=${cwd}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.nodes));
    assert.equal(JSON.stringify(body).includes(SECRET), false, 'the node list does not carry settings');
  }, 'GET /nodes stays a graph payload, not a settings dump');
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P90: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
