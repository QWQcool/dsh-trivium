/**
 * p72 — the four attack cases from the fourth re-review.
 *
 * P1-1 a question in the middle of the sentence ("方案 A 换成方案 B 吗，请确认。")
 *      was treated as an instruction;
 * P1-2 reported speech without quotation marks ("他说别用方案 A 改用方案 B") and an
 *      explicitly unapproved plan authorised a retirement;
 * P1-3 "A 不再继续使用" was read as keeping A, and the explicit path ignored the
 *      retraction "A 继续使用";
 * P1-4 the candidate order decided the chain head: a budget fact listed first
 *      became the head and hid the plan.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p72-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}
const turn = (text) => ({ role: 'user', text, seq: 2, messageId: 'm2', at: '2026-11-02T09:00:00.000Z', recorded: true });

async function runOnce(dir, sentence, candidates) {
  const db = await store.openWorkspaceDb(join(root, dir));
  const a = store.insertNode(db, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });
  await extract.distill({
    db,
    turns: [turn(sentence)],
    sessionId: dir,
    llmCall: async () => JSON.stringify({ candidates }),
  });
  const retiredA = store.currentHeadOf(db, a).id !== a;
  const heads = db.allNodeIds().map((id) => ({ id, name: db.get(id)?.payload?.name, text: db.get(id)?.payload?.text }));
  const headOfA = store.currentHeadOf(db, a);
  const headNode = heads.find((row) => row.id === headOfA.id) || {};
  return { retiredA, heads, headOfA, headName: headNode.name };
}

try {
  for (const [label, sentence] of [
    ['mid-question', '方案 A 换成方案 B 吗，请确认。'],
    ['reported-speech', '他说别用方案 A 改用方案 B'],
    ['reported-unapproved', '他说别用方案 A 改用方案 B，但我还没有批准。'],
  ]) {
    const implicit = await runOnce(`${label}-implicit`, sentence, [{ type: 'decision', name: '新上线决策', text: '改用方案 B', quote: sentence }]);
    await check(() => assert.equal(implicit.retiredA, false), `${label}: the implicit path retires nothing`);
    const explicit = await runOnce(`${label}-explicit`, sentence, [{ type: 'decision', name: '新上线决策', text: '改用方案 B', quote: sentence, supersedes: '方案 A' }]);
    await check(() => assert.equal(explicit.retiredA, false), `${label}: the explicit path retires nothing either`);
  }

  const negatedKeep = '别用方案 A，改用方案 B，A 不再继续使用。';
  const nk = await runOnce('negated-keep', negatedKeep, [{ type: 'decision', name: '新上线决策', text: '改用方案 B', quote: negatedKeep }]);
  await check(() => assert.equal(nk.retiredA, true), '"A 不再继续使用" does not count as keeping it');

  const retraction = '别用方案 A，刚才说错了，方案 A 继续使用。';
  const ri = await runOnce('retraction-implicit', retraction, [{ type: 'decision', name: '新上线决策', text: '方案 A 继续使用', quote: retraction }]);
  await check(() => assert.equal(ri.retiredA, false), 'the implicit path honours the retraction');
  const re = await runOnce('retraction-explicit', retraction, [{ type: 'decision', name: '新上线决策', text: '方案 A 继续使用', quote: retraction, supersedes: '方案 A' }]);
  await check(() => assert.equal(re.retiredA, false), 'the explicit path honours the retraction too');

  // P1-4: the same two candidates in both orders must reach the same head
  const budgetSentence = '不再使用方案 A，改用方案 B；方案 B 的预算为 5000 元，必须由人工核验之后执行。';
  const plan = { type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: budgetSentence };
  const budget = { type: 'decision', name: '预算', text: '方案 B 的预算为 5000 元，必须由人工核验之后执行。', quote: budgetSentence };
  const planFirst = await runOnce('plan-first', budgetSentence, [plan, budget]);
  const budgetFirst = await runOnce('budget-first', budgetSentence, [budget, plan]);
  await check(() => assert.equal(planFirst.retiredA, true), 'plan-first retires the replaced plan');
  await check(() => assert.equal(budgetFirst.retiredA, true), 'budget-first retires it as well');
  await check(() => assert.equal(planFirst.headName, '上线方案 B'), 'plan-first leaves the plan as the head');
  await check(() => assert.equal(budgetFirst.headName, '上线方案 B'), 'budget-first leaves the same head');
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P72: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
