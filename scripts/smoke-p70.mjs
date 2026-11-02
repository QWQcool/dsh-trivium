/**
 * p70 — the three blockers from the re-review of ca1e791.
 *
 * P1-1: a candidate that words itself as a replacement ("负责人改为张三") could
 *       authorise its own `supersedes` claim about a sentence that says nothing
 *       about replacing.
 * P1-2: a budget fact about the *new* plan retired it, because the plan name in
 *       the candidate was read as replacement intent.
 * P1-3: tightening rejection to the whole sentence made explicit corrections
 *       ("别用方案 A，改用方案 B") look like discussion, and let an unrelated
 *       clause ("日志格式沿用原样") veto the correction next to it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p70-'));
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
const turn = (text, seq = 2) => ({ role: 'user', text, seq, messageId: `m-${seq}`, at: '2026-11-02T09:00:00.000Z', recorded: true });
const one = (candidate) => async () => JSON.stringify({ candidates: [candidate] });
const edges = (db) => {
  const out = [];
  for (const id of db.allNodeIds()) for (const e of (db.get(id)?.edges || [])) if (String(e.label) === 'supersedes') out.push(`${id}->${e.targetId}`);
  return out;
};
async function seed(db) {
  return store.insertNode(db, { type: 'decision', name: '上线方案', text: '本次上线按方案 A 执行' });
}

try {
  // P1-1: the candidate cannot authorise its own claim
  for (const [label, named] of [['label', '方案 A'], ['deictic', '上一个方案']]) {
    const db = await store.openWorkspaceDb(join(root, `ws-self-${label}`));
    const oldId = await seed(db);
    const sentence = '发布负责人是张三。';
    const out = await extract.distill({
      db,
      turns: [turn(sentence)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '负责人', text: '发布负责人改为张三。', quote: sentence, supersedes: named }),
    });
    check(() => assert.equal(edges(db).length, 0), `a self-worded candidate cannot retire a decision (${label})`);
    check(() => assert.equal(store.currentHeadOf(db, oldId).id, oldId), `the head survives the self-worded claim (${label})`);
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'no-replacement-wording'), true), `the refusal is reported (${label})`);
    store.closeAll();
  }

  // P1-3: explicit corrections still retire
  for (const sentence of ['别用方案 A，改用方案 B。', '不要用方案 A，改用方案 B。']) {
    const db = await store.openWorkspaceDb(join(root, `ws-positive-${sentence.length}`));
    const oldId = await seed(db);
    await extract.distill({
      db,
      turns: [turn(sentence)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '改用方案 B', quote: sentence }),
    });
    check(() => assert.deepEqual(edges(db), [`${db.allNodeIds().at(-1)}->${oldId}`]), `"${sentence}" retires the old plan`);
    store.closeAll();
  }

  // P1-3b: an unrelated clause does not veto the correction
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-unrelated'));
    const oldId = await seed(db);
    const sentence = '别用方案 A 了，改用方案 B；日志格式沿用原样。';
    await extract.distill({
      db,
      turns: [turn(sentence)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '改用方案 B', quote: sentence }),
    });
    check(() => assert.equal(edges(db).length, 1), 'a keep-as-is clause elsewhere in the sentence does not veto');
    check(() => assert.equal(store.currentHeadOf(db, oldId).id !== oldId, true), 'the old plan is retired');
    store.closeAll();
  }

  /*
   * Documented limitation, asserted so it cannot drift silently: "还是回到最早的
   * 方案吧" carries no replacement wording, so the explicit claim is refused and
   * both decisions stay current. This is the old p65 input that used to retire.
   */
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-nowording'));
    const oldId = await seed(db);
    const out = await extract.distill({
      db,
      turns: [turn('还是回到最早的方案吧', 3)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '改回方案 A', quote: '还是回到最早的方案吧', supersedes: '方案 A' }),
    });
    check(() => assert.equal(edges(db).length, 0), 'a sentence without replacement wording retires nothing');
    check(() => assert.equal(store.currentHeadOf(db, oldId).id, oldId), 'and leaves the head alone');
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'no-replacement-wording'), true), 'the limitation is reported, not silent');
    store.closeAll();
  }

  // P1-2: a fact about the new plan does not retire it
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-budget'));
    const oldId = await seed(db);
    const sentence = '不再使用方案 A，改用方案 B；方案 B 的预算为 5000 元，必须由人工核验之后执行。';
    const out = await extract.distill({
      db,
      turns: [turn(sentence)],
      sessionId: 's',
      llmCall: async () => JSON.stringify({
        candidates: [
          { type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: sentence },
          { type: 'decision', name: '预算', text: '方案 B 的预算为 5000 元，必须由人工核验之后执行。', quote: sentence },
        ],
      }),
    });
    const nodes = db.allNodeIds().map((id) => ({ id, ...(db.get(id)?.payload || {}) }));
    const budget = nodes.find((p) => String(p.text || '').includes('5000'));
    const planB = nodes.find((p) => String(p.text || '') === '改用方案 B');
    check(() => assert.deepEqual(edges(db), [`${planB?.id}->${oldId}`]), 'only the correction creates an edge');
    check(() => assert.equal(store.currentHeadOf(db, planB.id).id, planB.id), 'the new plan stays current');
    check(() => assert.equal(store.currentHeadOf(db, budget.id).id, budget.id), 'the budget keeps its own head');
    const map = store.buildShortMapReport(db, 400).text;
    check(() => assert.match(map, /决策|decision/), 'the short map still lists current decisions');
    check(() => assert.equal(out.superseded.some((row) => row.to === budget.id), false), 'the budget is never reported as a retirement');
    store.closeAll();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P70: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
