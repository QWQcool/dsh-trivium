/**
 * p75 — B1 observational scoring and the unchanged extraction path.
 *
 * Covers:
 *   1. screenEvent scoring on the whitelist, on stated facts, and on the
 *      default "maybe" bucket;
 *   2. at least five false-positive counterexamples: text that *looks* like a
 *      greeting / command / path but carries a fact, and must never score 0;
 *   3. screenTurns: every event retained in its original order, including zeros;
 *   4. the same corpus through distill() with and without screening: model calls
 *      and the extracted facts do not change;
 *   5. the real extraction entry point preserves the existing content gate.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

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
  // Stated facts score 2 for diagnostics, without moving in the batch.
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
    /*
     * Option B after audit F2 (2026-11-04): the shape rules are gone, so a command
     * is content and only the filler rules can produce a zero. The rule name stays
     * part of the contract, because every zero has to be traceable.
     */
    assert.equal(extract.screenEventDetail('git status').rule, 'content');
    assert.equal(extract.screenEventDetail('ok').rule, 'filler');
    assert.equal(extract.screenEventDetail('   ').rule, 'empty');
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
  await check(() => {
    const withTool = extract.screenTurns([turn('ok'), turn('tool finished', 'tool')]);
    assert.equal(withTool.dropped.length, 0);
    assert.equal(withTool.counts.scored1, 1, 'tool evidence still raises the diagnostic score');
    assert.equal(withTool.wouldDrop.length, 0);
  }, 'a zero user turn with tool evidence is retained and scored as evidence');
  await check(() => {
    assert.equal(screened.turns[0], window[0]);
    assert.equal(screened.promoted, 0);
  }, 'a 2 never displaces an earlier event');
  await check(() => assert.equal(screened.turns[3], window[3]), 'a reply stays attached to the turn it answers');
  await check(
    () => assert.deepEqual(screened.turns, window),
    'the complete input chronology is preserved across every score',
  );
  await check(() => assert.equal(screened.turns[1], window[1]), 'tool results keep their original position');
  await check(() => {
    /*
     * Mixed windows keep their zero groups and retain the diagnostic record.
     */
    const only = extract.screenTurns([turn('git status'), turn('exit 0', 'tool', { text: 'exit 0' }), turn('继续。')]);
    assert.equal(only.turns.length, 3, 'the zero group stays in a mixed window');
    assert.equal(only.dropped.length, 0);
    assert.equal(only.audit.length, 1, 'the zero is still recorded');
  }, 'a mixed window keeps its greeting instead of deleting it');
  await check(() => {
    const empty = extract.screenTurns([turn('好的'), turn('收到')]);
    assert.equal(empty.turns.length, 2);
    assert.equal(empty.dropped.length, 0);
    assert.equal(empty.wouldDrop.length, 2);
    assert.equal(empty.counts.scored0, 2);
  }, 'an all-zero window is retained; only wouldDrop describes the retired policy');

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
   * scoring is now observational, so it must not change calls or extracted facts.
   */
  await check(() => assert.equal(treated.calls, baseline.calls), 'score-only mode keeps the model call count unchanged');
  console.log(`   corpus calls: ${baseline.calls} -> ${treated.calls} (${(drop * 100).toFixed(1)}% saved on a command-heavy corpus)`);
  await check(() => {
    const filler = extract.screenTurns([turn('继续。'), turn('好的'), turn('收到')]);
    assert.equal(filler.turns.length, 3);
    assert.equal(filler.dropped.length, 0);
    assert.equal(filler.wouldDrop.length, 3);
    assert.equal(filler.counts.scored0, 3);
  }, 'a filler-only window is retained for the existing content gate');
  await check(() => assert.deepEqual(treated.applied, baseline.applied), 'the extracted facts are identical');
  await check(() => assert.ok(treated.applied.length >= 10), `the corpus really produced hits (${treated.applied.length})`);
  await check(() => assert.ok(treated.calls <= baseline.calls), 'screening never adds a model call');
  await check(() => assert.equal(treated.nodes, baseline.nodes), 'the same number of nodes is written');

  // F2 contracts consolidated from smoke-p88; all observations retain events.
  await check(() => {
    assert.equal(extract.screenEvent('npm is the package manager for this project'), 1);
  }, 'an English sentence that starts with a command name is not a zero');
  await check(() => {
    assert.equal(extract.screenEvent('git log --oneline -5'), 1);
    assert.equal(extract.screenEvent('/compact'), 1);
    assert.equal(extract.screenEvent('src/lib/store.js'), 1);
    assert.equal(extract.screenEvent('https://example.com/a?b=1'), 1);
  }, 'commands, slash commands, paths and URLs score 1, not 0');
  await check(() => {
    // A single character that is not a known greeting is content.
    assert.equal(extract.screenEvent('行'), 1);
    // Greetings and acknowledgements stay in the filler lists: option B keeps only
    // "no content at all" as a zero.
    assert.equal(extract.screenEvent('好'), 0);
    assert.equal(extract.screenEvent('ok'), 0);
  }, 'only the filler lists produce a zero, everything else is content');
  await check(() => {
    assert.equal(extract.screenEvent('   '), 0);
    assert.equal(extract.screenEvent(''), 0);
  }, 'only empty input is a zero on its own');

  await check(() => {
    const window = extract.screenTurns([
      { role: 'user', text: '记住：部署窗口固定在每周四晚上。' },
      { role: 'assistant', text: '好的。' },
      { role: 'user', text: '嗯' },
    ]);
    assert.equal(window.dropped.length, 0, 'a mixed window must not drop groups');
    assert.ok(window.turns.length >= 3, `all groups are kept (${window.turns.length})`);
  }, 'a mixed window keeps the zero groups instead of deleting them');
  await check(() => {
    const window = extract.screenTurns([
      { role: 'user', text: '' },
      { role: 'assistant', text: 'nothing to say' },
    ]);
    assert.equal(window.turns.length, 2);
    assert.equal(window.dropped.length, 0);
    assert.equal(window.wouldDrop.length, 2);
  }, 'an all-zero window is retained without a scoring-side consumption');
  await check(() => {
    const window = extract.screenTurns([{ role: 'user', text: '' }]);
    assert.equal(window.audit.length, 1);
    assert.equal(window.audit[0].rule, 'empty');
    assert.equal(window.audit[0].dropped, false);
    assert.equal(window.audit[0].wouldDrop, true);
    assert.ok(typeof window.audit[0].text === 'string');
  }, 'an observed zero leaves a hypothetical audit record with rule and text');


  // Exercise runExtract via pending replay, not just the scoring helper. The
  // local stream is a stub: this test never makes a model/network request.
  await check(async () => {
    const plugin = await import('../lib/index.js');
    const handlers = new Map();
    const prompts = [];
    let httpHandler;
    const ctx = {
      llm: { async *stream(request) {
        prompts.push(request.messages.flatMap((m) => m.content || []).map((b) => b.text || '').join('\n'));
        yield { type: 'text-delta', index: 0, text: '{"candidates":[]}' };
      } },
      logger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
      inject(_deps, fn) { fn(ctx); },
      on(name, fn) { handlers.set(name, fn); return () => {}; },
      effect(fn) { fn(); return () => {}; },
      tools: { register() { return () => {}; } },
      webServer: { register(def) { httpHandler = def.handler; return () => {}; } },
    };
    plugin.apply(ctx, {});
    async function replay(name, texts) {
      const cwd = join(root, name);
      await store.openWorkspaceDb(cwd);
      const turns = texts.map((text, i) => turn(text, 'user', { seq: i + 1, messageId: `${name}-${i}` }));
      await extract.savePending(cwd, { sessionId: `${name}-pending`, turns });
      const agent = { session: { id: name, header: { cwd }, requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }) }, inject() {} };
      await handlers.get('agent/created')({ agent });
      const req = Readable.from([]);
      req.method = 'GET'; req.url = `/api/dsh-trivium/status?cwd=${encodeURIComponent(cwd)}`;
      req.headers = {}; req.socket = { remoteAddress: '127.0.0.1' };
      let status, data;
      await httpHandler(req, { writeHead(n) { status = n; }, end(body) { data = JSON.parse(String(body)); } });
      assert.equal(status, 200);
      assert.equal(data.lastScreen.mode, 'score-only');
      assert.equal(data.lastScreen.dropped, 0);
      assert.notEqual(data.lastExtract.skippedBy, 'screen');
      assert.equal(extract.loadPending(cwd), null, 'the ordinary extraction path completes the replay');
      return data;
    }
    const filler = await replay('p75-filler', ['继续。']);
    assert.equal(filler.lastScreen.wouldDrop, 1);
    assert.equal(filler.lastScreen.audit[0].wouldDrop, true);
    assert.equal(filler.lastScreen.audit[0].dropped, false);
    assert.equal(filler.lastExtract.gate.reason, 'filler-only');
    assert.equal(prompts.length, 0, 'the existing content gate still avoids a filler-only call');
    const punctuation = await replay('p75-punctuation', ['!!!']);
    assert.equal(punctuation.lastScreen.wouldDrop, 1);
    assert.equal(prompts.length, 1, 'a score of zero cannot bypass the existing extraction gate');
    assert.ok(prompts[0].includes('user: !!!'));
    await replay('p75-order', ['继续。', 'marker-before-fact', '记住：marker-last-fact 使用 npm。']);
    const prompt = prompts.at(-1);
    const positions = ['user: 继续。', 'user: marker-before-fact', 'user: 记住：marker-last-fact 使用 npm。'].map((text) => prompt.indexOf(text));
    assert.ok(positions.every((n) => n >= 0));
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2], 'the actual model prompt keeps the original window order');
  }, 'score-only replay preserves zero events, chronology and the existing content gate');
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P75: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
