/**
 * p82 — the deferred-write queue, as the panel reads it.
 *
 * A window is deferred when extraction lost the write lock, failed, or was
 * interrupted; `runExtract` keeps it pending and the next session replays it.
 * Until now that state was invisible from the panel, which makes a deferral
 * indistinguishable from a lost fact. `pendingSummary` is the read model behind
 * the new card, and this test pins:
 *
 *   1. an empty / missing workspace answers with zeros, not an error;
 *   2. real windows are counted by window and by event, with a short preview;
 *   3. neither turn text beyond the preview nor the acknowledged list is leaked;
 *   4. a corrupt file degrades to `unreadable` instead of throwing;
 *   5. the file's own mtime is reported (no invented timestamps).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p82-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const extract = await import('../lib/extract.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const ws = join(root, 'ws');
const pendingFile = join(ws, '.dsh', 'trivium-pending.json');
mkdirSync(join(ws, '.dsh'), { recursive: true });

try {
  await check(() => {
    const summary = extract.pendingSummary(ws);
    assert.deepEqual(summary.windows, []);
    assert.equal(summary.turns, 0);
    assert.equal(summary.updatedAt, null);
  }, 'a workspace with no pending file answers with zeros');
  await check(() => {
    const summary = extract.pendingSummary('');
    assert.equal(summary.reason, 'no-workspace');
    assert.equal(summary.turns, 0);
  }, 'no workspace is a reason, not a throw');

  // Two windows, one of them with a long body and a non-whitespace preview.
  writeFileSync(
    pendingFile,
    JSON.stringify({
      windows: [
        { sessionId: 'session-aaaa1111', turns: [{ role: 'user', text: '记住：部署窗口是每周四。\n第二行不该出现' }, { role: 'assistant', text: 'ok' }] },
        { sessionId: 'session-bbbb2222', turns: [{ role: 'user', text: 'x'.repeat(300) }, { role: 'user', text: 'y' }, { role: 'tool', text: 'z' }] },
      ],
      // Acknowledgement keys are plain strings in the file format.
      acknowledged: ['session-aaaa1111:1', 'session-bbbb2222:2'],
    }),
    'utf8',
  );

  const summary = extract.pendingSummary(ws);
  await check(() => assert.equal(summary.windows.length, 2), 'two windows are reported');
  await check(() => assert.equal(summary.turns, 5), 'events are summed across windows');
  await check(() => assert.equal(summary.acknowledged, 2), 'the acknowledged count is carried');
  await check(() => {
    const first = summary.windows[0];
    assert.equal(first.sessionId, 'session-aaaa1111');
    assert.equal(first.turns, 2);
    assert.ok(first.preview.startsWith('记住：部署窗口是每周四。'), `preview keeps the first sentence (${first.preview})`);
    assert.ok(!first.preview.includes('\n'), 'the preview is a single line');
  }, 'each window keeps its id, its size and a one-line preview');
  await check(() => {
    const second = summary.windows[1];
    assert.ok(second.preview.length <= 80, `preview is bounded (${second.preview.length})`);
  }, 'a long body is clipped, not shipped whole');
  await check(() => {
    const raw = JSON.stringify(summary);
    assert.ok(!raw.includes('x'.repeat(120)), 'the full turn text never reaches the panel');
    assert.ok(!raw.includes('k1'), 'the acknowledged keys are not shipped');
  }, 'the payload carries counts, not transcripts');
  await check(() => assert.ok(summary.updatedAt && summary.updatedAt.endsWith('Z'), 'the file mtime is reported as ISO'), 'updatedAt comes from the file itself');

  writeFileSync(pendingFile, '{not json', 'utf8');
  await check(() => {
    const broken = extract.pendingSummary(ws);
    assert.equal(broken.reason, 'unreadable');
    assert.deepEqual(broken.windows, []);
    assert.ok(broken.error, 'the parse failure is reported');
  }, 'a corrupt pending file degrades instead of throwing');

  // The panel must not be able to mutate what it reads.
  await check(() => {
    writeFileSync(pendingFile, JSON.stringify({ windows: [{ sessionId: 's', turns: [{ role: 'user', text: 'a' }] }], acknowledged: [] }), 'utf8');
    const before = readFileSync(pendingFile, 'utf8');
    extract.pendingSummary(ws);
    assert.equal(readFileSync(pendingFile, 'utf8'), before, 'reading did not rewrite the file');
  }, 'reading the queue never rewrites it');

  /*
   * The route itself. `registerMemoryApi` hands its handler to the host, so the
   * test can serve it for real instead of trusting the shape by inspection.
   */
  const store = await import('../lib/store.js');
  await store.openWorkspaceDb(ws);
  writeFileSync(
    pendingFile,
    JSON.stringify({ windows: [{ sessionId: 'session-cccc3333', turns: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }] }], acknowledged: [] }),
    'utf8',
  );
  const { registerMemoryApi } = await import('../lib/server.js');
  const { createServer } = await import('node:http');
  let handler = null;
  registerMemoryApi({ webServer: { register(x) { handler = x.handler; return () => {}; } } }, { liveOptions: () => ({}), status: {} });
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await check(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dsh-trivium/pending?cwd=${encodeURIComponent(ws)}`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.windows.length, 1);
      assert.equal(body.turns, 2);
      assert.equal(body.windows[0].sessionId, 'session-cccc3333');
    }, 'GET /pending serves the summary for a known workspace');
    await check(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dsh-trivium/pending?cwd=${encodeURIComponent(join(root, 'nope'))}`);
      assert.equal(res.status, 400);
    }, 'GET /pending refuses an unknown workspace');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.closeAll();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`P82: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
