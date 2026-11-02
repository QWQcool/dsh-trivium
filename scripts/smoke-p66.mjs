/**
 * p66 — an empty extraction answer for a window that states a decision gets one
 * more question, and the outcome is visible either way.
 *
 * W8 live run (2026-11-02): the model answered {"candidates":[]} to
 * "这次上线按方案 A 走。" and again to "上一个方案不要了，走新的，用方案 B。", the
 * window was consumed as a success, and both decisions were lost silently.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p66-'));
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

const turn = (text) => ({ role: 'user', text, seq: 1, messageId: 'm-1', at: '2026-11-02T09:00:00.000Z', recorded: true });
const DECISION = '这次上线按方案 A 走。';

/** A stub model that answers from a script and records every prompt it saw. */
function scripted(answers) {
  const prompts = [];
  const call = async (prompt) => {
    prompts.push(prompt);
    const next = answers[Math.min(prompts.length - 1, answers.length - 1)];
    return typeof next === 'function' ? next(prompt) : next;
  };
  return { call, prompts };
}

try {
  // 1. empty, then the fact: one extra question, and it is written
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-1'));
    const stub = scripted([
      JSON.stringify({ candidates: [] }),
      JSON.stringify({ candidates: [{ type: 'decision', name: '上线方案', text: '按方案 A 走', quote: '这次上线按方案 A 走。' }] }),
    ]);
    const out = await extract.distill({ db, turns: [turn(DECISION)], sessionId: 's', llmCall: stub.call });
    check(() => assert.equal(stub.prompts.length, 2), 'the model is asked a second time');
    check(() => assert.match(stub.prompts[1], /previous attempt/i), 'the second question says why it is being asked');
    check(() => assert.equal(out.applied.length, 1), 'the decision is written after the retry');
    check(() => assert.equal(out.emptySuspicious, false), 'a recovered window is not reported as suspicious');
    store.closeAll();
  }

  // 2. empty twice: bounded at two calls, and the loss is visible
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-2'));
    const stub = scripted([JSON.stringify({ candidates: [] })]);
    const out = await extract.distill({ db, turns: [turn(DECISION)], sessionId: 's', llmCall: stub.call });
    check(() => assert.equal(stub.prompts.length, 2), 'the retry happens exactly once');
    check(() => assert.equal(out.applied.length, 0), 'nothing is written when the model insists');
    check(() => assert.equal(out.emptySuspicious, true), 'the suspicious empty window is reported');
    store.closeAll();
  }

  // 3. an ordinary window is not re-asked: the gate stays cheap
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-3'));
    const stub = scripted([JSON.stringify({ candidates: [] })]);
    const out = await extract.distill({ db, turns: [turn('今天天气不错，适合散步。')], sessionId: 's', llmCall: stub.call });
    check(() => assert.equal(stub.prompts.length, 1), 'a window with no decision is asked only once');
    check(() => assert.equal(out.emptySuspicious, false), 'and is not flagged');
    store.closeAll();
  }

  // 4. a rule already wrote something, so an empty model answer is not suspicious
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-4'));
    const stub = scripted([JSON.stringify({ candidates: [] })]);
    const out = await extract.distill({
      db,
      turns: [turn('记住：以后都用 pnpm，别再用 npm。')],
      sessionId: 's',
      llmCall: stub.call,
    });
    const ruleWrote = out.ruleCount > 0 || out.applied.length > 0;
    check(() => assert.equal(ruleWrote, true), 'the rule layer handled this window');
    check(() => assert.equal(stub.prompts.length, 1), 'no retry when a rule already found the fact');
    store.closeAll();
  }

  // 5. a failed call (no text at all) is still a failure, not a suspicious empty
  {
    const db = await store.openWorkspaceDb(join(root, 'ws-5'));
    const out = await extract.distill({ db, turns: [turn(DECISION)], sessionId: 's', llmCall: async () => '' });
    check(() => assert.equal(out.llmFailed, true), 'an empty answer is a failure so the window stays pending');
    check(() => assert.equal(out.emptySuspicious, false), 'a failure is not reported as a suspicious empty');
    store.closeAll();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P66: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
