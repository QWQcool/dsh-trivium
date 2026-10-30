/**
 * p44 — an empty extraction answer is a failure, not "nothing to store".
 *
 * A-2 evidence (real host + real model): the extraction call is capped by
 * maxTokens and a reasoning model can spend the whole budget thinking, ending
 * with stop_reason=max_tokens and no answer text. That blank answer used to look
 * like `{"candidates":[]}` to the plugin: the window was consumed and the pending
 * buffer cleared, so the fact was lost with no failure signal.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p44-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');
const { createExtractScheduler } = await import('../lib/extract-scheduler.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

// No preference/decision cue words, so the rule layer writes nothing and every
// node in this test comes from the model path under test.
const FACT_TEXT = '生产端口是 9443，项目负责人是张三。';
const turns = [{ role: 'user', text: FACT_TEXT }];

try {
  const cwd = join(root, 'ws');
  const db = await store.openWorkspaceDb(cwd);

  const blank = await extract.distill({ db, turns, sessionId: 'p44', llmCall: async () => '' });
  check(() => assert.equal(blank.llmFailed, true), 'blank model answer is a failure');
  check(() => assert.equal(blank.applied.length, 0), 'blank answer applies nothing');
  check(() => assert.equal(store.nodeCountOf(db), 1), 'blank answer leaves only the workspace node');

  const whitespace = await extract.distill({ db, turns, sessionId: 'p44', llmCall: async () => '  \n\t' });
  check(() => assert.equal(whitespace.llmFailed, true), 'whitespace-only answer is a failure too');

  const legit = await extract.distill({ db, turns, sessionId: 'p44', llmCall: async () => '{"candidates":[]}' });
  check(() => assert.equal(legit.llmFailed, false), 'explicit empty candidate list is not a failure');
  check(() => assert.equal(store.nodeCountOf(db), 1), 'explicit empty list applies nothing');

  // the scheduler keeps the window pending after a failed run
  const buf = { turns: turns.slice(), dirty: true };
  let persisted = null;
  const scheduler = createExtractScheduler({
    run: async (snapshot) => !(await extract.distill({ db, turns: snapshot, sessionId: 'p44', llmCall: async () => '' })).llmFailed,
    persist: async (b, reason) => {
      persisted = { turns: b.turns.length, reason: reason || null };
      await extract.savePending(cwd, { sessionId: 'p44', turns: b.turns });
    },
  });
  await extract.savePending(cwd, { sessionId: 'p44', turns });
  await scheduler.schedule(buf, {}, 'manual-test');
  scheduler.disposeAll();
  check(() => assert.equal(persisted?.reason, 'llm failed'), 'scheduler reports the failure');
  check(() => assert.equal(persisted?.turns, 1), 'scheduler keeps the turn for a later retry');
  check(() => assert.equal(extract.loadPending(cwd)?.turns?.length, 1), 'pending file still holds the fact');
  check(() => assert.match(extract.loadPending(cwd)?.turns?.[0]?.text || '', /9443/), 'pending text is the original fact');

  // a real answer still lands
  const ok = await extract.distill({
    db,
    turns,
    sessionId: 'p44',
    llmCall: async () => JSON.stringify({ candidates: [{ type: 'decision', name: '生产端口', text: '生产端口是 9443。' }] }),
  });
  check(() => assert.equal(ok.llmFailed, false), 'a real answer is a success');
  check(() => assert.equal(ok.applied.length, 1), 'a real answer is applied');
  const stored = db.allNodeIds().map((id) => String(db.get(id)?.payload?.text || '')).join('\n');
  check(() => assert.match(stored, /9443/), 'the fact is readable from the database');
  store.closeAll();
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P44: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
