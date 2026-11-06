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
import { mkdtempSync, rmSync , writeFileSync} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p70-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ supersedeMode: "auto" }), "utf8");
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
  /*
   * ---- merged from p71 (third review round) ----
   *
   * Kept in one file because the cases are the same guards seen from another
   * angle: punctuation and quotation decide whether a sentence is an
   * instruction; a keep-as-is clause is scoped per clause; a result-state
   * candidate may retire; a later retraction wins. Each block keeps its own
   * temp directory and its own async check so a slow `distill` cannot print
   * "ok" before the assertion ran.
   */
  await (async () => {
    const root71 = mkdtempSync(join(tmpdir(), 'trivium-p71-'));
    const check71 = async (fn, label) => {
      checks += 1;
      try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
    };
    const turn71 = (text) => ({ role: 'user', text, seq: 2, messageId: 'm2', at: '2026-11-02T09:00:00.000Z', recorded: true });
    const one71 = (candidate) => async () => JSON.stringify({ candidates: [candidate] });
    /** Seed A, run one sentence, report what was retired. */
    async function run(dir, sentence, text, { supersedes } = {}) {
      const db = await store.openWorkspaceDb(join(root71, dir));
      const a = store.insertNode(db, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });
      const candidate = { type: 'decision', name: '新上线决策', text, quote: sentence, ...(supersedes ? { supersedes } : {}) };
      await extract.distill({ db, turns: [turn71(sentence)], sessionId: dir, llmCall: one71(candidate) });
      return store.currentHeadOf(db, a).id !== a;
    }
    try {
      // questions and meta requests never instruct
      await check71(async () => assert.equal(await run('q1', '把方案 A 换成方案 B？', '改用方案 B'), false), 'a trailing question mark blocks retirement');
      await check71(async () => assert.equal(await run('q2', '方案 A 要换成方案 B 吗？', '改用方案 B'), false), '"…吗？" blocks retirement');
      await check71(
        async () => assert.equal(await run('q3', '请翻译下面的原文；“别用方案 A；改用方案 B。”', '改用方案 B'), false),
        'a quoted instruction being translated is not an instruction',
      );
      await check71(
        async () => assert.equal(await run('q4', '请解释这段引文；“他说‘别用方案 A；改用方案 B’。”', '改用方案 B'), false),
        'a nested quotation does not become an instruction',
      );

      // a keep-as-is clause elsewhere in the sentence must not veto the correction
      await check71(async () => assert.equal(await run('k1', '不再使用方案 A，改用方案 B，日志格式保持原样。', '改用方案 B'), true), 'a comma-separated keep clause does not veto');
      await check71(async () => assert.equal(await run('k2', '不再使用方案 A，改用方案 B. 日志格式保持原样。', '改用方案 B'), true), 'an ASCII period separates the clauses');
      await check71(async () => assert.equal(await run('k3', '不再使用方案 A，改用方案 B；日志格式保持原样。', '改用方案 B'), true), 'a semicolon keeps the correction');
      await check71(
        async () => assert.equal(await run('k4', '不再使用方案 A，改用方案 B；日志格式保持原样。', '改用方案 B', { supersedes: '方案 A' }), true),
        'the explicit path applies the same clause scope',
      );

      // a result-state candidate retires the plan the sentence drops
      await check71(
        async () => assert.equal(await run('r1', '不再使用方案 A，改用方案 B。', '本次上线使用方案 B'), true),
        'a result-state candidate still retires the replaced plan',
      );

      // a retraction later in the sentence wins
      await check71(
        async () => assert.equal(await run('retract', '别用方案 A，刚才说错了，方案 A 继续使用。', '方案 A 继续使用'), false),
        'a later "continue using" retracts the retirement',
      );

      // the model may name the wrong side; the sentence still decides
      {
        const db = await store.openWorkspaceDb(join(root71, 'dir'));
        const a = store.insertNode(db, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });
        const b = store.insertNode(db, { type: 'decision', name: '方案 B', text: '回滚预案使用方案 B' });
        const sentence = '不再使用方案 A，改用方案 B。';
        await extract.distill({
          db,
          turns: [turn71(sentence)],
          sessionId: 'dir',
          llmCall: one71({ type: 'decision', name: '新上线决策', text: '改用方案 B', quote: sentence, supersedes: '方案 B' }),
        });
        await check71(() => assert.equal(store.currentHeadOf(db, b).id, b), 'naming the plan being switched to does not retire it');
        await check71(() => assert.equal(store.currentHeadOf(db, a).id !== a, true), 'the plan the sentence drops is still retired');
      }
    } finally {
      store.closeAll();
      rmSync(root71, { recursive: true, force: true });
    }
  })();

  /* ---- merged from p72 (fourth review round) ---- */
  await (async () => {
    const root72 = mkdtempSync(join(tmpdir(), 'trivium-p72-'));
    const check72 = (fn, label) => {
      checks += 1;
      try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
    };
    const turn72 = (text) => ({ role: 'user', text, seq: 2, messageId: 'm2', at: '2026-11-02T09:00:00.000Z', recorded: true });
    async function runOnce(dir, sentence, candidates) {
      const db = await store.openWorkspaceDb(join(root72, dir));
      const a = store.insertNode(db, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });
      await extract.distill({
        db,
        turns: [turn72(sentence)],
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
        await check72(() => assert.equal(implicit.retiredA, false), `${label}: the implicit path retires nothing`);
        const explicit = await runOnce(`${label}-explicit`, sentence, [{ type: 'decision', name: '新上线决策', text: '改用方案 B', quote: sentence, supersedes: '方案 A' }]);
        await check72(() => assert.equal(explicit.retiredA, false), `${label}: the explicit path retires nothing either`);
      }

      const negatedKeep = '别用方案 A，改用方案 B，A 不再继续使用。';
      const nk = await runOnce('negated-keep', negatedKeep, [{ type: 'decision', name: '新上线决策', text: '改用方案 B', quote: negatedKeep }]);
      await check72(() => assert.equal(nk.retiredA, true), '"A 不再继续使用" does not count as keeping it');

      const retraction = '别用方案 A，刚才说错了，方案 A 继续使用。';
      const ri = await runOnce('retraction-implicit', retraction, [{ type: 'decision', name: '新上线决策', text: '方案 A 继续使用', quote: retraction }]);
      await check72(() => assert.equal(ri.retiredA, false), 'the implicit path honours the retraction');
      const re = await runOnce('retraction-explicit', retraction, [{ type: 'decision', name: '新上线决策', text: '方案 A 继续使用', quote: retraction, supersedes: '方案 A' }]);
      await check72(() => assert.equal(re.retiredA, false), 'the explicit path honours the retraction too');

      // P1-4: the same two candidates in both orders must reach the same head
      const budgetSentence = '不再使用方案 A，改用方案 B；方案 B 的预算为 5000 元，必须由人工核验之后执行。';
      const plan = { type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: budgetSentence };
      const budget = { type: 'decision', name: '预算', text: '方案 B 的预算为 5000 元，必须由人工核验之后执行。', quote: budgetSentence };
      const planFirst = await runOnce('plan-first', budgetSentence, [plan, budget]);
      const budgetFirst = await runOnce('budget-first', budgetSentence, [budget, plan]);
      await check72(() => assert.equal(planFirst.retiredA, true), 'plan-first retires the replaced plan');
      await check72(() => assert.equal(budgetFirst.retiredA, true), 'budget-first retires it as well');
      await check72(() => assert.equal(planFirst.headName, '上线方案 B'), 'plan-first leaves the plan as the head');
      await check72(() => assert.equal(budgetFirst.headName, '上线方案 B'), 'budget-first leaves the same head');
    } finally {
      store.closeAll();
      rmSync(root72, { recursive: true, force: true });
    }
  })();
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P70: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
