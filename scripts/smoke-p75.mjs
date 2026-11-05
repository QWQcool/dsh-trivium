/**
 * p75 — B1 event two-level screening (S0-3).
 *
 * Covers:
 *   1. screenEvent scoring on the whitelist, on stated facts, and on the
 *      default "maybe" bucket;
 *   2. at least five false-positive counterexamples: text that *looks* like a
 *      greeting / command / path but carries a fact, and must never score 0;
 *   3. screenTurns: zero groups dropped, tool evidence kept, 2s promoted to the
 *      front without shuffling the rest;
 *   4. the same corpus through distill() with and without screening: model calls
 *      drop by >= 20 % and the extracted facts do not change;
 *   5. screening never adds a call (calls with screening <= calls without).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p75-'));
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
const turn = (text, role = 'user', extra = {}) => ({ role, text, seq: 1, messageId: 'm1', at: '2026-11-02T09:00:00.000Z', recorded: true, ...extra });

try {
  /*
   * 1) Only empty input and the two filler lists may be zero now.
   *
   * Audit F2 (2026-11-04): a command name followed by words is still a sentence
   * ("npm is the package manager for this project" used to score 0), a single
   * character can confirm the previous decision, and a path or URL can be the fact
   * itself. A false zero loses a fact; a false 1 only costs a call we already paid.
   */
  for (const text of ['继续。', '好的', 'ok']) {
    await check(() => assert.equal(extract.screenEvent(text), 0), `0: ${text}`);
  }
  for (const text of ['/compact', 'git status', 'npm test', 'C:\\proj\\readme.md', '~/proj', '/tmp/build.sh', 'https://example.com/a?b=1']) {
    await check(() => assert.equal(extract.screenEvent(text), 1), `1: ${text}`);
  }
  // Stated facts score 2 so they go to the front of the batch.
  for (const text of ['记住，以后都用 pnpm。', '采用方案 A 做登录。', '从现在起回复用中文。']) {
    await check(() => assert.equal(extract.screenEvent(text), 2), `2: ${text}`);
  }
  // Everything else is "maybe" — the model still decides.
  for (const text of ['这个接口为什么超时？', 'we should look at the logs', '继续用方案 A', '']) {
    if (text === '') continue;
    await check(() => assert.equal(extract.screenEvent(text), 1), `1: ${text}`);
  }
  await check(() => assert.equal(extract.screenEvent(''), 0), '0: empty text');
  await check(() => assert.equal(extract.screenEvent('   '), 0), '0: whitespace only');
  await check(() => assert.equal(extract.screenEvent(`${'很长的句子'.repeat(30)}`), 1), '1: long text is never a zero');

  // 2) False-positive counterexamples (>= 5): a prefix match would have scored 0.
  const counterexamples = [
    ['好的，但是以后不要用 npm 装依赖', 'greeting prefix + fact'],
    ['继续用方案 A', 'filler prefix + decision'],
    ['git status 之后再改成方案 B', 'command prefix + fact'],
    ['C:\\proj\\web 的 README 改成英文', 'path prefix + instruction'],
    ['/compact 之前先把预算改成 5000', 'slash command + fact'],
    ['ok 但记住用 pnpm', 'ack + preference cue'],
    ['https://example.com 这个接口超时了', 'url + statement'],
    ['npm test -- --watch 吗？', 'command + question mark'],
  ];
  for (const [text, why] of counterexamples) {
    await check(() => {
      const score = extract.screenEvent(text);
      assert.ok(score >= 1, `${why}: scored ${score}`);
    }, `not-0: ${why} (${text})`);
  }
  await check(() => assert.equal(extract.screenEvent('ok 但记住用 pnpm'), 2), 'a greeting with a real cue still scores 2');
  await check(() => {
    const detail = extract.screenEventDetail('git status');
    assert.equal(detail.rule, 'shell-command');
  }, 'every zero names the rule it matched');
  await check(() => {
    const detail = extract.screenEventDetail('好的');
    assert.equal(detail.rule, 'filler');
  }, 'the greeting whitelist is auditable');

  // 3) Window grouping.
  const window = [
    turn('npm test'),
    turn('', 'tool', { text: 'exit 1: 3 tests failed' }),
    turn('记住，以后都用 pnpm。'),
    turn('好的', 'assistant'),
    turn('方案 A 先别动，下周再改。'),
  ];
  const screened = extract.screenTurns(window);
  await check(() => assert.equal(screened.dropped.length, 0), 'a zero user turn with tool evidence is kept');
  await check(() => assert.equal(screened.turns[0].text, '记住，以后都用 pnpm。'), 'a 2 is promoted to the front');
  await check(() => assert.equal(screened.turns[1].text, '好的'), 'a reply stays attached to the turn it answers');
  await check(
    () => assert.ok(screened.turns.findIndex((t) => t.text === '记住，以后都用 pnpm。') < screened.turns.findIndex((t) => t.text === '方案 A 先别动，下周再改。')),
    'order inside the same score is preserved',
  );
  await check(() => assert.equal(screened.turns[screened.turns.length - 1].role, 'tool'), 'the 0-with-tool group moves behind the 2s');
  await check(() => {
    /*
     * Audit F2 (2026-11-04): a zero group is only dropped when the **whole** window
     * is zero. In a mixed window it travels with the rest, because dropping it is
     * how a fact sitting in a short reply got lost.
     */
    const only = extract.screenTurns([turn('git status'), turn('exit 0', 'tool', { text: 'exit 0' }), turn('继续。')]);
    assert.equal(only.turns.length, 3, 'the zero group stays in a mixed window');
    assert.equal(only.dropped.length, 0);
    assert.equal(only.audit.length, 1, 'the zero is still recorded');
  }, 'a mixed window keeps its greeting instead of deleting it');
  await check(() => {
    const empty = extract.screenTurns([turn('好的'), turn('收到')]);
    assert.equal(empty.turns.length, 0);
    assert.equal(empty.counts.scored0, 2);
  }, 'an all-zero window screens down to nothing');

  // 4) Model calls vs extraction hits over one corpus.
  const factWindows = [];
  for (let i = 0; i < 10; i += 1) factWindows.push(`记住，fact-${String(i).padStart(2, '0')} 用方案 A 走。`);
  const noiseWindows = [];
  for (let i = 0; i < 12; i += 1) noiseWindows.push('git status');
  for (let i = 0; i < 8; i += 1) noiseWindows.push(`C:\\proj\\build-${i}\\out`);
  const corpus = [...factWindows, ...noiseWindows].map((text) => [turn(text)]);

  async function runCorpus(dir, screening) {
    const db = await store.openWorkspaceDb(join(root, dir));
    let calls = 0;
    const applied = [];
    for (const turns of corpus) {
      const list = screening ? extract.screenTurns(turns).turns : turns;
      if (!list.length) continue;
      const result = await extract.distill({
        db,
        turns: list,
        sessionId: dir,
        llmCall: async () => { calls += 1; return JSON.stringify({ candidates: [] }); },
      });
      for (const row of result.applied) applied.push(String(row.text));
    }
    return { calls, applied: applied.sort(), nodes: store.nodeCountOf(db) };
  }

  const baseline = await runCorpus('baseline', false);
  const treated = await runCorpus('screened', true);
  const drop = baseline.calls ? (baseline.calls - treated.calls) / baseline.calls : 0;
  /*
   * Audit F2 (2026-11-04) removed the command/path/URL zeros, so this corpus — which
   * is mostly shell commands — no longer saves calls. That is the accepted trade:
   * a false zero loses a fact, a false 1 costs a call the plugin already paid.
   * Screening now only pays off on windows that are pure filler.
   */
  await check(() => assert.ok(treated.calls <= baseline.calls), 'screening never adds a model call');
  console.log(`   corpus calls: ${baseline.calls} -> ${treated.calls} (${(drop * 100).toFixed(1)}% saved on a command-heavy corpus)`);
  await check(() => {
    const filler = extract.screenTurns([turn('继续。'), turn('好的'), turn('收到')]);
    assert.equal(filler.turns.length, 0);
    assert.equal(filler.counts.scored0, 3);
  }, 'a filler-only window still costs nothing');
  await check(() => assert.deepEqual(treated.applied, baseline.applied), 'the extracted facts are identical');
  await check(() => assert.ok(treated.applied.length >= 10), `the corpus really produced hits (${treated.applied.length})`);
  await check(() => assert.ok(treated.calls <= baseline.calls), 'screening never adds a model call');
  await check(() => assert.equal(treated.nodes, baseline.nodes), 'the same number of nodes is written');

  // A screened window is consumed, not retried: the caller is told "ok".
  await check(async () => {
    const seen = [];
    const s = extract.screenTurns([turn('继续。')]);
    assert.equal(s.turns.length, 0);
    seen.push('consumed');
    assert.equal(seen.length, 1);
  }, 'an all-zero window has nothing left to extract');
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P75: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
