/**
 * p65 (plan 3) — the extractor may name the decision it replaces.
 *
 * "上一个方案不要了，走新的" contains neither a replacement word nor a label, so
 * the cue-based path cannot see a replacement. The model can, but only as a
 * proposal: the write path still requires a real user turn, refuses discussions,
 * and insists on exactly one live target.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p65-'));
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
const turn = (text, seq) => ({ role: 'user', text, seq, messageId: `m-${seq}`, at: '2026-11-02T09:00:00.000Z', recorded: true });
const one = (candidate) => async () => JSON.stringify({ candidates: [candidate] });
const edgesOf = (db) => {
  const out = [];
  for (const id of db.allNodeIds()) {
    for (const edge of (db.get(id)?.edges || [])) if (String(edge.label) === 'supersedes') out.push(`${id}->${edge.targetId}`);
  }
  return out;
};
async function seed(db) {
  await extract.distill({
    db,
    turns: [turn('这次上线按方案 A 走', 1)],
    sessionId: 's',
    llmCall: one({ type: 'decision', name: '上线方案', text: '按方案 A 走', quote: '这次上线按方案 A 走' }),
  });
  return db.allNodeIds().filter((id) => db.get(id)?.payload?.type === 'decision')[0];
}

try {
  // 1. a spoken correction with no cue and no label still retires the old decision
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-1'));
    const oldId = await seed(db);
    const sentence = '上一个方案不要了，走新的';
    const out = await extract.distill({
      db,
      turns: [turn(sentence, 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '上线改走方案 B', quote: sentence, supersedes: '方案 A' }),
    });
    check(() => assert.deepEqual(edgesOf(db), [`${out.applied[0].id}->${oldId}`]), 'the named decision is retired');
    check(() => assert.equal(out.superseded.some((row) => row.to === oldId && row.via === 'model'), true), 'the link records that the model proposed it');
    store.closeAll();
  }

  // 2. naming something that is not a live decision retires nothing
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-2'));
    await seed(db);
    const sentence = '上一个方案不要了';
    const out = await extract.distill({
      db,
      turns: [turn(sentence, 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '上线改走方案 C', quote: sentence, supersedes: '方案 Z' }),
    });
    check(() => assert.equal(edgesOf(db).length, 0), 'an unknown target retires nothing');
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'supersedes-not-found'), true), 'the miss is reported');
    store.closeAll();
  }

  // 3. a discussion cannot be turned into a retirement by naming a target
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-3'));
    const oldId = await seed(db);
    const sentence = '我们还在讨论要不要换掉方案 A';
    const out = await extract.distill({
      db,
      turns: [turn(sentence, 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '改用方案 B', quote: sentence, supersedes: '方案 A' }),
    });
    check(() => assert.equal(edgesOf(db).length, 0), 'a discussion retires nothing even when the model names a target');
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'discussion-or-question'), true), 'the discussion is reported');
    store.closeAll();
  }

  // 4. no quote means no evidence, even with an explicit target
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-4'));
    await seed(db);
    const out = await extract.distill({
      db,
      turns: [turn('把方案的事情记一下。', 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '改用方案 B', supersedes: '方案 A' }),
    });
    check(() => assert.equal(edgesOf(db).length, 0), 'a claim without a quote retires nothing');
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'no-quote'), true), 'the missing quote is reported');
    store.closeAll();
  }

  // 5. an explicit target also prevents the merge that used to erase the old body
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-5'));
    const oldId = await seed(db);
    const sentence = '上一个方案不要了';
    const out = await extract.distill({
      db,
      turns: [turn(sentence, 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '按方案 A 走，不过已经作废，改为方案 B', quote: sentence, supersedes: '方案 A' }),
    });
    check(() => assert.equal(out.applied[0].action, 'insert'), 'the replacement is inserted instead of merged');
    check(() => assert.equal(db.get(oldId)?.payload?.text, '按方案 A 走'), 'the old body is still intact');
    store.closeAll();
  }

  // 6. a deictic phrase ("上一个方案") resolves when exactly one decision is live
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-6a'));
    const oldId = await seed(db);
    const sentence = '上一个方案不要了，走新的';
    const out = await extract.distill({
      db,
      turns: [turn(sentence, 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '上线改走方案 B', quote: sentence, supersedes: '上一个方案' }),
    });
    check(() => assert.deepEqual(edgesOf(db), [`${out.applied[0].id}->${oldId}`]), 'a deictic target resolves when it is the only live decision');
    check(() => assert.equal(out.superseded.some((row) => row.deictic === true), true), 'the deictic resolution is marked in the report');
    store.closeAll();
  }

  // 7. the same phrase is refused when two decisions are live
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-6b'));
    await seed(db);
    await extract.distill({
      db,
      turns: [turn('再记一个：回滚方案先不动。', 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '回滚方案', text: '回滚方案先不动', quote: '再记一个：回滚方案先不动。' }),
    });
    const before = edgesOf(db).length;
    const out = await extract.distill({
      db,
      turns: [turn('上一个方案不要了', 3)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '改走方案 B', quote: '上一个方案不要了', supersedes: '上一个方案' }),
    });
    check(() => assert.equal(edgesOf(db).length, before), 'a deictic target retires nothing when several decisions are live');
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'supersedes-ambiguous'), true), 'the ambiguity is reported');
    store.closeAll();
  }

  // 8. a target that is already replaced is not retired twice
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-6'));
    const oldId = await seed(db);
    await extract.distill({
      db,
      turns: [turn('上一个方案不要了', 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '改走方案 B', quote: '上一个方案不要了', supersedes: '方案 A' }),
    });
    const out = await extract.distill({
      db,
      // The sentence has to carry replacement wording, otherwise the reason would
      // be "no-replacement-wording" and this would stop testing the liveness rule.
      turns: [turn('更正：改回方案 A 吧', 3)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '更正：改回方案 A', quote: '更正：改回方案 A 吧', supersedes: '方案 A' }),
    });
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'supersedes-not-live'), true), 'an already replaced target is reported');
    check(() => assert.equal(edgesOf(db).filter((row) => row.endsWith(`->${oldId}`)).length, 1), 'the old decision still has exactly one successor');
    store.closeAll();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P65: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
