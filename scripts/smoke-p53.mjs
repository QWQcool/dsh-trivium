/**
 * p53 (W4) — the change record is bounded, redacted, idempotent and per workspace.
 *
 * The audit is a management surface: it is never injected into model context, and
 * a value that fails the write gate must never reach the file in the first place
 * (hiding it in the UI would not be a boundary).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p53-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const log = await import('../lib/change-log.js');

let checks = 0;
let failures = 0;
function check(fn, label) {
  checks += 1;
  try { fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const ws = join(root, 'ws');
try {
  // 1. newest first, with stable fields
  log.noteChanges(ws, [
    { reason: 'written', opId: 'op-1', nodeId: 1, type: 'decision', preview: '第一条。', source: { role: 'user', messageId: 'm-1', seq: 3, quoteMatch: 'exact' } },
    { reason: 'rejected', opId: 'op-2', type: 'preference', preview: '<redacted>', detail: 'secret' },
  ]);
  const first = log.readChanges(ws);
  check(() => assert.equal(first.total, 2), 'both entries are stored');
  check(() => assert.equal(first.entries[0].opId, 'op-2'), 'the newest entry comes first');
  check(() => assert.equal(first.entries[1].source.seq, 3), 'the source locator is kept');
  check(() => assert.equal(first.entries[1].reason, 'written'), 'the reason code is preserved');

  // 2. every reason code has bilingual labels
  for (const code of Object.values(log.CHANGE_REASONS)) {
    check(() => assert.ok(log.CHANGE_LABELS[code]?.en && log.CHANGE_LABELS[code]?.zh), `label exists for ${code}`);
  }

  // 3. a secret never reaches the file
  log.noteChanges(ws, [{ reason: 'written', opId: 'op-3', nodeId: 2, preview: '部署密钥是 ghp_abcdefghijklmnopqrstuvwxyz0123456789' }]);
  const raw = readFileSync(log.changesPath(ws), 'utf8');
  check(() => assert.doesNotMatch(raw, /ghp_/), 'the secret is redacted before the file is written');
  const after = log.readChanges(ws);
  check(() => assert.equal(after.entries[0].preview, '<redacted>'), 'the redaction marker is stored');

  // 4. the same operation is recorded once
  const before = log.readChanges(ws).total;
  log.noteChanges(ws, [{ reason: 'written', opId: 'op-1', nodeId: 1, preview: '重复。' }]);
  check(() => assert.equal(log.readChanges(ws).total, before), 'a repeated opId does not create a second entry');

  // 5. bounded: trimming keeps the newest and says how much fell out
  const many = Array.from({ length: log.CHANGE_LOG_LIMIT + 12 }, (_, i) => ({ reason: 'written', opId: `bulk-${i}`, nodeId: 1000 + i, preview: `批量 ${i}` }));
  log.noteChanges(ws, many);
  const trimmed = log.readChanges(ws, { limit: 5 });
  check(() => assert.equal(trimmed.entries.length, 5), 'the read limit is honoured');
  check(() => assert.equal(trimmed.trimmed > 0, true), 'trimming is reported, not hidden');
  check(() => assert.equal(trimmed.total <= log.CHANGE_LOG_LIMIT, true), 'the log stays inside its cap');
  check(() => assert.equal(trimmed.entries[0].opId, `bulk-${many.length - 1}`), 'the newest entry survives trimming');

  // 6. workspaces do not share a log
  const other = join(root, 'ws-other');
  log.noteChanges(other, [{ reason: 'merged', opId: 'op-x', nodeId: 9, preview: '别的库。' }]);
  check(() => assert.equal(log.readChanges(other).total, 1), 'the other workspace has its own log');
  check(() => assert.notEqual(log.readChanges(ws).entries[0].opId, 'op-x'), 'entries do not leak across workspaces');

  // 7. a failing write is reported, never reported as success
  const blocked = join(root, 'blocked-file');
  writeFileSync(blocked, 'not a directory', 'utf8');
  const failed = log.noteChanges(join(blocked, 'ws'), [{ reason: 'written', opId: 'op-fail', nodeId: 1, preview: 'x' }]);
  check(() => assert.equal(failed.ok, false), 'a failed audit write is reported');

  // 8. result mapping covers every outcome the extractor can produce
  const rows = log.rowsForExtract({
    sessionId: 's1',
    result: {
      applied: [{ id: 1, action: 'insert', type: 'decision', text: '新事实。' }, { id: 2, action: 'merge', type: 'preference', text: '合并事实。' }],
      superseded: [{ from: 3, to: 1, label: '方案 A' }, { from: 4, to: null, pending: true, reason: 'ambiguous-supersede' }],
      skipped: [{ reason: 'secret', type: 'decision', preview: '<redacted>' }],
      adjusted: [{ reason: 'unsupported-date', type: 'decision', removed: ['2027-03-01'], preview: '日期被删。' }],
    },
    sourceOf: (id) => (id === 1 ? { role: 'user', messageId: 'm-1', seq: 5, quoteMatch: 'exact' } : null),
  });
  const reasons = rows.map((r) => r.reason);
  check(() => assert.equal(reasons.includes('written'), true), 'an insert maps to written');
  check(() => assert.equal(reasons.includes('merged'), true), 'a merge maps to merged');
  check(() => assert.equal(reasons.includes('superseded'), true), 'a retirement maps to superseded');
  check(() => assert.equal(reasons.includes('pending-review'), true), 'an unconfirmed replacement maps to pending-review');
  check(() => assert.equal(reasons.includes('rejected'), true), 'a refusal maps to rejected');
  check(() => assert.equal(reasons.includes('date-adjusted'), true), 'a date removal maps to date-adjusted');
  check(() => assert.equal(rows[0].source.messageId, 'm-1'), 'the applied row carries the stored source');
  check(() => assert.equal(new Set(rows.map((r) => r.opId)).size, rows.length), 'every row has a distinct opId');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`P53: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
