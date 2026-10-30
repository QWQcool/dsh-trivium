/**
 * p50 (W1) — source events must carry real host locators through buffer, pending
 * and write, and a model-written quote must never become user evidence.
 *
 * Written before the implementation: every assertion below fails on 0.8.2.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p50-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const src = await import('../lib/source-events.js');
const extract = await import('../lib/extract.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

// Real host event shapes, copied from an observed session/event stream.
const userEvent = (text, seq = 11, id = 'b444c5c4-0214-4040-abe8-a41bfe79261c', time = 1793279146761) => ({
  type: 'user/message',
  seq,
  time,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id },
});
const pluginEvent = (text) => ({
  type: 'user/message',
  seq: 10,
  time: 1793279146760,
  data: { content: [{ type: 'text', text }], source: { kind: 'plugin:dsh-trivium', form: 'snapshot' }, role: 'user', id: 'map-1' },
});
const assistantEvent = (text, seq = 19) => ({
  type: 'assistant/message',
  seq,
  turn: 1,
  data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text }], id: 'a-1' }, usage: {}, stream: true },
});
const toolEvent = (text, ok = true) => ({
  type: 'tool/result',
  seq: 62,
  turn: 3,
  data: { turn: 3, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text }], isError: !ok, id: 't-1' } },
});

try {
  // 1. a real user event keeps every locator the host actually provides
  const userTurn = src.turnFromEvent(userEvent('记住：生产端口是 9443。'));
  check(() => assert.equal(userTurn.role, 'user'), 'user event becomes a user turn');
  check(() => assert.equal(userTurn.seq, 11), 'event sequence is kept');
  check(() => assert.equal(userTurn.messageId, 'b444c5c4-0214-4040-abe8-a41bfe79261c'), 'message id is kept');
  check(() => assert.equal(userTurn.at, new Date(1793279146761).toISOString()), 'source time is kept as an absolute timestamp');
  check(() => assert.equal(userTurn.recorded, true), 'a turn with a locator reports itself as recorded');

  // 2. our own injected map is not user evidence and is not buffered
  check(() => assert.equal(src.turnFromEvent(pluginEvent('dsh-trivium memory map: …')), null), 'plugin-injected message is not buffered');

  // 3. assistant and tool turns are labelled, never "user"
  const aTurn = src.turnFromEvent(assistantEvent('采用方案 CedarPlan。'));
  check(() => assert.equal(aTurn.role, 'assistant'), 'assistant event keeps its role');
  const tTurn = src.turnFromEvent(toolEvent('生产端口是 9443。'));
  check(() => assert.equal(tTurn.role, 'tool'), 'tool event keeps its role');
  check(() => assert.equal(tTurn.ok, true), 'tool result keeps its ok flag');

  // 4. missing locators degrade to unknown, never to a made-up value
  const bare = src.turnFromEvent({ type: 'user/message', data: { content: [{ type: 'text', text: '没有定位信息。' }], source: { kind: 'user' } } });
  check(() => assert.equal(bare.seq, null), 'missing sequence is null');
  check(() => assert.equal(bare.messageId, null), 'missing message id is null');
  check(() => assert.equal(bare.at, null), 'missing time is null');
  check(() => assert.equal(bare.recorded, false), 'a turn without locators reports itself as not recorded');

  // 5. a quote that matches a user turn becomes user evidence with its locators
  const turns = [userTurn];
  const matched = src.buildSource({ quote: '记住：生产端口是 9443。', turns, sessionId: 's1', via: 'extract' });
  check(() => assert.equal(matched.quoteMatch, 'exact'), 'an exact quote is recognised as exact');
  check(() => assert.equal(matched.role, 'user'), 'the source role is user');
  check(() => assert.equal(matched.messageId, userTurn.messageId), 'the source carries the matched message id');
  check(() => assert.equal(matched.seq, 11), 'the source carries the matched sequence');
  check(() => assert.equal(src.isUserEvidence(matched), true), 'a matched user quote counts as user evidence');

  // 6. the same words written by the assistant are not user evidence
  const aiOnly = src.buildSource({ quote: '采用方案 CedarPlan。', turns: [aTurn], sessionId: 's1', via: 'extract' });
  check(() => assert.equal(aiOnly.role, 'assistant'), 'assistant wording keeps the assistant role');
  check(() => assert.equal(src.isUserEvidence(aiOnly), false), 'assistant wording is not user evidence');

  // 7. an unmatched quote is kept but marks the source as unmatched
  const unmatched = src.buildSource({ quote: '我从没这么说。', turns, sessionId: 's1', via: 'extract' });
  check(() => assert.equal(unmatched.quoteMatch, 'none'), 'an unmatched quote is reported as none');
  check(() => assert.equal(unmatched.role, 'unknown'), 'an unmatched quote has an unknown role');
  check(() => assert.equal(unmatched.quote, '我从没这么说。'), 'the quote is still displayed');
  check(() => assert.equal(src.isUserEvidence(unmatched), false), 'an unmatched quote is not user evidence');

  // 8. pending keeps the locators unchanged (no re-timestamping on replay)
  const cwd = join(root, 'ws');
  await extract.savePending(cwd, { sessionId: 's1', turns });
  const back = extract.loadPending(cwd);
  check(() => assert.equal(back.turns[0].messageId, userTurn.messageId), 'pending keeps the message id');
  check(() => assert.equal(back.turns[0].at, userTurn.at), 'pending keeps the original source time');
  check(() => assert.equal(back.turns[0].seq, 11), 'pending keeps the sequence');

  // 9. an old pending file without the new fields still loads, fields unknown
  const legacy = join(root, 'ws-legacy');
  await extract.savePending(legacy, { sessionId: 's0', turns: [{ role: 'user', text: '旧数据。' }] });
  const legacyBack = extract.loadPending(legacy);
  check(() => assert.equal(legacyBack.turns[0].text, '旧数据。'), 'legacy pending still loads');
  check(() => assert.equal(src.turnLocator(legacyBack.turns[0]).known, false), 'legacy turn reports an unknown locator');

  // 10. the same sentence twice is two events; a retried event is one
  const twice = [src.turnFromEvent(userEvent('同一句。', 11, 'm-1')), src.turnFromEvent(userEvent('同一句。', 12, 'm-2'))];
  check(() => assert.equal(twice.length, 2), 'two identical sentences stay two turns');
  check(() => assert.notEqual(twice[0].messageId, twice[1].messageId), 'identical text does not collapse two events');
  const appended = [];
  src.appendSourceTurn(appended, twice[0]);
  src.appendSourceTurn(appended, twice[0]);
  check(() => assert.equal(appended.length, 1), 'a retried event is not registered twice');
  src.appendSourceTurn(appended, { ...twice[0], text: '同一定位符但内容不同。' });
  src.appendSourceTurn(appended, { ...twice[0], role: 'tool', name: 'test', ok: false });
  src.appendSourceTurn(appended, { ...twice[0], role: 'tool', name: 'test', ok: true });
  check(() => assert.equal(appended.length, 4), 'reused locator keeps changed text, role, and tool outcome');
  const seqOnly = [];
  src.appendSourceTurn(seqOnly, { role: 'user', seq: 7, text: '第一条' });
  src.appendSourceTurn(seqOnly, { role: 'user', seq: 7, text: '第二条' });
  src.appendSourceTurn(seqOnly, { role: 'user', seq: 7, text: '第二条' });
  check(() => assert.equal(seqOnly.length, 2), 'reused sequence keeps changed text while exact retry deduplicates');

  // 11. the write path stores the source on the node
  const store = await import('../lib/store.js');
  const db = await store.openWorkspaceDb(join(root, 'db'));
  const applied = extract.applyCandidates(db, [{ type: 'decision', name: '端口', text: '生产端口是 9443。', quote: '记住：生产端口是 9443。' }], {
    sessionId: 's1',
    sourceTurns: [userTurn],
  });
  const node = db.get(applied[0]?.id)?.payload || {};
  check(() => assert.equal(node.source?.messageId, userTurn.messageId), 'the written node keeps the source message id');
  check(() => assert.equal(node.source?.seq, 11), 'the written node keeps the source sequence');
  check(() => assert.equal(node.source?.role, 'user'), 'the written node keeps the source role');
  check(() => assert.equal(node.source?.quoteMatch, 'exact'), 'the written node keeps the quote match result');

  // 12. replay from pending keeps the original source time, not the replay time
  const replayTurns = extract.loadPending(cwd).turns;
  const replayed = await extract.distill({
    db,
    turns: replayTurns,
    sessionId: 's1',
    llmCall: async () => JSON.stringify({ candidates: [{ type: 'decision', name: '重放端口', text: '生产端口是 9443。', quote: '记住：生产端口是 9443。' }] }),
  });
  const replayedNode = db.get(replayed.applied[0]?.id)?.payload || {};
  check(() => assert.equal(replayedNode.source?.at, userTurn.at), 'replay keeps the original source time');
  check(() => assert.equal(replayedNode.source?.messageId, userTurn.messageId), 'replay keeps the original message id');
  check(() => assert.notEqual(replayedNode.source?.capturedAt, replayedNode.source?.at), 'replay time and source time are separate fields');

  // 13. the read projection separates "recorded", "locator known" and "host text"
  const prov = await import('../lib/provenance.js');
  const fresh = prov.provenanceOf(db, applied[0].id);
  check(() => assert.equal(fresh.locatorKnown, true), 'a fresh node reports a known locator');
  check(() => assert.equal(fresh.source.role, 'user'), 'the projection reports the source role');
  check(() => assert.equal(fresh.source.quoteMatch, 'exact'), 'the projection reports the quote match');
  check(() => assert.equal(fresh.source.hostText, 'unavailable'), 'the projection admits the host text cannot be re-read');

  const legacyNode = store.insertNode(db, { type: 'decision', name: '旧条目', text: '没有来源。' });
  const legacyProv = prov.provenanceOf(db, legacyNode);
  check(() => assert.equal(legacyProv.status, 'missing'), 'a node without a source reports missing');
  check(() => assert.equal(legacyProv.source, null), 'a missing source is null, not fabricated');

  const quoteOnly = store.insertNode(db, {
    type: 'decision',
    name: '只有摘录',
    text: '只有摘录。',
    source: { kind: 'extract', via: 'extract', sessionId: 's9', quote: '只有摘录。' },
  });
  const quoteOnlyProv = prov.provenanceOf(db, quoteOnly);
  check(() => assert.equal(quoteOnlyProv.locatorKnown, false), 'a source without a locator says so');
  check(() => assert.equal(quoteOnlyProv.source.quote, '只有摘录。'), 'the quote is still displayed');
  store.closeAll();
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P50: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
