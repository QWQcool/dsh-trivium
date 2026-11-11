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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  /*
   * The four regressions an external audit found on 2026-11-04 (F1). Each one used
   * to merge and would have retired a fact without a revision chain.
   */
  await check(() => {
    const { same, reason } = identity.sameFact(fact('记住：重试间隔固定为 1.5 秒。'), fact('记住：重试间隔固定为 5.1 秒。'));
    assert.equal(same, false, `decimals must not collapse (${reason})`);
    assert.equal(reason, 'value-conflict');
  }, 'a decimal change is a different fact');
  await check(() => {
    // Names that share only a generic word ("环境") are not the same subject.
    const { same } = identity.sameFact(
      { type: 'preference', name: '生产环境依赖管理', text: '记住：生产环境统一使用 npm 管理依赖。' },
      { type: 'preference', name: '测试环境依赖管理', text: '记住：测试环境统一使用 pnpm 管理依赖。' },
    );
    assert.equal(same, false, 'a different environment is a different fact');
  }, 'a generic name token ("环境") does not make two subjects the same');
  await check(() => {
    const { same, reason } = identity.sameFact(
      fact('记住：项目日志文件固定保留十六天后自动删除。'),
      fact('记住：项目日志文件固定保留六十天后自动删除。'),
    );
    assert.equal(same, false, `CJK numerals must be read as numbers (${reason})`);
    assert.equal(reason, 'value-conflict');
  }, '十六 and 六十 are different numbers, not the same characters');
  await check(() => {
    assert.equal(identity.isNegated("The build don't cache the artefacts."), true);
    assert.equal(identity.isNegated('The build caches the artefacts.'), false);
  }, "an apostrophe negation is recognised before normalisation");
  await check(() => {
    assert.equal(identity.cjkNumber('十六'), 16);
    assert.equal(identity.cjkNumber('六十'), 60);
    assert.equal(identity.cjkNumber('一百二十'), 120);
  }, 'CJK numerals are read as one number');

  /*
   * Fuzzy merging ships **off** (external audit F1: a threshold tuned on hand-written
   * samples cannot separate a rewrite from a correction, and a merge retires the
   * old fact). The default path must therefore behave exactly like 0.8.4.
   */
  const db = await store.openWorkspaceDb(join(root, 'ws'));
  try {
    await check(() => {
      const applied = extract.applyCandidates(
        db,
        [{ type: 'preference', name: '部署窗口', text: '记住：发布窗口固定在每周四晚上。' }],
        { sessionId: 'p87' },
      );
      assert.equal(applied[0].action, 'insert');
      const second = extract.applyCandidates(
        db,
        [{ type: 'preference', name: '部署窗口', text: '记住：每周四晚上是发布窗口。' }],
        { sessionId: 'p87' },
      );
      assert.equal(second[0].action, 'insert', 'fuzzy merging must be off by default');
    }, 'by default a paraphrase is stored separately, like 0.8.4');
    const beforeCorrection = store.findByType(db, 'preference').length;
    await check(() => {
      const applied = extract.applyCandidates(
        db,
        [{ type: 'preference', name: '部署窗口', text: '记住：部署窗口改到每周五晚上。' }],
        { sessionId: 'p87' },
      );
      assert.equal(applied[0].action, 'insert', `expected a new node, got ${applied[0].action}`);
    }, 'a correction that changes the day inserts instead of merging');
    await check(
      () => assert.ok(store.findByType(db, 'preference').length >= beforeCorrection + 1),
      'the correction is stored as its own fact',
    );
  } finally {
    store.closeAll();
  }

  /*
   * The old "paraphrase merges through the extraction pipeline" check seeded
   * BOTH wordings first, so the second write passed by exact text match without
   * ever reaching the fuzzy rule (external review assertion audit, 2026-11-06).
   * Prove the entry point with the switch on and only one wording seeded.
   */
  const settings = await import('../lib/settings.js');
  // `identityMerge` is a manual config key, not a panel field: writeUiSettings
  // whitelists panel keys and silently drops it. Write the settings file directly.
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ identityMerge: true }), 'utf8');
  await check(() => assert.equal(settings.identityMergeOf(), true), 'fixture: fuzzy merging is enabled');
  const fuzzyDb = await store.openWorkspaceDb(join(root, 'ws-fuzzy'));
  try {
    const seed = extract.applyCandidates(
      fuzzyDb,
      [{ type: 'preference', name: '部署窗口', text: '记住：发布窗口固定在每周四晚上。' }],
      { sessionId: 'p87-fuzzy' },
    );
    await check(() => assert.equal(seed[0].action, 'insert'), 'fixture: only one wording is seeded');
    const beforeFuzzy = store.findByType(fuzzyDb, 'preference').length;
    await check(() => {
      const applied = extract.applyCandidates(
        fuzzyDb,
        [{ type: 'preference', name: '部署窗口', text: '记住：每周四晚上是发布窗口。' }],
        { sessionId: 'p87-fuzzy' },
      );
      assert.equal(applied[0].action, 'merge', `expected a fuzzy merge, got ${applied[0].action}`);
    }, 'with identityMerge on, a different wording merges through the extraction pipeline');
    await check(
      () => assert.equal(store.findByType(fuzzyDb, 'preference').length, beforeFuzzy),
      'the merge added no node',
    );
  } finally {
    store.closeAll();
  }
  /*
   * P1 calibration corpus: real facts from this repository plus hand-written
   * pairs, labelled the way a person would label them.
   *
   * The hard gate is **zero false merges**, because merging retires a fact with
   * no revision chain. Recall is only a floor: at 2026-11-11 the lexical scorer
   * reaches 7/11 and the remaining misses are true paraphrases that character
   * n-grams cannot see. Closing those needs the (optional, off-by-default)
   * embedding path, not a lower threshold — at 0.5 the same corpus produces
   * seven false merges.
   */
  await check(() => {
    const corpus = JSON.parse(readFileSync(new URL('./fixtures/identity-corpus.json', import.meta.url), 'utf8'));
    const positives = corpus.pairs.filter((row) => row.label === 'same');
    const negatives = corpus.pairs.filter((row) => row.label !== 'same');
    const merged = (row) => identity.sameFact(row.a, row.b).same;
    const falseMerges = negatives.filter(merged);
    const hits = positives.filter(merged).length;
    assert.equal(
      falseMerges.length,
      0,
      `false merges: ${falseMerges.map((row) => `${row.why} :: ${row.b.text}`).join(' | ')}`,
    );
    assert.ok(
      hits / positives.length >= 0.6,
      `recall ${hits}/${positives.length} fell below the recorded 7/11 baseline`,
    );
  }, 'the calibration corpus produces no false merges and recall does not regress');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`P87: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
