/**
 * p67 — the same write seen twice is not two facts, even when the model words it
 * differently the second time.
 *
 * Live run (W9, 2026-11-02) stored two versions of one correction:
 *   "这次上线改走方案 B；之前定的方案 A 已废弃，不再沿用。"
 *   "这次上线改按方案 B 走，上一个方案（方案 A）已弃用"
 * Same user turn, same name, different paraphrase. Text similarity cannot separate
 * that pair from two genuinely different facts (a "负责人是张三/李四" pair scores
 * higher), so the rule uses provenance: same event + same type + same name.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p67-'));
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
const count = (db, needle) => db.allNodeIds().filter((id) => String(db.get(id)?.payload?.text || '').includes(needle)).length;

try {
  // 1. replay and turn end disagree on the wording: still one fact
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-1'));
    await extract.distill({
      db,
      turns: [turn('这次上线按方案 A 走。', 1)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案 A', text: '这次上线按方案 A 走。', quote: '这次上线按方案 A 走。' }),
    });
    const sentence = '上一个方案不要了，走新的，用方案 B。';
    const shared = turn(sentence, 2);
    await extract.distill({
      db,
      turns: [shared],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案 B', text: '这次上线改走方案 B；之前定的方案 A 已废弃，不再沿用。', quote: sentence, supersedes: '方案 A' }),
    });
    await extract.distill({
      db,
      turns: [shared],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案 B', text: '这次上线改按方案 B 走，上一个方案（方案 A）已弃用', quote: sentence, supersedes: '方案 A' }),
    });
    check(() => assert.equal(count(db, '方案 B'), 1), 'a paraphrase of the same write does not create a second node');
    const namedA = db.allNodeIds().filter((id) => String(db.get(id)?.payload?.name || '') === '上线方案 A');
    check(() => assert.equal(namedA.length, 1), 'the replaced decision is untouched');
    store.closeAll();
  }

  // 1b. the model renames its own paraphrase: still one write
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-1b'));
    await extract.distill({
      db,
      turns: [turn('这次上线按方案 A 走。', 1)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案 A', text: '这次上线按方案 A 走。', quote: '这次上线按方案 A 走。' }),
    });
    const sentence = '上一个方案不要了，走新的，用方案 B。';
    const shared = turn(sentence, 2);
    await extract.distill({
      db,
      turns: [shared],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案 B', text: '本次上线改按方案 B 执行；方案 A 已废弃，不再采用。', quote: sentence, supersedes: '上线方案 A' }),
    });
    await extract.distill({
      db,
      turns: [shared],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '本次上线改按方案 B 执行；方案 A 已废弃。', quote: sentence, supersedes: '方案 A' }),
    });
    /*
     * A renamed paraphrase is NOT folded any more: folding on "same event + the
     * stored node already replaced something" merged an unrelated budget fact
     * into the chain and threw REVISION_PROTECTED (review R-04). Without a name
     * match there is no proof it is the same fact, so the safer outcome is two
     * nodes and no exception.
     */
    check(() => assert.equal(count(db, '方案 B'), 2), 'a renamed paraphrase is kept separately, not merged');
    const names = db.allNodeIds().map((id) => db.get(id)?.payload?.name).filter(Boolean);
    check(() => assert.equal(names.includes('上线方案'), true), 'the renamed node is stored under its own name');
    store.closeAll();
  }

  // 2. the same wording from a later message is a real new fact
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-2'));
    await extract.distill({
      db,
      turns: [turn('这次上线改走方案 B。', 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案 B', text: '这次上线改走方案 B。', quote: '这次上线改走方案 B。' }),
    });
    await extract.distill({
      db,
      turns: [turn('再说一遍：这次上线改走方案 B。', 3)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案 B', text: '这次上线改走方案 B。', quote: '再说一遍：这次上线改走方案 B。' }),
    });
    // Both carry the same text, so the exact-text retry rule folds them; that is
    // the existing behaviour and it is not what this case is about.
    check(() => assert.equal(count(db, '方案 B'), 1), 'identical text from another message still folds');
    store.closeAll();
  }

  // 3. two different facts from one message keep both names
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-3'));
    const shared = turn('负责人是张三，预算上限 5000 元。', 4);
    await extract.distill({
      db,
      turns: [shared],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '负责人', text: '负责人是张三', quote: shared.text }),
    });
    await extract.distill({
      db,
      turns: [shared],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '预算', text: '预算上限 5000 元', quote: shared.text }),
    });
    check(() => assert.equal(count(db, '张三'), 1), 'the first fact is kept');
    check(() => assert.equal(count(db, '5000'), 1), 'a different name from the same message is kept separately');
    store.closeAll();
  }

  // 4. the merge keeps what it replaced, so a wrong fold is recoverable
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-4'));
    const shared = turn('上一个方案不要了，走新的，用方案 B。', 5);
    await extract.distill({
      db,
      turns: [shared],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案 B', text: '这次上线改走方案 B', quote: shared.text }),
    });
    await extract.distill({
      db,
      turns: [shared],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案 B', text: '这次上线改走方案 B，方案 A 作废', quote: shared.text }),
    });
    const node = db.allNodeIds().map((id) => db.get(id)?.payload || {}).find((p) => String(p.text || '').includes('方案 B'));
    check(() => assert.equal(node?.text, '这次上线改走方案 B，方案 A 作废'), 'the richer text wins');
    check(() => assert.equal(node?.history?.[0]?.text, '这次上线改走方案 B'), 'the folded body is kept as history');
    store.closeAll();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P67: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
