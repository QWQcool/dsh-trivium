/**
 * p48 — a correction retires the decision it replaces.
 *
 * A-5 CORRECTION: "先别动方案 A" and "改用方案 B" were written as two independent
 * decisions, both stayed in the short map, and the model answered with the retired
 * one in 2 of 5 runs. An explicit replacement word now links the new decision to
 * the old one (new supersedes old), the old one leaves the map, and ctx_read can
 * still reach it. Ambiguity is reported instead of guessed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p48-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');
const rev = await import('../lib/revisions.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const one = (candidate) => async () => JSON.stringify({ candidates: [candidate] });

try {
  const db = await store.openWorkspaceDb(join(root, 'ws'));

  const first = await extract.distill({
    db,
    turns: [{ role: 'user', text: '先别动旧方案 A，我们还在评估。' }],
    sessionId: 'p48',
    llmCall: one({ type: 'decision', name: '方案 A', text: '先别动旧方案 A，我们还在评估。' }),
  });
  // The rule layer may write its own node for the same sentence, so locate the
  // model-written decision by text instead of trusting applied[0].
  const idOf = (needle) => db.allNodeIds().find((id) => String(db.get(id)?.payload?.text || '').includes(needle));
  const oldId = idOf('先别动旧方案 A');
  check(() => assert.ok(oldId), 'the first decision is written');

  const second = await extract.distill({
    db,
    turns: [{ role: 'user', text: '更正：不再使用旧方案 A，改用方案 B。' }],
    sessionId: 'p48',
    llmCall: one({ type: 'decision', name: '方案 B', text: '更正：不再使用旧方案 A，改用方案 B。' }),
  });
  const newId = idOf('不再使用旧方案 A');
  check(() => assert.ok(newId), 'the replacement decision is written');
  check(() => assert.ok(second.superseded.some((row) => row.to === oldId)), 'the replacement is linked to the old decision');
  check(() => assert.equal(rev.currentHeadOf(db, oldId).id, newId), 'the old decision now resolves to the new one');
  check(() => assert.equal(store.supersedesIn(db, oldId).length, 1), 'exactly one successor, no fork');

  const map = store.buildShortMapReport(db, 400).text;
  check(() => assert.doesNotMatch(map, /decision:方案 A/), 'the retired decision leaves the short map');
  check(() => assert.match(map, /decision:方案 B/), 'the current decision stays in the short map');
  check(() => assert.match(map, /decisions=1/), 'the map counts current decisions only');

  // A decision that merely continues the thread must not retire anything.
  const third = await extract.distill({
    db,
    turns: [{ role: 'user', text: '采用方案 C 作为备选。' }],
    sessionId: 'p48',
    llmCall: one({ type: 'decision', name: '方案 C', text: '采用方案 C 作为备选。' }),
  });
  check(() => assert.deepEqual(third.superseded, []), 'no replacement word, no retirement');

  // Two live decisions answering to the same label: report, do not guess.
  await extract.distill({
    db,
    turns: [{ role: 'user', text: '方案 D 暂时保留。' }],
    sessionId: 'p48',
    llmCall: one({ type: 'decision', name: '方案 D', text: '方案 D 暂时保留。' }),
  });
  await extract.distill({
    db,
    turns: [{ role: 'user', text: '方案 D 还有另一种用法。' }],
    sessionId: 'p48',
    llmCall: one({ type: 'decision', name: '方案 D', text: '方案 D 还有另一种用法。' }),
  });
  const chained = await extract.distill({
    db,
    turns: [{ role: 'user', text: '更正：不再使用方案 D。' }],
    sessionId: 'p48',
    llmCall: one({ type: 'decision', name: '方案 E', text: '更正：不再使用方案 D。' }),
  });
  const dIds = db.allNodeIds().filter((id) => {
    const payload = db.get(id)?.payload || {};
    const text = String(payload.text || '');
    return payload.type === 'decision' && text.includes('方案 D') && !text.includes('更正');
  });
  check(() => assert.ok(chained.superseded.length >= 2), 'two live labels for the same subject are all reported');
  check(() => assert.equal(chained.superseded.at(-1).chained >= 2, true), 'the chain length is reported');
  check(() => assert.equal(dIds.every((id) => store.supersedesIn(db, id).length === 1), true), 'each retired decision has exactly one successor');
  const headOfD = rev.currentHeadOf(db, dIds[0]);
  check(() => assert.equal(headOfD.ok !== false && headOfD.reason !== 'fork', true), 'the chain does not look like a fork');

  store.closeAll();
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P48: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
