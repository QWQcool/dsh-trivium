/**
 * p118 — handoff read/write authorization split and replay idempotency (P1-C).
 *
 * A worker assignment used to authorize both directions at once. Now the host
 * grants `canRead` and `canWrite` separately: a writer can submit candidates but
 * cannot read the central inbox back, and a reader cannot submit. Assignments
 * without the flags keep the previous behaviour so existing state files stay
 * valid. A rejected write must not leave a node behind.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'trivium-p118-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const store = await import('../lib/store.js');
const handoff = await import('../lib/handoff.js');

let checks = 0;
let failures = 0;
let workspace = 0;

async function check(label, fn) {
  checks += 1;
  try {
    await fn();
    console.log('ok ' + label);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}: ${error.message || error}`);
  } finally {
    try { store.closeAll(); } catch { /* closed */ }
  }
}

const envelope = (overrides = {}) => ({
  version: 1,
  projectScopeId: 'scope-alpha',
  ticketId: 'ticket-1',
  assignmentId: 'assign-1',
  workerId: 'worker-1',
  eventId: 'event-1',
  sessionId: 'session-1',
  sourceTurns: [{ role: 'user', text: '记住：灰度比例固定为 5%。' }],
  candidates: [{ type: 'decision', name: '灰度比例', text: '灰度比例固定为 5%。', quote: '灰度比例固定为 5%。' }],
  ...overrides,
});

const identity = (overrides = {}) => ({
  projectScopeId: 'scope-alpha', ticketId: 'ticket-1', assignmentId: 'assign-1', workerId: 'worker-1', eventId: 'event-1', ...overrides,
});

async function fresh(assignments) {
  const cwd = join(root, `ws-${++workspace}`);
  await store.openWorkspaceDb(cwd);
  store.closeAll();
  await handoff.configureHandoff(cwd, { projectScopeId: 'scope-alpha', assignments });
  return cwd;
}

const codeOf = (fn) => {
  try { fn(); return ''; } catch (error) { return error.code || error.message; }
};

try {
  await check('a write-only worker can submit and cannot read the inbox', async () => {
    const cwd = await fresh([{ ticketId: 'ticket-1', assignmentId: 'assign-1', workerId: 'worker-1', canRead: false, canWrite: true }]);
    const receipt = await handoff.submitHandoff(cwd, envelope());
    if (receipt.ok !== true) throw new Error(JSON.stringify(receipt));
    const denied = codeOf(() => handoff.handoffReceipt(cwd, identity()));
    if (denied !== 'HANDOFF_READ_NOT_AUTHORIZED') throw new Error(`receipt read returned ${denied}`);
  });

  await check('a read-only worker can read a receipt and cannot submit', async () => {
    const cwd = await fresh([{ ticketId: 'ticket-1', assignmentId: 'assign-1', workerId: 'worker-1', canRead: true, canWrite: false }]);
    const denied = await handoff.submitHandoff(cwd, envelope()).then(() => '', (error) => error.code);
    if (denied !== 'HANDOFF_WRITE_NOT_AUTHORIZED') throw new Error(`submit returned ${denied}`);
    const receipt = handoff.handoffReceipt(cwd, identity());
    if (receipt !== null) throw new Error('a rejected submission left a receipt');
  });

  await check('a rejected write leaves no node and nothing to drain', async () => {
    const cwd = await fresh([{ ticketId: 'ticket-1', assignmentId: 'assign-1', workerId: 'worker-1', canRead: true, canWrite: false }]);
    await handoff.submitHandoff(cwd, envelope()).catch(() => {});
    const db = await store.openWorkspaceDb(cwd);
    const before = db.allNodeIds().length;
    const drained = await handoff.drainHandoff(cwd, db, { limit: 8 });
    if (db.allNodeIds().length !== before) throw new Error('nodes were created by a rejected submission');
    if ((drained?.applied || []).length !== 0) throw new Error(`drained ${JSON.stringify(drained)}`);
  });

  await check('assignments without flags keep the old both-allowed behaviour', async () => {
    const cwd = await fresh([{ ticketId: 'ticket-1', assignmentId: 'assign-1', workerId: 'worker-1' }]);
    await handoff.submitHandoff(cwd, envelope());
    const receipt = handoff.handoffReceipt(cwd, identity());
    if (!receipt || receipt.ok !== true) throw new Error('legacy assignment lost read access');
  });

  await check('an assignment that grants neither direction is rejected at configuration time', async () => {
    const cwd = join(root, `ws-${++workspace}`);
    await store.openWorkspaceDb(cwd);
    store.closeAll();
    const code = await handoff.configureHandoff(cwd, {
      projectScopeId: 'scope-alpha',
      assignments: [{ ticketId: 'ticket-1', assignmentId: 'assign-1', workerId: 'worker-1', canRead: false, canWrite: false }],
    }).then(() => '', (error) => error.code);
    if (code !== 'HANDOFF_INVALID') throw new Error(`configure returned ${code}`);
    const flags = await handoff.configureHandoff(cwd, {
      projectScopeId: 'scope-alpha',
      assignments: [{ ticketId: 'ticket-1', assignmentId: 'assign-1', workerId: 'worker-1', canRead: 'yes' }],
    }).then(() => '', (error) => error.code);
    if (flags !== 'HANDOFF_INVALID') throw new Error(`non-boolean flag returned ${flags}`);
  });

  await check('a replayed envelope is idempotent across a fresh read of the state file', async () => {
    const cwd = await fresh([{ ticketId: 'ticket-1', assignmentId: 'assign-1', workerId: 'worker-1' }]);
    const first = await handoff.submitHandoff(cwd, envelope());
    const second = await handoff.submitHandoff(cwd, envelope());
    if (first.key !== second.key) throw new Error('the event key changed on replay');
    if (second.replayed !== true) throw new Error('a replay was not reported as replayed');
    const receipt = handoff.handoffReceipt(cwd, identity());
    if (receipt.key !== first.key || receipt.status !== 'queued') throw new Error('the stored receipt changed on replay');
  });

  await check('reusing an event id with different content is refused', async () => {
    const cwd = await fresh([{ ticketId: 'ticket-1', assignmentId: 'assign-1', workerId: 'worker-1' }]);
    await handoff.submitHandoff(cwd, envelope());
    const code = await handoff.submitHandoff(cwd, envelope({ candidates: [{ type: 'decision', name: '灰度比例', text: '灰度比例固定为 9%。', quote: '记住：灰度比例固定为 9%。' }] }))
      .then(() => '', (error) => error.code);
    if (code !== 'HANDOFF_EVENT_CONFLICT') throw new Error(`conflicting reuse returned ${code}`);
  });
} finally {
  try { store.closeAll(); } catch { /* closed */ }
  rmSync(root, { recursive: true, force: true });
}

console.log(`P118: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
