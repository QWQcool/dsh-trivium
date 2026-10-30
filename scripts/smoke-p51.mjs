/**
 * p51 (W2) — automatic supersession must be proven by the source sentence.
 *
 * Counterexamples come from docs/next-memory/evidence-write-provenance-plan/counterexamples.json
 * (F-W01a/F-W01b) plus the plan's list: questions, hypotheses, quotes, negated
 * replacements and "keep it as is" must not retire anything; several live nodes
 * with the same label must stay current and the new intent is marked for review.
 *
 * Written before the implementation.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p51-'));
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

const userTurn = (text, seq) => ({ role: 'user', text, seq, messageId: `m-${seq}`, at: '2026-10-30T07:00:00.000Z', recorded: true });
const one = (candidate) => async () => JSON.stringify({ candidates: [candidate] });

/** Seed "方案 A is current" exactly the way extraction does. */
async function seedPlanA(db, sentence = '先别动旧方案 A，我们还在评估。') {
  await extract.distill({
    db,
    turns: [userTurn(sentence, 1)],
    sessionId: 's1',
    llmCall: one({ type: 'decision', name: '方案 A', text: '先别动旧方案 A，我们还在评估。', quote: sentence }),
  });
  return db.allNodeIds().find((id) => String(db.get(id)?.payload?.text || '').includes('先别动旧方案 A'));
}
const hasSuccessor = (db, id) => store.supersedesIn(db, id).length > 0;

try {
  const db = await store.openWorkspaceDb(join(root, 'ws'));

  // 1. the real correction still works (kept from A-6)
  {
    const aId = await seedPlanA(db);
    const sentence = '更正：不再使用旧方案 A，改用方案 B。';
    await extract.distill({
      db,
      turns: [userTurn(sentence, 2)],
      sessionId: 's1',
      llmCall: one({ type: 'decision', name: '方案 B', text: '不再使用旧方案 A，改用方案 B。', quote: sentence }),
    });
    check(() => assert.equal(hasSuccessor(db, aId), true), 'an explicit replacement still retires the old decision');
  }

  // 2. F-W01a: discussing a replacement is not a replacement
  {
    const db2 = await store.openWorkspaceDb(join(root, 'ws-talk'));
    const aId = await seedPlanA(db2);
    const sentence = '我们只是讨论是否替换方案 A，尚未决定。';
    const out = await extract.distill({
      db: db2,
      turns: [userTurn(sentence, 3)],
      sessionId: 's2',
      llmCall: one({ type: 'decision', name: '方案 A 讨论', text: '讨论是否替换方案 A。', quote: sentence }),
    });
    check(() => assert.equal(hasSuccessor(db2, aId), false), 'discussion does not retire the decision');
    check(() => assert.deepEqual(out.superseded, []), 'discussion reports no supersession');
    store.closeAll();
  }

  // 3. F-W01b: retiring A must not retire B ("B stays as is")
  {
    const db3 = await store.openWorkspaceDb(join(root, 'ws-keep'));
    await extract.distill({
      db: db3,
      turns: [userTurn('方案 B 保持原样，先不动。', 4)],
      sessionId: 's3',
      llmCall: one({ type: 'decision', name: '方案 B', text: '方案 B 保持原样，先不动。', quote: '方案 B 保持原样，先不动。' }),
    });
    const bId = db3.allNodeIds().find((id) => String(db3.get(id)?.payload?.text || '').includes('方案 B'));
    const sentence = '不再使用方案 A；方案 B 保持原样。';
    await extract.distill({
      db: db3,
      turns: [userTurn(sentence, 5)],
      sessionId: 's3',
      llmCall: one({ type: 'decision', name: '停用方案 A', text: '不再使用方案 A。', quote: sentence }),
    });
    check(() => assert.equal(hasSuccessor(db3, bId), false), 'a decision that stays as is is not retired');
    store.closeAll();
  }

  // 4. negated replacement / hypothesis / third-party quote
  for (const [label, sentence] of [
    ['negated replacement', '不要替换方案 A，先留着。'],
    ['hypothesis', '假如换掉方案 A，会怎样？'],
    ['quoted document', '文档里提过要更换方案 A，但那是旧文档。'],
    ['question', '要不要把方案 A 换掉？'],
  ]) {
    const dbX = await store.openWorkspaceDb(join(root, `ws-${label.replace(/\s+/g, '-')}`));
    const aId = await seedPlanA(dbX);
    await extract.distill({
      db: dbX,
      turns: [userTurn(sentence, 6)],
      sessionId: 's4',
      llmCall: one({ type: 'decision', name: '方案 A 变更', text: '改用新方案，替换方案 A。', quote: sentence }),
    });
    check(() => assert.equal(hasSuccessor(dbX, aId), false), `${label} does not retire the decision`);
    store.closeAll();
  }

  // 5. a candidate whose quote is not in the source cannot retire anything
  {
    const db5 = await store.openWorkspaceDb(join(root, 'ws-nofake'));
    const aId = await seedPlanA(db5);
    await extract.distill({
      db: db5,
      turns: [userTurn('今天天气不错。', 7)],
      sessionId: 's5',
      llmCall: one({ type: 'decision', name: '方案 B', text: '更正：不再使用方案 A，改用方案 B。', quote: '更正：不再使用方案 A，改用方案 B。' }),
    });
    check(() => assert.equal(hasSuccessor(db5, aId), false), 'a model-invented quote cannot retire a decision');
    store.closeAll();
  }

  // 6. two live nodes with the same label: no chain, old ones stay current
  {
    const db6 = await store.openWorkspaceDb(join(root, 'ws-ambiguous'));
    await extract.distill({
      db: db6,
      turns: [userTurn('方案 D 暂时保留。', 8)],
      sessionId: 's6',
      llmCall: one({ type: 'decision', name: '方案 D', text: '方案 D 暂时保留。', quote: '方案 D 暂时保留。' }),
    });
    await extract.distill({
      db: db6,
      turns: [userTurn('方案 D 还有另一种用法。', 9)],
      sessionId: 's6',
      llmCall: one({ type: 'decision', name: '方案 D', text: '方案 D 还有另一种用法。', quote: '方案 D 还有另一种用法。' }),
    });
    const before = db6.allNodeIds().filter((id) => String(db6.get(id)?.payload?.text || '').includes('方案 D'));
    const sentence = '更正：不再使用方案 D。';
    const out = await extract.distill({
      db: db6,
      turns: [userTurn(sentence, 10)],
      sessionId: 's6',
      llmCall: one({ type: 'decision', name: '方案 E', text: '不再使用方案 D，改用方案 E。', quote: sentence }),
    });
    check(() => assert.equal(before.some((id) => hasSuccessor(db6, id)), false), 'ambiguous targets are not retired');
    check(() => assert.equal(out.superseded.every((row) => !row.to), true), 'no node id is chained for ambiguous targets');
    check(() => assert.equal(out.superseded.some((row) => row.pending === true), true), 'the ambiguous intent is reported as pending');
    const mapText = store.buildShortMapReport(db6, 400).text;
    check(() => assert.doesNotMatch(mapText, /decision:方案 E/), 'the unconfirmed new decision is not offered as current');
    store.closeAll();
  }

  // 7. same sentence twice is two events, not a silent dedupe
  {
    const db7 = await store.openWorkspaceDb(join(root, 'ws-dup'));
    const aId = await seedPlanA(db7);
    const sentence = '更正：不再使用方案 A，改用方案 B。';
    for (const seq of [11, 12]) {
      await extract.distill({
        db: db7,
        turns: [userTurn(sentence, seq)],
        sessionId: 's7',
        llmCall: one({ type: 'decision', name: `方案 B-${seq}`, text: '不再使用方案 A，改用方案 B。', quote: sentence }),
      });
    }
    check(() => assert.equal(rev.currentHeadOf(db7, aId).reason === 'fork', false), 'repeating the same correction does not fork the chain');
    store.closeAll();
  }
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P51: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
