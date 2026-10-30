/**
 * p52 (W3) — dates must be anchored on the sentence that supports the fact.
 *
 * F-W02 (before): with a fixed anchor of 2026-10-30, "明天复盘工作。" authorised a
 * candidate dated 2027-03-01, because the gate accepted any date inside a wide
 * [now-7d, now+400d] window. Resolution is now anchored on the matched user
 * turn's own timestamp in Asia/Shanghai, and only one determinate expression per
 * sentence may authorise a date.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p52-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');
const dates = await import('../lib/date-parse.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

// Asia/Shanghai is UTC+8: 2026-10-30 09:00 local == 01:00Z.
const at = (iso) => new Date(iso).toISOString();
const turn = (text, when, seq = 1) => ({ role: 'user', text, seq, messageId: `m-${seq}`, at: at(when) });
const one = (candidate) => async () => JSON.stringify({ candidates: [candidate] });

async function run(db, sentence, when, candidateText, seq = 1) {
  return extract.distill({
    db,
    turns: [turn(sentence, when, seq)],
    sessionId: 's',
    llmCall: one({ type: 'decision', name: '日期条目', text: candidateText, quote: sentence }),
  });
}
const storedText = (out) => String(out.applied[0]?.text || '');

try {
  const db = await store.openWorkspaceDb(join(root, 'ws'));

  // 1. F-W02: "明天" authorises exactly one date
  const fw02 = await run(db, '明天复盘工作。', '2026-10-30T09:00:00+08:00', '我们定于 2027-03-01 复盘工作。');
  check(() => assert.doesNotMatch(storedText(fw02), /2027-03-01/), 'F-W02: 明天 no longer authorises a date seven months away');
  check(() => assert.equal(fw02.adjusted[0]?.reason, 'unsupported-date'), 'F-W02: the removal is reported with a reason');
  const tomorrow = await run(db, '明天复盘工作。', '2026-10-30T09:00:00+08:00', '我们定于 2026-10-31 复盘工作。', 2);
  check(() => assert.match(storedText(tomorrow), /2026-10-31/), '明天 resolves to the next calendar day');
  check(() => assert.equal(tomorrow.adjusted.length, 0), 'a correctly resolved date is not reported');

  // 2. 下周五 from a Friday anchors to the following week, not this one
  const nextFriday = await run(db, '下周五之前必须提交。', '2026-10-30T09:00:00+08:00', '2026-11-06 之前必须提交。', 3);
  check(() => assert.match(storedText(nextFriday), /2026-11-06/), '下周五 resolves to 2026-11-06');
  const wrongWeek = await run(db, '下周五之前必须提交。', '2026-10-30T09:00:00+08:00', '2026-11-07 之前必须提交。', 4);
  check(() => assert.doesNotMatch(storedText(wrongWeek), /2026-11-07/), 'a neighbouring date is not accepted for 下周五');

  // 3. cross-month and leap-year boundaries
  const crossMonth = await run(db, '明天上线。', '2026-10-31T09:00:00+08:00', '2026-11-01 上线。', 5);
  check(() => assert.match(storedText(crossMonth), /2026-11-01/), '明天 crosses the month boundary correctly');
  const leap = await run(db, '明天开会。', '2024-02-28T09:00:00+08:00', '2024-02-29 开会。', 6);
  check(() => assert.match(storedText(leap), /2024-02-29/), '明天 lands on the leap day');

  // 4. an impossible calendar date is rejected as invalid, not as unsupported
  const invalid = await run(db, '明天复盘。', '2026-10-30T09:00:00+08:00', '复盘时间为 2026-02-30。', 7);
  check(() => assert.doesNotMatch(storedText(invalid), /2026-02-30/), 'an impossible date is removed');
  check(() => assert.equal(invalid.adjusted[0]?.reason, 'invalid-date'), 'invalid dates get their own reason');

  // 5. two relative expressions in one sentence authorise neither
  const two = await run(db, '方案 A 明天上线，方案 B 后天上线。', '2026-10-30T09:00:00+08:00', '方案 A 的日期是 2026-10-31。', 8);
  check(() => assert.doesNotMatch(storedText(two), /2026-10-31/), 'two expressions in one sentence do not authorise a date');

  // 6. a literal date in the window is always allowed
  const literal = await run(db, '截止日期是 2026-12-31。', '2026-10-30T09:00:00+08:00', '预算截止 2026-12-31。', 9);
  check(() => assert.match(storedText(literal), /2026-12-31/), 'a date written in the window is kept');

  // 7. replay keeps the source anchor, not the replay day
  const replay = await extract.distill({
    db,
    turns: [turn('明天复盘工作。', '2026-10-30T09:00:00+08:00', 10)],
    sessionId: 's',
    llmCall: one({ type: 'decision', name: '复盘日期', text: '2026-10-31 复盘。', quote: '明天复盘工作。' }),
  });
  check(() => assert.match(String(replay.applied[0]?.text || ''), /2026-10-31/), 'replay resolves 明天 from the source time');

  // 8. undeterminate wording stays undeterminate
  const vague = await run(db, '以后再说上线时间。', '2026-10-30T09:00:00+08:00', '上线时间是 2027-01-01。', 11);
  check(() => assert.doesNotMatch(storedText(vague), /2027-01-01/), '以后 does not authorise a concrete date');

  // 9. unit level: the resolver itself, including Monday-based weeks
  check(() => assert.deepEqual(dates.resolveRelative('明天', Date.parse('2026-10-30T01:00:00Z')).map((r) => r.key), ['2026-10-31']), 'resolver: 明天');
  check(() => assert.deepEqual(dates.resolveRelative('下周一', Date.parse('2026-10-30T01:00:00Z')).map((r) => r.key), ['2026-11-02']), 'resolver: 下周一 is Monday of next week');
  check(() => assert.deepEqual(dates.resolveRelative('本周一', Date.parse('2026-10-30T01:00:00Z')).map((r) => r.key), ['2026-10-26']), 'resolver: 本周一 is Monday of this week');
  check(() => assert.deepEqual(dates.resolveRelative('月底前', Date.parse('2026-10-30T01:00:00Z')), []), 'resolver: 月底前 is not made precise');
  check(() => assert.equal(dates.isValidYmd(2026, 2, 30), false), 'resolver: 2026-02-30 is not a date');
  check(() => assert.equal(dates.isValidYmd(2024, 2, 29), true), 'resolver: 2024-02-29 is a date');
  store.closeAll();
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P52: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
