/**
 * p102 — the memory-eval scorer and its frozen corpus.
 *
 * The baseline is only useful if the scorer itself is tested: known-correct,
 * known-missed, unsourced, duplicate, paraphrase and echo samples are fed to the
 * same functions the report uses. Then the fixture's own invariants (sizes,
 * splits, no cross-split rewrites, ids that exist) are checked, and two scenarios
 * run end to end so the wiring between fixture, write path and retrieval is not
 * only exercised by hand.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { scoreWrites, scoreRetrieval, aggregate, normalizeText, runEvaluation, FIXTURE_PATH } =
  await import('./memory-eval.mjs');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try {
    await fn();
    console.log('ok ' + label);
  } catch (error) {
    failures += 1;
    console.error('FAIL ' + label + ': ' + error.message);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

const node = (id, type, text, extra = {}) => ({ id, type, text, source: 'extract', ...extra });
const scenario = (extra) => ({
  id: 'T',
  split: 'dev',
  category: 'test',
  prompt: 'prompt',
  expect: { present: [], absent: [], echoes: [] },
  ...extra,
});

try {
  await check(() => {
    const scored = scoreWrites(
      scenario({ expect: { present: [{ text: '失败后重试 5 次。' }] } }),
      { nodes: [node(201, 'decision', '失败后重试 3 次。'), node(202, 'decision', '失败后重试 5 次。')], beforeIds: [201], applied: [{ action: 'insert', text: '失败后重试 5 次。' }], skipped: [] },
    );
    assert(scored.counts.correct === 1, `correct ${scored.counts.correct}`);
    assert(scored.counts.missed === 0, 'a present fact was counted as missed');
  }, 'a written fact that exists exactly is counted correct');

  await check(() => {
    const scored = scoreWrites(
      scenario({ expect: { present: [{ text: '数据库端口是 6543。' }] } }),
      { nodes: [node(101, 'entity', '数据库实体。')], beforeIds: [101], applied: [], skipped: [] },
    );
    assert(scored.counts.missed === 1, `missed ${scored.counts.missed}`);
    assert(scored.present[0].verdict === 'missed', scored.present[0].verdict);
  }, 'a vanished fact is counted as missed, not as absent');

  await check(() => {
    const scored = scoreWrites(
      scenario({ expect: { present: [{ text: '并发上限是 12。' }] } }),
      { nodes: [node(202, 'decision', '并发上限是 12。'), node(203, 'decision', '并发上限是 12。')], beforeIds: [], applied: [], skipped: [] },
    );
    assert(scored.counts.duplicate === 1, `duplicate ${scored.counts.duplicate}`);
    assert(scored.counts.correct === 0, 'a duplicated fact was still counted correct');
    assert(scored.duplicateGroups.length === 1, 'duplicate group not reported');
  }, 'two nodes with the same body are counted as a duplicate write');

  await check(() => {
    const scored = scoreWrites(
      scenario({ expect: { absent: [{ text: '导出格式固定为 XLSX。' }] } }),
      { nodes: [node(202, 'decision', '导出格式固定为 XLSX。')], beforeIds: [], applied: [{ action: 'insert' }], skipped: [] },
    );
    assert(scored.counts.unsourcedNew === 1, `unsourced ${scored.counts.unsourcedNew}`);
    assert(scored.absent[0].verdict === 'unsourced-new', scored.absent[0].verdict);
  }, 'a candidate the corpus says is unsupported is reported as unsourced-new');

  await check(() => {
    const scored = scoreWrites(
      scenario({ expect: { present: [{ text: '重试 3 次。' }] } }),
      { nodes: [node(202, 'decision', '失败后重试 3 次，然后指数退避。')], beforeIds: [], applied: [], skipped: [] },
    );
    assert(scored.counts.needsReview === 1, `needsReview ${scored.counts.needsReview}`);
    assert(scored.counts.correct === 0, 'a paraphrase was accepted as correct without review');
    assert(scored.counts.missed === 0, 'a paraphrase was also counted as missed');
  }, 'a paraphrase is queued for human review instead of correct or missed');

  await check(() => {
    const leaked = scoreWrites(
      scenario({ expect: { echoes: [{ text: '测试代号是 BLUE-OTTER-741。' }] } }),
      { nodes: [node(201, 'preference', '测试代号是 BLUE-OTTER-741。'), node(203, 'entity', '测试代号是 BLUE-OTTER-741。')], beforeIds: [201], applied: [{ action: 'insert' }], skipped: [] },
    );
    assert(leaked.counts.echoLeaked === 1, `echo leak ${leaked.counts.echoLeaked}`);
    const guarded = scoreWrites(
      scenario({ expect: { echoes: [{ text: '测试代号是 BLUE-OTTER-741。' }] } }),
      { nodes: [node(201, 'preference', '测试代号是 BLUE-OTTER-741。')], beforeIds: [201], applied: [], skipped: [{ reason: 'memory-read-echo' }] },
    );
    assert(guarded.counts.echoLeaked === 0, 'an echo was reported as leaked');
    assert(guarded.echoSkipped === 1, `echoSkipped ${guarded.echoSkipped}`);
  }, 'an echo written as a new node is a leak; a skipped echo is not');

  await check(() => {
    const kept = scoreWrites(
      scenario({ expect: { intact: [{ id: 201, contains: '不允许写入' }] } }),
      { nodes: [node(201, 'decision', '只允许只读访问，不允许写入。')], beforeIds: [201], applied: [], skipped: [] },
    );
    assert(kept.counts.intactBroken === 0, 'an untouched fact was reported as overwritten');
    const broken = scoreWrites(
      scenario({ expect: { intact: [{ id: 201, contains: '不允许写入' }] } }),
      { nodes: [node(201, 'decision', '现在允许写入。')], beforeIds: [201], applied: [], skipped: [] },
    );
    assert(broken.counts.intactBroken === 1, 'an overwritten fact was reported as intact');
  }, 'the intact check detects a merge that replaced an older fact');

  await check(() => {
    const scored = scoreWrites(
      scenario({ expect: { present: [{ text: '构建缓存的清理周期是 7 天。' }] } }),
      {
        nodes: [
          node(201, 'preference', '构建缓存目录是 .build/cache。'),
          node(202, 'preference', '请读一下构建缓存那条记忆；另外记住：构建缓存的清理周期是 7 天。'),
          node(203, 'preference', '构建缓存的清理周期是 7 天。'),
        ],
        beforeIds: [201], applied: [], skipped: [],
      },
    );
    assert(scored.counts.redundantNew === 1, `redundant ${scored.counts.redundantNew}`);
    assert(scored.counts.correct === 1, 'the exact write should still count');
  }, 'a rule copy of the same sentence is counted as redundant, not as another correct fact');

  await check(() => {
    const result = { textCandidates: [{ id: 101, text: 'anchor' }, { id: 201, text: 'fact' }], state: 'candidates', answerability: 'not_assessed' };
    const scored = scoreRetrieval(scenario({ retrieval: { kind: 'answerable', anchor: 101, question: 'q', relevant: [201], forbidden: [301] } }), result);
    assert(scored.top1 === false, 'the anchor must not count as a Top-1 answer');
    assert(scored.top5 === true, 'the relevant fact is in Top-5');
    assert(scored.top1ExcludingAnchor === true, 'Top-1 without the anchor should hit');
    const forbidden = scoreRetrieval(
      scenario({ retrieval: { kind: 'answerable', anchor: 101, question: 'q', relevant: [201], forbidden: [301] } }),
      { textCandidates: [{ id: 301 }] },
    );
    assert(forbidden.forbiddenHits.length === 1, 'a forbidden id was not reported');
  }, 'retrieval scores Top-1/Top-5, the anchor as a non-answer, and forbidden ids');

  await check(() => {
    const scored = scoreRetrieval(
      scenario({ retrieval: { kind: 'unanswerable', anchor: 101, question: 'q', relevant: [], forbidden: [] } }),
      { textCandidates: [{ id: 101 }, { id: 102 }], state: 'scope_anchor_only' },
    );
    assert(scored.top1 === null && scored.top5 === null, 'an unanswerable question must not be scored as right or wrong');
    assert(scored.candidates.length === 2, 'returned candidates must still be listed');
    assert(scored.state === 'scope_anchor_only', 'the state is not reported');
  }, 'an unanswerable question lists candidates without a correctness verdict');

  await check(() => {
    const scored = scoreRetrieval(
      scenario({ retrieval: { kind: 'answerable', anchor: 101, question: 'q', relevant: [201], forbidden: [], textCheck: { id: 201, contains: '5%' } } }),
      { textCandidates: [{ id: 201, text: '灰度比例是 50%。' }] },
    );
    assert(scored.textCheck.present === true, 'textCheck did not see the row');
    assert(scored.textCheck.ok === false, 'textCheck accepted the wrong body');
  }, 'a cross-workspace body check fails when the other workspace text comes back');

  await check(() => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    const scenarios = fixture.scenarios;
    const dev = scenarios.filter((row) => row.split === 'dev');
    const holdout = scenarios.filter((row) => row.split === 'holdout');
    assert(scenarios.length >= 24, `only ${scenarios.length} scenarios`);
    assert(dev.length >= 16, `only ${dev.length} dev scenarios`);
    assert(holdout.length >= 8, `only ${holdout.length} holdout scenarios`);
    assert(new Set(scenarios.map((row) => row.id)).size === scenarios.length, 'duplicate scenario ids');
    assert(scenarios.every((row) => row.prompt && row.category && ['dev', 'holdout'].includes(row.split)), 'a scenario lacks prompt/category/split');
    const byCategory = {};
    for (const row of scenarios) byCategory[row.category] = (byCategory[row.category] || 0) + 1;
    for (const [name, count] of Object.entries(byCategory)) {
      assert(count >= 3, `category ${name} has only ${count} scenarios`);
    }
    const prompts = scenarios.map((row) => normalizeText(row.prompt));
    assert(new Set(prompts).size === prompts.length, 'two scenarios share the same prompt');
    const devTexts = new Set(dev.flatMap((row) => (row.seed?.nodes || []).map((n) => normalizeText(n.text))));
    for (const row of holdout) {
      for (const seedNode of row.seed?.nodes || []) {
        assert(!devTexts.has(normalizeText(seedNode.text)), `holdout ${row.id} reuses a dev fact body`);
      }
    }
    for (const row of scenarios) {
      const ids = new Set((row.seed?.nodes || []).map((n) => Number(n.id)));
      if (row.retrieval) {
        assert(ids.has(Number(row.retrieval.anchor)), `${row.id}: anchor ${row.retrieval.anchor} is not seeded`);
        for (const id of [...(row.retrieval.relevant || []), ...(row.retrieval.forbidden || [])]) {
          assert(ids.has(Number(id)), `${row.id}: retrieval id ${id} is not seeded`);
        }
        assert(row.retrieval.question, `${row.id}: retrieval without a question`);
      }
      for (const edge of row.seed?.edges || []) {
        assert(ids.has(Number(edge[0])) && ids.has(Number(edge[1])), `${row.id}: edge references an unseeded id`);
      }
      for (const read of row.readBack || []) {
        assert(ids.has(Number(read.nodeId)), `${row.id}: readBack references an unseeded id`);
      }
    }
    const categories = Object.keys(byCategory).length;
    console.log(`   corpus: ${scenarios.length} scenarios (${dev.length} dev / ${holdout.length} holdout) in ${categories} categories`);
  }, 'the frozen corpus has the required size, splits and referential integrity');

  await check(async () => {
    const report = await runEvaluation({ only: ['E2'] });
    assert(report.meta.scenarios === 1, 'only= did not narrow the run');
    const row = report.results[0];
    assert(row.retrieval.state === 'scope_anchor_only', `state ${row.retrieval.state}`);
    assert(report.meta.realModelCalls === 0 && report.meta.realEmbeddingCalls === 0, 'the baseline must not call a provider');
    assert(report.meta.finalAnswerAccuracy.startsWith('not measured'), 'final answer accuracy must stay unmeasured');
    assert(report.timing.samples === 1, `timing samples ${report.timing.samples}`);
  }, 'the evaluator runs one scenario end to end with zero provider calls');

  await check(async () => {
    const first = await runEvaluation({ only: ['A1', 'D1'], reps: 1 });
    const second = await runEvaluation({ only: ['A1', 'D1'], reps: 1 });
    const strip = (report) => JSON.stringify({
      aggregate: report.aggregate,
      results: report.results.map((row) => ({ id: row.id, writes: row.writes, retrieval: row.retrieval })),
    });
    assert(strip(first) === strip(second), 'the same fixture produced different verdicts');
    const byA1 = first.results.find((row) => row.id === 'A1');
    assert(byA1.writes.counts.correct === 1, `A1 correct ${byA1.writes.counts.correct}`);
    assert(aggregate(first.results).writes.echoLeaked === 0, 'A1/D1 leaked an echo');
  }, 'two identical runs produce identical scenario verdicts and counts');
} catch (error) {
  failures += 1;
  console.error('FAIL unexpected throw: ' + (error && error.stack ? error.stack : error));
}

console.log(`P102: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
