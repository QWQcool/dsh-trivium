#!/usr/bin/env node
// Actual installed DSH Web host; offline package link and disposable libraries.
// Windows: node scripts/verify-memory-evidence-live.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

const repo = fileURLToPath(new URL('..', import.meta.url));
const defaultApp = join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness');
const app = process.env.DSH_ACCEPTANCE_APP || defaultApp;
const exe = join(app, 'DeepSeek Harness.exe');
const cli = join(app, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
assert.equal(process.platform, 'win32', 'This runner targets the installed Windows DSH host.');
assert.ok(existsSync(exe) && existsSync(join(app, 'resources', 'app.asar')), 'Point DSH_ACCEPTANCE_APP at an official installed DSH app.');
const temp = resolve(tmpdir());
const root = mkdtempSync(join(temp, 'trivium-host-memory-'));
const A = join(root, 'workspace-a');
const B = join(root, 'workspace-b');
const unopened = join(root, 'never-registered');
for (const dir of [A, B, unopened]) mkdirSync(dir);
for (const key of Object.keys(process.env)) {
  if (/^(?:DSH_|OPENAI_|DEEPSEEK_|ANTHROPIC_|GEMINI_|AZURE_OPENAI_)/i.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  DSH_HOME: join(root, 'home'),
  DSH_TRIVIUM_SETTINGS: join(root, 'settings.json'),
  COREPACK_ENABLE_NETWORK: '0',
  ELECTRON_RUN_AS_NODE: '1',
  npm_config_cache: join(root, 'npm-cache'),
  XDG_CACHE_HOME: join(root, 'xdg-cache'),
});
let host, base, checks = 0, hostVersion;
const launch = (args) => spawn(exe, ['--expose-internals', cli, ...args], {
  cwd: A, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
function monitor(child) {
  let output = '';
  const add = (part) => { output = (output + part).slice(-65536); };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  const ended = new Promise((done) => {
    child.once('error', (error) => done({ error }));
    child.once('close', (code) => done({ code }));
  });
  return { get output() { return output; }, ended };
}
async function runCommand(args, label) {
  const child = launch(args), active = monitor(child);
  const result = await Promise.race([active.ended, wait(20000, null, { ref: false })]);
  if (!result) { child.kill(); throw Error(label + ' timed out'); }
  if (result.error) throw result.error;
  assert.equal(result.code, 0, label + ' did not exit successfully');
  return active.output.trim();
}
async function start() {
  host = launch(['web', '--host', '127.0.0.1', '--no-open', '--port', '0']);
  const active = monitor(host);
  for (let i = 0; i < 100; i++) {
    if (host.exitCode !== null || host.signalCode !== null) throw Error('Real DSH Web host exited before startup.');
    const ready = /dsh web:\s*(http:\/\/127\.0\.0\.1:\d+)/.exec(active.output);
    if (ready) { base = ready[1]; return; }
    if (await Promise.race([active.ended.then(() => true), wait(100, false)])) throw Error('Real DSH Web host failed to start.');
  }
  throw Error('Real DSH Web host startup timed out.');
}
async function stop() {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  const ended = new Promise((done) => host.once('close', () => done(true)));
  host.kill();
  assert.equal(await Promise.race([ended, wait(4000, false, { ref: false })]), true, 'Could not close isolated DSH host');
}
async function api(path, cwd, { query = {}, body, status = 200 } = {}) {
  const url = new URL('/api/dsh-trivium/' + path, base);
  if (cwd !== undefined) url.searchParams.set('cwd', cwd);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const headers = { origin: base };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const result = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  const response = await result.json();
  assert.equal(result.status, status, path + ': ' + JSON.stringify(response).slice(0, 400));
  assert.equal(response.ok, status === 200, path + ': response envelope');
  checks++;
  return response;
}
const source = (row) => ({ sourceId: row.document.source_id, documentId: row.document.document_id, revision: row.document.revision });
const entityId = 101, fact = 201, second = 202;
const time = '2026-01-01T00:00:00.000Z';
const quote = '\u7d22\u5f15 Atlas fallback is manual.';
try {
  const { openWorkspaceDb, closeAll } = await import('../lib/store.js');
  try {
    for (const [workspace, label] of [[A, 'alpha'], [B, 'bravo']]) {
      const db = await openWorkspaceDb(workspace);
      const insert = (id, type, value) => db.insertWithId(id, Array(1536).fill(0), {
        type, name: label + ' ' + id, text: value, status: 'active', createdAt: time, updatedAt: time,
        uri: 'test:' + label + ':' + id,
      });
      insert(entityId, 'entity', label + ' task');
      insert(fact, 'decision', label + ' original decision');
      insert(second, 'decision', label + ' other decision');
      db.link(fact, entityId, 'about', 1);
      db.link(second, entityId, 'about', 1);
      db.flush();
    }
  } finally { closeAll(); }
  hostVersion = await runCommand(['--version'], 'dsh --version');
  assert.match(hostVersion, /^\d+\.\d+\.\d+/);
  await runCommand(['plugin', '--profile', 'web', 'add', 'link:' + repo.replaceAll('\\', '/'),
    '--offline', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store')], 'offline local install');

  const open = async (cwd) => assert.equal((await api('status', cwd)).dbHealth.state, 'ready');
  const task = (cwd, status = 200) => api('task-changes', cwd, { query: { entityId }, status });
  const mark = (cwd, viewRevision, status = 200) => api('task-changes', cwd, { body: { entityId, viewRevision }, status });
  await start();
  await task(undefined, 400);
  await task(unopened, 400);
  await task(B, 409);
  await open(A);
  await open(B);
  const initial = await task(A);
  assert.equal(initial.state, 'no_checkpoint');
  assert.equal((await task(A)).state, 'no_checkpoint', 'read must never mark viewed');
  await mark(A, initial.viewRevision);
  assert.equal((await task(A)).state, 'unchanged');
  assert.equal((await task(B)).state, 'no_checkpoint', 'same entity ID in other workspaces has its own checkpoint');
  const before = await task(A);
  await api('nodes/' + fact, A, { body: { text: 'alpha revised deployment decision' } });
  await mark(A, before.viewRevision, 409);
  const diff = await task(A);
  assert.equal(diff.state, 'changed');
  assert.ok(diff.changes.some(change => change.kind === 'updated' && Number(change.id) === fact));
  assert.doesNotMatch(JSON.stringify(diff), /bravo/);
  await api('nodes/' + second + '/archive', A, { body: {} });
  const archived = await task(A);
  assert.ok(archived.changes.some(change => change.kind === 'archived' && Number(change.id) === second));
  await mark(A, archived.viewRevision);

  const doc = 'document-evidence';
  const find = (cwd, sources, status = 200) => api(doc + '/search-sources', cwd, {
    body: { sources, query: 'Atlas fallback', limit: 8, budgetTokens: 600 }, status,
  });
  const add = (cwd, sourceId, content) => api(doc, cwd, { body: { action: 'save', sourceId, content } });
  const firstText = '# Atlas one\n\n' + quote + '\n\nUnrelated content.';
  const secondText = '# Atlas two\n\n' + quote + '\n\nDifferent appendix.';
  const known = await add(A, 'team-a/guide.md', firstText);
  const independent = await add(A, 'team-b/guide.md', secondText);
  const foreign = await add(B, 'other-workspace/guide.md', '# Atlas private\n\nAtlas fallback must never leak.');
  const selected = [source(known), source(independent)];
  const hits = await find(A, selected);
  for (const [choice, original] of [[selected[0], firstText], [selected[1], secondText]]) {
    const fragment = hits.fragments.find((item) => item.sourceId === choice.sourceId && item.text.includes(quote));
    assert.ok(fragment, choice.sourceId + ' has no matching original fragment');
    assert.equal(fragment.reference.document_id, choice.documentId);
    assert.equal(fragment.reference.revision, choice.revision);
    assert.equal(Buffer.from(original).subarray(fragment.reference.start_byte, fragment.reference.end_byte).toString('utf8'), fragment.text);
  }
  assert.equal(hits.context.includes('never leak'), false);
  await find(A, [source(foreign)], 404);
  const attach = (factId, document) => api(doc, A, { body: { action: 'attach', factId, documentId: Number(document.document.document_id),
    revision: document.document.revision, quote } });
  const attached = await attach(fact, known);
  const otherFact = await attach(second, known);
  const otherSource = await attach(fact, independent);
  assert.deepEqual(attached.reference, otherFact.reference);
  assert.notEqual(attached.evidenceId, otherFact.evidenceId);
  assert.notEqual(attached.reference.document_id, otherSource.reference.document_id);
  const grouped = await api(doc, A, { query: { groupCitations: 1 } });
  const groups = grouped.citationGroups.map(({ evidenceIds }) => evidenceIds.map(Number).sort((a, b) => a - b));
  assert.deepEqual(groups.sort((a, b) => a[0] - b[0]), [
    [Number(attached.evidenceId), Number(otherFact.evidenceId)], [Number(otherSource.evidenceId)],
  ], 'one page groups identical byte ranges but preserves an independent source');
  const picker = await api(doc, A, { query: { sourcesOnly: 1 } });
  assert.deepEqual(picker.documents.map(d => d.sourceId).sort(), selected.map(d => d.sourceId).sort());
  assert.equal(picker.links, undefined, 'the source picker should not fetch evidence links');
  await api(doc, A, { body: { action: 'save', sourceId: selected[0].sourceId, documentId: Number(selected[0].documentId),
    expectedRevision: selected[0].revision, content: firstText + '\n\nChanged.' } });
  await find(A, selected, 409);
  await stop();
  await start();
  await open(A);
  assert.equal((await task(A)).state, 'unchanged', 'seen checkpoint persists through actual host restart');
  console.log(JSON.stringify({ ok: true, hostVersion, transport: 'installed DSH Web, loopback HTTP',
    httpChecks: checks, taskCheckpoint: 'read/mark/update/archive/stale/cross-workspace/restart',
    documents: 'two named sources/UTF-8 ranges/foreign/stale/separate linked facts', modelRequests: 0,
    embeddingRequests: 0, browserUI: 'not driven' }, null, 2));
} finally {
  try { await stop(); } finally {
    if (dirname(resolve(root)) === temp && /^trivium-host-memory-[A-Za-z0-9]{6}$/.test(basename(root))) {
      rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    }
  }
}
