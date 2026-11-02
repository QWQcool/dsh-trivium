/**
 * p71 — punctuation, direction and result-state cases from the third re-review.
 *
 * The guards are split by scope on purpose: questions and meta requests are judged
 * on the whole sentence (a trailing "？" belongs to the sentence), while the
 * keep-as-is guard is per clause (an unrelated clause must not veto the
 * correction next to it). The direction of the cue decides which plan is being
 * replaced, and a result-state candidate ("本次上线使用方案 B") may retire it even
 * though it never restates the old plan.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p71-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}
const turn = (text) => ({ role: 'user', text, seq: 2, messageId: 'm2', at: '2026-11-02T09:00:00.000Z', recorded: true });
const one = (candidate) => async () => JSON.stringify({ candidates: [candidate] });

/** Seed A, run one sentence, report what was retired. */
async function run(dir, sentence, text, { supersedes } = {}) {
  const db = await store.openWorkspaceDb(join(root, dir));
  const a = store.insertNode(db, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });
  const candidate = { type: 'decision', name: '新上线决策', text, quote: sentence, ...(supersedes ? { supersedes } : {}) };
  await extract.distill({ db, turns: [turn(sentence)], sessionId: dir, llmCall: one(candidate) });
  const retiredA = store.currentHeadOf(db, a).id !== a;
  return retiredA;
}

try {
  // questions and meta requests never instruct
  await check(async () => assert.equal(await run('q1', '把方案 A 换成方案 B？', '改用方案 B'), false), 'a trailing question mark blocks retirement');
  await check(async () => assert.equal(await run('q2', '方案 A 要换成方案 B 吗？', '改用方案 B'), false), '"…吗？" blocks retirement');
  await check(
    async () => assert.equal(await run('q3', '请翻译下面的原文；“别用方案 A；改用方案 B。”', '改用方案 B'), false),
    'a quoted instruction being translated is not an instruction',
  );
  await check(
    async () => assert.equal(await run('q4', '请解释这段引文；“他说‘别用方案 A；改用方案 B’。”', '改用方案 B'), false),
    'a nested quotation does not become an instruction',
  );

  // a keep-as-is clause elsewhere in the sentence must not veto the correction
  await check(async () => assert.equal(await run('k1', '不再使用方案 A，改用方案 B，日志格式保持原样。', '改用方案 B'), true), 'a comma-separated keep clause does not veto');
  await check(async () => assert.equal(await run('k2', '不再使用方案 A，改用方案 B. 日志格式保持原样。', '改用方案 B'), true), 'an ASCII period separates the clauses');
  await check(async () => assert.equal(await run('k3', '不再使用方案 A，改用方案 B；日志格式保持原样。', '改用方案 B'), true), 'a semicolon keeps the correction');
  await check(
    async () => assert.equal(await run('k4', '不再使用方案 A，改用方案 B；日志格式保持原样。', '改用方案 B', { supersedes: '方案 A' }), true),
    'the explicit path applies the same clause scope',
  );

  // a result-state candidate retires the plan the sentence drops
  await check(
    async () => assert.equal(await run('r1', '不再使用方案 A，改用方案 B。', '本次上线使用方案 B'), true),
    'a result-state candidate still retires the replaced plan',
  );

  // a retraction later in the sentence wins
  await check(
    async () => assert.equal(await run('retract', '别用方案 A，刚才说错了，方案 A 继续使用。', '方案 A 继续使用'), false),
    'a later "continue using" retracts the retirement',
  );

  // the model may name the wrong side; the sentence still decides
  {
    const db = await store.openWorkspaceDb(join(root, 'dir'));
    const a = store.insertNode(db, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });
    const b = store.insertNode(db, { type: 'decision', name: '方案 B', text: '回滚预案使用方案 B' });
    const sentence = '不再使用方案 A，改用方案 B。';
    await extract.distill({
      db,
      turns: [turn(sentence)],
      sessionId: 'dir',
      llmCall: one({ type: 'decision', name: '新上线决策', text: '改用方案 B', quote: sentence, supersedes: '方案 B' }),
    });
    await check(() => assert.equal(store.currentHeadOf(db, b).id, b), 'naming the plan being switched to does not retire it');
    await check(() => assert.equal(store.currentHeadOf(db, a).id !== a, true), 'the plan the sentence drops is still retired');
    store.closeAll();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P71: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
