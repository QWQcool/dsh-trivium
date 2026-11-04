/**
 * p87 — fact identity: the same fact in different words is one node.
 *
 * The old rule was a substring test, which only catches one body being a prefix of
 * the other. "发布窗口固定在每周四晚上" and "每周四晚上是发布窗口" are the same fact and
 * used to produce two nodes.
 *
 * The dangerous direction is the opposite one, so most of this test is about what
 * must **not** merge: a different number, a negation, a different type, or two
 * bodies too short to tell apart.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p87-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const identity = await import('../lib/identity.js');
const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const fact = (text, extra = {}) => ({ type: 'preference', name: '部署窗口', text, ...extra });

try {
  await check(() => {
    const score = identity.similarity('发布窗口固定在每周四晚上。', '发布窗口固定在每周四晚上。');
    assert.equal(score, 1);
  }, 'identical text scores 1');
  await check(() => {
    const { same, reason, score } = identity.sameFact(
      fact('每周四晚上是发布窗口。'),
      fact('发布窗口固定在每周四晚上。'),
    );
    assert.equal(same, true, `expected a merge, got ${reason} @ ${score.toFixed(2)}`);
  }, 'a reordered paraphrase is the same fact');
  await check(() => {
    const { same, reason } = identity.sameFact(fact('部署窗口是周四晚上。'), fact('部署窗口是周五晚上。'));
    assert.equal(same, false);
    assert.equal(reason, 'value-conflict');
  }, 'a different weekday is a correction, not a duplicate');
  await check(() => {
    const { same, reason } = identity.sameFact(fact('日志保留 30 天。'), fact('日志保留 60 天。'));
    assert.equal(same, false);
    assert.equal(reason, 'value-conflict');
  }, 'a different number is never folded');
  await check(() => {
    const { same, reason } = identity.sameFact(fact('发布窗口固定在每周四晚上。'), fact('不支持发布窗口固定在每周四晚上。'));
    assert.equal(same, false);
    assert.equal(reason, 'negation');
  }, 'a negation flip is never folded');
  await check(() => {
    const { same, reason } = identity.sameFact(
      { type: 'decision', name: '部署窗口', text: '发布窗口固定在每周四晚上。' },
      fact('发布窗口固定在每周四晚上。'),
    );
    assert.equal(same, false);
    assert.equal(reason, 'type');
  }, 'a preference never folds into a decision');
  await check(() => {
    const { same, reason } = identity.sameFact(
      { type: 'entity', name: '部署窗口', text: '部署窗口' },
      { type: 'entity', name: '部署窗口', text: '部署窗口' },
    );
    assert.equal(same, false);
    assert.equal(reason, 'entity-uses-name');
  }, 'entities keep their name-based rule');
  await check(() => {
    // Identical bodies merge; a *near* body that is too short to tell apart does not.
    const identical = identity.sameFact(fact('部署窗口', { name: '' }), fact('部署窗口', { name: '' }));
    assert.equal(identical.same, true);
    const near = identity.sameFact(fact('部署窗口', { name: '' }), fact('部署窗', { name: '' }));
    assert.equal(near.same, false);
    assert.equal(near.reason, 'too-short');
  }, 'short bodies only merge when they are literally the same');
  await check(() => {
    assert.equal(identity.sameNameFamily('部署窗口', '部署窗口时间'), true);
    assert.equal(identity.sameNameFamily('部署窗口', '鉴权方式'), false);
  }, 'name family tolerates a qualifier and rejects an unrelated name');
  await check(() => {
    const { same } = identity.sameFact(
      { type: 'preference', name: 'Package manager', text: 'The repository uses npm, never pnpm.' },
      { type: 'preference', name: 'Package manager', text: 'The repository uses npm, never pnpm.' },
    );
    assert.equal(same, true);
  }, 'latin bodies work too');

  // The merger is wired into the store, not just exported.
  const db = await store.openWorkspaceDb(join(root, 'ws'));
  try {
    // Candidate texts carry an explicit cue, because the write filter drops lines
    // without one — that rule is unrelated to identity and would mask it here.
    const first = extract.applyCandidates(
      db,
      [{ type: 'preference', name: '部署窗口', text: '记住：发布窗口固定在每周四晚上。' }],
      { sessionId: 'p87' },
    );
    assert.equal(first.length, 1, 'fixture: the seed fact was written');
    const before = store.findByType(db, 'preference').length;
    await check(() => {
      const applied = extract.applyCandidates(
        db,
        [{ type: 'preference', name: '部署窗口', text: '记住：每周四晚上是发布窗口。' }],
        { sessionId: 'p87' },
      );
      assert.equal(applied.length, 1);
      assert.equal(applied[0].action, 'merge', `expected merge, got ${applied[0].action}`);
    }, 'a paraphrase merges through the extraction pipeline');
    await check(() => assert.equal(store.findByType(db, 'preference').length, before), 'the paraphrase added no node');
    await check(() => {
      const applied = extract.applyCandidates(
        db,
        [{ type: 'preference', name: '部署窗口', text: '记住：部署窗口改到每周五晚上。' }],
        { sessionId: 'p87' },
      );
      assert.equal(applied[0].action, 'insert', `expected a new node, got ${applied[0].action}`);
    }, 'a correction that changes the day inserts instead of merging');
    await check(() => assert.ok(store.findByType(db, 'preference').length >= before + 1), 'the correction is stored as its own fact');
  } finally {
    store.closeAll();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`P87: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
