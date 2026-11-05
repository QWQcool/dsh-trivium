/**
 * p88 — the two audit findings that live in the pre-step (F2 and F3).
 *
 * F2: screening must not turn a real sentence into a silent zero. The audit showed
 * "npm is the package manager for this project" scored 0 because the command rule
 * accepted a command name followed by arbitrary words, and that zero groups were
 * deleted even from a mixed window that was otherwise extracted.
 *
 * F3: the map diff has to go through the map budget. It used to allow six lines per
 * category (18 in total, measured at 794 estimated tokens) against a 400 budget.
 */
import assert from 'node:assert/strict';

const extract = await import('../lib/extract.js');
const index = await import('../lib/index.js');
const tokens = await import('../lib/tokens.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

try {
  // ---- F2: what may still be zero -------------------------------------------
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
    assert.ok(window.turns.length === 0);
    assert.equal(window.dropped.length, 2);
  }, 'an all-zero window is still consumed without a call');
  await check(() => {
    const window = extract.screenTurns([{ role: 'user', text: '' }]);
    assert.equal(window.audit.length, 1);
    assert.equal(window.audit[0].rule, 'empty');
    assert.equal(window.audit[0].dropped, true);
    assert.ok(typeof window.audit[0].text === 'string');
  }, 'a screened window leaves an audit record with rule and text');

  // ---- F3: the diff must obey the map budget -------------------------------
  const entry = (id, label) => ({ id, label });
  const many = (prefix, count) => Array.from({ length: count }, (_, i) => entry(i + 1, `${prefix}${i} 很长的事实标题用于撑大差异文本`));
  await check(() => {
    const previous = { version: 'v1', entries: many('old', 6) };
    const report = { version: 'v2', entries: [...many('old', 6), ...many('new', 12)], hidden: 0 };
    const diff = index.buildMapDiff(previous, report, { tokenBudget: 400 });
    assert.ok(diff.text.length > 0);
    assert.ok(diff.lines <= 19, `line count is bounded (${diff.lines})`);
    assert.ok(tokens.estimateTokens(diff.text) <= 400, 'a 12-line diff still fits the budget');
  }, 'the diff reports how many rows it left out');
  await check(() => {
    const previous = { version: 'v1', entries: many('old', 40) };
    const report = { version: 'v2', entries: many('new', 40), hidden: 0 };
    const diff = index.buildMapDiff(previous, report, { tokenBudget: 400 });
    const used = tokens.estimateTokens(diff.text);
    assert.ok(used <= 400, `diff stays inside the budget (${used})`);
    const tight = index.buildMapDiff(previous, report, { tokenBudget: 40 });
    assert.ok(tokens.estimateTokens(tight.text) <= 40 || tight.lines === 1, `a 40-token budget is honoured (${tokens.estimateTokens(tight.text)})`);
    assert.ok(tight.omitted > 0, `clipping reports how many rows it dropped (${tight.omitted})`);
  }, 'a large diff is clipped to the map budget');
  await check(() => {
    const previous = { version: 'v1', entries: [] };
    const report = { version: 'v2', entries: [entry(1, '一个')], hidden: 0 };
    const diff = index.buildMapDiff(previous, report, { tokenBudget: 400 });
    assert.ok(diff.text.includes('+一个'));
    assert.equal(diff.omitted, 0);
  }, 'a small diff is not clipped');
} finally {
  // nothing to clean up
}

console.log(`P88: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
