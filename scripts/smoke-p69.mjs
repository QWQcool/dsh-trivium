/**
 * p69 — the five blockers from the independent 0.8.3 review (R-01..R-05).
 *
 * Every case here was first reported as a counterexample against 2c77f58 and
 * passed at the time: a claim of "replacement" retired a decision the sentence
 * never mentioned, a quoted or negated replacement word retired one anyway, a
 * sequence-number collision merged across sessions, two facts in one sentence
 * collapsed into a chain, and a revision-linked node threw REVISION_PROTECTED.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p69-'));
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
const turn = (text, seq = 2, extra = {}) => ({ role: 'user', text, seq, messageId: `m-${seq}`, at: '2026-11-02T09:00:00.000Z', recorded: true, ...extra });
const one = (candidate) => async () => JSON.stringify({ candidates: [candidate] });
const edges = (db) => {
  const out = [];
  for (const id of db.allNodeIds()) for (const e of (db.get(id)?.edges || [])) if (String(e.label) === 'supersedes') out.push(`${id}->${e.targetId}`);
  return out;
};
async function seed(db, text = '本次上线按方案 A 执行', extra = {}) {
  return store.insertNode(db, { type: 'decision', name: '上线方案', text, ...extra });
}

try {
  // R-01: a supersedes claim the sentence does not back retires nothing
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-r01'));
    const oldId = await seed(db);
    const sentence = '发布负责人是张三。';
    const out = await extract.distill({
      db,
      turns: [turn(sentence)],
      sessionId: 'new',
      llmCall: one({ type: 'decision', name: '负责人', text: '发布负责人是张三。', quote: sentence, supersedes: '方案 A' }),
    });
    check(() => assert.equal(edges(db).length, 0), 'a claim without replacement wording retires nothing');
    check(() => assert.equal(store.currentHeadOf(db, oldId).id, oldId), 'the old decision is still current');
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'no-replacement-wording'), true), 'the reason is reported');
    store.closeAll();
  }

  // R-01b: a deictic name is not wording either
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-r01b'));
    const oldId = await seed(db);
    const sentence = '发布负责人是张三。';
    await extract.distill({
      db,
      turns: [turn(sentence)],
      sessionId: 'new',
      llmCall: one({ type: 'decision', name: '负责人', text: '发布负责人是张三。', quote: sentence, supersedes: '上一个方案' }),
    });
    check(() => assert.equal(edges(db).length, 0), 'a deictic name alone does not authorise a retirement');
    check(() => assert.equal(store.currentHeadOf(db, oldId).id, oldId), 'and the head stays put');
    store.closeAll();
  }

  // R-02: negated and quoted replacement words retire nothing
  for (const [label, sentence] of [
    ['negated', '不要换掉方案 A，继续沿用。'],
    ['quoted', '请把“换掉方案 A”这句话翻译成英文。'],
  ]) {
    const db = await store.openWorkspaceDb(join(root, `ws-r02-${label}`));
    const oldId = await seed(db);
    await extract.distill({
      db,
      turns: [turn(sentence)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '改用方案 B', quote: sentence }),
    });
    check(() => assert.equal(edges(db).length, 0), `a ${label} replacement word retires nothing`);
    check(() => assert.equal(store.currentHeadOf(db, oldId).id, oldId), `the head survives a ${label} cue`);
    store.closeAll();
  }

  // R-03: the same sequence number in another session is not the same event
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-r03'));
    const oldId = await seed(db, '本次上线按方案 A 执行', {
      source: { kind: 'extract', sessionId: 'other-session', seq: 1, messageId: null, role: 'user', quoteMatch: 'exact' },
    });
    const sentence = '算了，不用 A 了，改 B';
    const out = await extract.distill({
      db,
      turns: [turn(sentence, 1, { messageId: null })],
      sessionId: 'new-session',
      llmCall: one({ type: 'decision', name: '上线方案', text: '本次上线改用方案 B 执行', quote: sentence }),
    });
    check(() => assert.equal(out.applied[0]?.action, 'insert'), 'a cross-session sequence collision inserts instead of merging');
    check(() => assert.equal(db.get(oldId)?.payload?.text, '本次上线按方案 A 执行'), 'the old body is not overwritten');
    store.closeAll();
  }

  // R-04: two facts from one sentence do not collapse into the chain
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-r04'));
    const oldId = await seed(db);
    const sentence = '不再使用方案 A，改用方案 B；发布预算为 5000 元，必须由人工核验之后执行。';
    const out = await extract.distill({
      db,
      turns: [turn(sentence)],
      sessionId: 's',
      llmCall: async () => JSON.stringify({
        candidates: [
          { type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: sentence, supersedes: '方案 A' },
          { type: 'decision', name: '发布预算', text: '发布预算为 5000 元，必须由人工核验之后执行。', quote: sentence },
        ],
      }),
    });
    const budget = db.allNodeIds().map((id) => db.get(id)?.payload || {}).find((p) => String(p.text || '').includes('5000'));
    check(() => assert.ok(budget), 'the budget fact is written');
    check(() => assert.equal(budget?.text, '发布预算为 5000 元，必须由人工核验之后执行。'), 'and it keeps its own body');
    check(() => assert.equal(edges(db).length, 1), 'only the correction creates a link');
    check(() => assert.equal(edges(db)[0], `${out.applied[0].id}->${oldId}`), 'the link points at the replaced decision');
    store.closeAll();
  }

  // R-04b: a longer repeat on a revision-linked node must not throw
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-r04b'));
    await seed(db);
    const sentence = '不再使用方案 A，改用方案 B';
    const first = await extract.distill({
      db,
      turns: [turn(sentence)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: sentence, supersedes: '方案 A' }),
    });
    let second;
    let threw = null;
    try {
      second = await extract.distill({
        db,
        turns: [turn(sentence)],
        sessionId: 's',
        llmCall: one({ type: 'decision', name: '上线方案 B', text: '改用方案 B，部署前必须经过人工验证并完成备份', quote: sentence, supersedes: '方案 A' }),
      });
    } catch (err) {
      threw = err.message;
    }
    check(() => assert.equal(threw, null), 'a repeat with a longer body does not throw REVISION_PROTECTED');
    check(() => assert.equal(second?.applied.length, 1), 'the longer body is stored');
    check(() => assert.equal(edges(db).length, 1), 'and the chain is not forked');
    store.closeAll();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P69: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
