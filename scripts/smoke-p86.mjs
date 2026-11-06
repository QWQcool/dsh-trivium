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
    budget.resetTurnKeys();
    const first = budget.mapTurnKeyOf([user('记住：发布前跑全量回归。')], { sessionId: 's1' });
    const second = budget.mapTurnKeyOf([user('记住：发布前跑全量回归。'), assistant('好的。')], { sessionId: 's1' });
    assert.equal(first, second);
    assert.ok(first.startsWith('t:'), `expected the turn counter fallback, got ${first}`);
  }, 'the same user text keeps one key across pre-steps');
  /*
   * Audit F4 (2026-11-04): the two failures the reviewer reproduced.
   */
  await check(() => {
    budget.resetTurnKeys();
    const two = budget.mapTurnKeyOf([user('第一句'), user('第二句')], { sessionId: 's2' });
    // The window shrank (compaction / fixed-length history) but the last message is
    // the same: still the same turn, so the spent budget must not come back.
    const truncated = budget.mapTurnKeyOf([user('第二句')], { sessionId: 's2' });
    assert.equal(truncated, two, 'a shorter history is not a new turn');
  }, 'truncating the history does not start a new turn');
  await check(() => {
    budget.resetTurnKeys();
    const first = budget.mapTurnKeyOf([user('继续。')], { sessionId: 's3' });
    // A fixed-length window that always shows the same text: we cannot tell a new
    // message from the same one, so the turn is kept (see the note in the module).
    const again = budget.mapTurnKeyOf([user('继续。')], { sessionId: 's3' });
    assert.equal(again, first, 'an unchanged fixed window stays one turn');
  }, 'a fixed-length window with identical text does not fake new turns');
  await check(() => {
    budget.resetTurnKeys();
    const a = budget.mapTurnKeyOf([user('第一句')], { sessionId: 's4' });
    const b = budget.mapTurnKeyOf([user('第一句'), user('第二句')], { sessionId: 's4' });
    assert.notEqual(a, b);
  }, 'another user message is another turn');
  await check(() => {
    budget.resetTurnKeys();
    const a = budget.mapTurnKeyOf([user('同一句')], { sessionId: 's5' });
    const b = budget.mapTurnKeyOf([user('同一句')], { sessionId: 's6' });
    assert.equal(a, 't:1');
    assert.equal(b, 't:1', 'sessions keep independent counters');
  }, 'turn counters are per session');
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
  /*
   * Second audit (2026-11-05): a pre-step with no user message handed "" to the
   * ledger, which read as a new turn and re-granted the whole budget (300 spent,
   * then another 138 injected in the same turn). The helper has to carry the open
   * turn forward, and the budget must not move.
   */
  await check(async () => {
    const ledger = await import('../lib/turn-ledger.js');
    const session = 'p86-ledger';
    const key = 't:1';
    ledger.beginTurn(session, key);
    // Spending is visible through the delivered set, which is what `beginTurn`
    // clears when it believes a new turn started.
    ledger.deliveredOf(session, key).add(7);
    const booked = ledger.reserve(session, key, [{ id: 7, tokens: 300 }]);
    ledger.commit(booked);
    const spentBefore = ledger.spentOf(session, key);
    assert.equal(spentBefore, 300, 'fixture: the whole allowance was spent');
    const carried = ledger.resolveTurnKeyForLedger('', session);
    assert.equal(carried, key, 'an empty observation carries the open turn');
    const state = ledger.beginTurn(session, carried);
    assert.equal(state.turnKey, key, 'the ledger stays on the same turn');
    assert.equal(ledger.deliveredOf(session, carried).has(7), true, 'delivered records are not reset');
    assert.equal(ledger.spentOf(session, carried), spentBefore, 'the spent 300 tokens are not re-granted');
  }, 'a pre-step without a user message does not restart the turn budget');

  await check(() => {
    budget.resetTurnKeys();
    const contentOnly = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
    const first = budget.mapTurnKeyOf([contentOnly('第一轮问题')], { sessionId: 'content-only' });
    const second = budget.mapTurnKeyOf([contentOnly('第二轮不同问题')], { sessionId: 'content-only' });
    assert.equal(first, 't:1');
    assert.equal(second, 't:2', 'different text in content[] must not collapse into one turn');
  }, 'id-less content[] messages keep distinct turn keys (F86-01)');

  await check(() => assert.equal(budget.mapTurnKeyOf([]), ''), 'no messages means no turn');
  await check(() => assert.equal(budget.mapTurnKeyOf([assistant('只有助手')]), ''), 'assistant-only is not a turn');
} finally {
  // nothing to clean up
}

console.log(`P86: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
