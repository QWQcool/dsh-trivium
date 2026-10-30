/**
 * p49 — an invented absolute date is dropped, the fact itself is kept.
 *
 * A-5 caught "On 2026-04-06 (per conversation context), user corrected: ..." in a
 * session that ran on 2026-10-30. A date the conversation never contained is not a
 * detail worth losing the whole fact over, so it is removed and reported; if the
 * date was the whole content the candidate is refused instead.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p49-'));
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
const one = (candidate) => async () => JSON.stringify({ candidates: [candidate] });

try {
  const db = await store.openWorkspaceDb(join(root, 'ws'));

  // 1. invented date in a leading clause is removed, the fact survives
  const invented = await extract.distill({
    db,
    turns: [{ role: 'user', text: '更正：不再使用旧方案 A，改用方案 B。' }],
    sessionId: 'p49',
    llmCall: one({ type: 'decision', name: '方案 B', text: 'On 2026-04-06 (per conversation context), user corrected: switch from plan A to plan B.' }),
  });
  const stored = String(invented.applied[0]?.text || '');
  check(() => assert.equal(invented.applied.length, 1), 'the fact is still written');
  check(() => assert.doesNotMatch(stored, /2026-04-06/), 'the invented date is gone from the stored text');
  check(() => assert.match(stored, /switch from plan A to plan B/i), 'the fact body survives');
  check(() => assert.equal(invented.adjusted.length, 1), 'the removal is reported');
  check(() => assert.deepEqual(invented.adjusted[0].removed, ['2026-04-06']), 'the removed date is named');

  // 2. a date that really appeared in the window is kept as-is
  const real = await extract.distill({
    db,
    turns: [{ role: 'user', text: '2026-10-30 起，发布前必须先跑 smoke。' }],
    sessionId: 'p49',
    llmCall: one({ type: 'decision', name: '发布前置', text: '2026-10-30 起，发布前必须先跑 smoke。' }),
  });
  check(() => assert.match(String(real.applied[0]?.text || ''), /2026-10-30/), 'a supported date is kept');
  check(() => assert.equal(real.adjusted.length, 0), 'nothing is reported when the date is supported');

  // 3. the same date written in another format still counts as supported
  const otherFormat = await extract.distill({
    db,
    turns: [{ role: 'user', text: '截止日期是 2026年12月31日。' }],
    sessionId: 'p49',
    llmCall: one({ type: 'decision', name: '截止日期', text: '预算截止 2026-12-31。' }),
  });
  check(() => assert.match(String(otherFormat.applied[0]?.text || ''), /2026-12-31/), 'format differences do not count as invented');
  check(() => assert.equal(otherFormat.adjusted.length, 0), 'no adjustment for a cross-format match');

  // 4. if the date was the whole content, refuse instead of storing a stub
  const stub = await extract.distill({
    db,
    // Not filler, so the gate really calls the model and the candidate is seen.
    turns: [{ role: 'user', text: '把发布日期记一下。' }],
    sessionId: 'p49',
    llmCall: one({ type: 'decision', name: '日期', text: '2026-04-06' }),
  });
  check(() => assert.equal(stub.applied.length, 0), 'a date-only candidate is not stored');
  check(() => assert.equal(stub.skipped.some((row) => row.reason === 'unsupported-date'), true), 'the refusal is named unsupported-date');

  // 5. dates inside the fact body (not a leading clause) are also handled
  const inlineDate = await extract.distill({
    db,
    turns: [{ role: 'user', text: '负责人换成李四。' }],
    sessionId: 'p49',
    llmCall: one({ type: 'decision', name: '负责人', text: '负责人换成李四（2025-01-01 确认）。' }),
  });
  check(() => assert.doesNotMatch(String(inlineDate.applied[0]?.text || ''), /2025-01-01/), 'an inline invented date is removed');
  check(() => assert.match(String(inlineDate.applied[0]?.text || ''), /李四/), 'the fact body still survives');

  // 6. a relative expression the model resolved correctly keeps its date
  const NOW = new Date('2026-10-30T00:00:00Z');
  const resolved = await extract.distill({
    db,
    turns: [{ role: 'user', text: '下周五之前必须提交。' }],
    sessionId: 'p49',
    now: NOW,
    llmCall: one({ type: 'decision', name: '提交期限', text: '2026-11-06 之前必须提交。' }),
  });
  check(() => assert.match(String(resolved.applied[0]?.text || ''), /2026-11-06/), 'a correctly resolved relative date is kept');
  check(() => assert.equal(resolved.adjusted.length, 0), 'the resolved date is not reported as invented');

  // 7. the allowance does not cover a date far outside the plausible window
  const farOff = await extract.distill({
    db,
    turns: [{ role: 'user', text: '下周五之前必须提交。' }],
    sessionId: 'p49',
    now: NOW,
    llmCall: one({ type: 'decision', name: '提交期限', text: '2020-01-01 之前必须提交。' }),
  });
  check(() => assert.doesNotMatch(String(farOff.applied[0]?.text || ''), /2020-01-01/), 'a far-off date is still removed');
  check(() => assert.equal(farOff.adjusted.length, 1), 'the far-off removal is reported');

  store.closeAll();
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P49: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
