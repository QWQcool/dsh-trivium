/**
 * p86 — "which user turn is this" must survive a tool loop.
 *
 * Measured on a real host (2026-11-04): one user turn advanced `turnsSince` from
 * 0 to 4. The map then went full every few steps instead of every six turns, and
 * the per-turn delivery budget was reset at each step. The cause is the
 * identity-based fallback in `turnKeyOf`: a host that re-serializes history hands
 * the plugin fresh message objects, so the key changed at every pre-step.
 *
 * `mapTurnKeyOf` has to be stable across steps of one turn, and still change when
 * the person actually speaks again:
 *
 *   1. a host id wins when there is one;
 *   2. without ids, the same message text gives the same key across freshly built
 *      objects (the regression);
 *   3. different text gives a different key;
 *   4. plugin-injected messages are not user turns;
 *   5. tool results are not user turns;
 *   6. no user message at all gives an empty key (the caller must not count it).
 */
import assert from 'node:assert/strict';

const budget = await import('../lib/context-budget.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const user = (text, extra = {}) => ({ id: undefined, source: { kind: 'user' }, text, ...extra });
const assistant = (text) => ({ source: { kind: 'assistant' }, text });
const tool = (text) => ({ source: { kind: 'tool' }, text });

try {
  await check(() => {
    const key = budget.mapTurnKeyOf([user('第一句', { id: 'm-1' })]);
    assert.equal(key, 'uid:m-1');
  }, 'a host id wins');
  await check(() => {
    const key = budget.mapTurnKeyOf([{ source: { kind: 'user', messageId: 'm-2' }, text: 'x' }]);
    assert.equal(key, 'uid:m-2');
  }, 'a source messageId also counts as an id');

  // The regression: fresh objects, same text, no ids.
  await check(() => {
    const first = budget.mapTurnKeyOf([user('记住：发布前跑全量回归。')]);
    const second = budget.mapTurnKeyOf([user('记住：发布前跑全量回归。'), assistant('好的。')]);
    assert.equal(first, second);
    assert.ok(first.startsWith('txt:'), `expected the text fallback, got ${first}`);
  }, 'the same user text keeps one key across pre-steps');
  await check(() => {
    const a = budget.mapTurnKeyOf([user('第一句')]);
    const b = budget.mapTurnKeyOf([user('第一句'), assistant('x'), user('第二句')]);
    assert.notEqual(a, b);
  }, 'a new user message is a new turn');
  await check(() => {
    const a = budget.mapTurnKeyOf([user('a')]);
    const b = budget.mapTurnKeyOf([user('a'), user('b')]);
    assert.notEqual(a, b);
  }, 'two user messages never collapse into one key');

  // The plugin's own injections must not look like the person speaking.
  await check(() => {
    const real = budget.mapTurnKeyOf([user('记住：跑回归。')]);
    const injected = budget.mapTurnKeyOf([
      user('记住：跑回归。'),
      { source: { kind: 'plugin:dsh-trivium', plugin: 'dsh-trivium' }, text: '短地图……' },
    ]);
    assert.equal(real, injected);
  }, 'a plugin-injected message does not start a new turn');
  await check(() => {
    const injectedOnly = budget.mapTurnKeyOf([{ source: { kind: 'plugin', plugin: 'dsh-trivium' }, text: 'x' }]);
    assert.equal(injectedOnly, '');
  }, 'injections alone are not a turn');

  await check(() => {
    const withTool = budget.mapTurnKeyOf([user('跑一下'), assistant('执行中'), tool('ok')]);
    const without = budget.mapTurnKeyOf([user('跑一下')]);
    assert.equal(withTool, without);
  }, 'tool results do not start a new turn');
  await check(() => assert.equal(budget.mapTurnKeyOf([]), ''), 'no messages means no turn');
  await check(() => assert.equal(budget.mapTurnKeyOf([assistant('只有助手')]), ''), 'assistant-only is not a turn');
} finally {
  // nothing to clean up
}

console.log(`P86: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
