/**
 * p63 — a spoken correction now retires the decision instead of overwriting it.
 *
 * The production case (2026-11-01, real host, empty library) collapsed into one
 * node: the model restated the old decision and appended the change, and
 * store.findMergeTarget matched by body containment, so mergeInto overwrote the
 * old text in place. The new id was the old id, so no edge could exist.
 *
 * Three changes are asserted here: a replacement never merges, the bare label in
 * "不用 A 了" is accepted when it sits next to the replacement word, and a
 * rejected attempt is reported instead of silently returning.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p63-'));
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
const turn = (text, seq) => ({ role: 'user', text, seq, messageId: `m-${seq}`, at: '2026-11-01T09:00:00.000Z', recorded: true });
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
  // 1. the production wording, with the candidate restating the old body
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-1'));
    const oldId = await seed(db);
    const sentence = '算了，不用 A 了，改 B';
    const out = await extract.distill({
      db,
      turns: [turn(sentence, 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '按方案 A 走，随后改 B', quote: sentence }),
    });
    const oldNode = db.get(oldId)?.payload || {};
    check(() => assert.equal(oldNode.text, '按方案 A 走'), 'the old decision keeps its original text (no overwrite)');
    check(() => assert.equal(out.applied.length, 1), 'the replacement is written as its own node');
    check(() => assert.notEqual(out.applied[0].id, oldId), 'the replacement is a new node, not the old one');
    check(() => assert.deepEqual(edgesOf(db), [`${out.applied[0].id}->${oldId}`]), 'a supersedes edge links them');
    check(() => assert.equal(out.superseded.filter((row) => row.to).length, 1), 'the link is reported');
    store.closeAll();
  }

  // 1b. the same window is processed twice (replay, then turn end): one node
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-1b'));
    const oldId = await seed(db);
    const sentence = '算了，不用 A 了，改 B';
    const cand = { type: 'decision', name: '上线方案', text: '按方案 A 走，随后改 B', quote: sentence };
    await extract.distill({ db, turns: [turn(sentence, 2)], sessionId: 's', llmCall: one(cand) });
    await extract.distill({ db, turns: [turn(sentence, 2)], sessionId: 's', llmCall: one(cand) });
    const copies = db.allNodeIds().filter((id) => String(db.get(id)?.payload?.text || '') === '按方案 A 走，随后改 B');
    check(() => assert.equal(copies.length, 1), 'a repeated replacement write is idempotent');
    check(() => assert.equal(edgesOf(db).length, 1), 'and does not fork the chain');
    check(() => assert.equal(edgesOf(db)[0], `${copies[0]}->${oldId}`), 'the single edge still points at the old decision');
    store.closeAll();
  }

  // 2. the bare letter is only accepted next to the replacement word
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-2'));
    const oldId = await seed(db);
    const sentence = '更正一下：先记一笔今天的 A 版本变更';
    const out = await extract.distill({
      db,
      turns: [turn(sentence, 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '改用 B', quote: sentence }),
    });
    check(() => assert.equal(edgesOf(db).length, 0), 'a letter far from the cue does not match the label');
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'no-target'), true), 'the miss is reported as no-target');
    store.closeAll();
  }

  // 3. a replacement claim with no quote is reported, not silently dropped
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-3'));
    await seed(db);
    // Not filler, otherwise the content gate skips the model call entirely.
    const out = await extract.distill({
      db,
      turns: [turn('把方案的事情记一下。', 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '更正：改用方案 B' }),
    });
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'no-quote'), true), 'a claim without a quote is reported');
    store.closeAll();
  }

  // 4. a claim the user's sentence does not support is reported
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-4'));
    await seed(db);
    const sentence = '今天先到这里';
    const out = await extract.distill({
      db,
      turns: [turn(sentence, 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '上线方案', text: '更正：改用方案 B', quote: sentence }),
    });
    check(() => assert.equal(out.superseded.some((row) => row.skipped === 'replacement-not-in-user-sentence'), true), 'an unsupported claim is reported');
    check(() => assert.equal(edgesOf(db).length, 0), 'and it retires nothing');
    store.closeAll();
  }

  // 5. ordinary decisions stay quiet
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-5'));
    await seed(db);
    const out = await extract.distill({
      db,
      turns: [turn('负责人是张三', 2)],
      sessionId: 's',
      llmCall: one({ type: 'decision', name: '负责人', text: '负责人是张三', quote: '负责人是张三' }),
    });
    check(() => assert.deepEqual(out.superseded, []), 'a non-replacement decision reports nothing');
    store.closeAll();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P63: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
