/**
 * p89 — the P route: a replacement is a proposal until a person confirms it.
 *
 * Until 0.8.6 the extraction wrote a `supersedes` edge whenever the wording
 * looked like a correction. Four review rounds showed the model's claim is not
 * authorisation, so the automatic path now only records the intent and the edge
 * comes from the panel/API. This pins:
 *
 *   1. the default is propose: the correction is stored, no edge is written, the
 *      old decision stays the head, and both facts stay eligible for the map;
 *   2. the list is what the panel reads, including the ETag it must echo;
 *   3. **F87-01**: a reject is final for that pair — neither the confirm endpoint
 *      nor the generic revision endpoint may write the refused edge, and a stale
 *      ETag is refused as well;
 *   4. **F87-02**: the confirm/reject routes take the workspace lock, so a held
 *      lock answers 409 instead of writing;
 *   5. confirming one candidate of an ambiguous proposal retires only that one,
 *      the edge goes through the same validator as a manual revision (no cycle),
 *      and a second confirm is refused;
 *   6. the legacy automatic path still exists behind `supersedeMode: "auto"`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p89-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const store = await import('../lib/store.js');
const extract = await import('../lib/extract.js');
const review = await import('../lib/supersede-review.js');
const lock = await import('../lib/workspace-lock.js');
const changes = await import('../lib/change-log.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const turn = (text, messageId = 'm2') => ({ role: 'user', text, seq: 2, messageId, at: '2026-11-02T09:00:00.000Z', recorded: true });
const one = (candidate) => async () => JSON.stringify({ candidates: [candidate] });
const edgesOf = (db) => {
  const out = [];
  for (const id of db.allNodeIds()) {
    for (const edge of (db.get(id)?.edges || [])) if (String(edge.label) === 'supersedes') out.push(`${id}->${edge.targetId}`);
  }
  return out;
};
const seed = (db) => store.insertNode(db, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });
const propose = (db, ws, name, sentence, quote, messageId = 'm2') => extract.distill({
  db,
  turns: [turn(sentence, messageId)],
  sessionId: name,
  llmCall: one({ type: 'decision', name: '上线方案 B', text: '改用方案 B', quote }),
});

const ws = join(root, 'ws');
const db = await store.openWorkspaceDb(ws);
const oldId = seed(db);

try {
  // 1. propose by default
  await propose(db, ws, 'p89', '不再使用方案 A，改用方案 B。', '不再使用方案 A，改用方案 B。');
  const newId = db.allNodeIds().map(Number).filter((id) => id !== oldId).at(-1);
  await check(() => assert.deepEqual(edgesOf(db), []), 'the default route writes no supersedes edge');
  await check(() => assert.equal(store.currentHeadOf(db, oldId).id, oldId), 'the old decision is still the head');
  await check(() => assert.equal(db.get(newId).payload.review, 'supersede-proposed'), 'the correction is marked as a proposal');
  await check(() => assert.deepEqual(db.get(newId).payload.proposedSupersedes, [oldId]), 'the proposal keeps the target ids');

  const map = store.buildShortMapReport(db, 400).text;
  await check(() => assert.match(map, /方案 A/), 'the decision being replaced stays eligible for the map');
  await check(() => assert.match(map, /方案 B/), 'the proposed correction is eligible too');

  const listed = review.listSupersedeProposals(db);
  await check(() => assert.equal(listed.length, 1), 'one proposal is waiting');
  await check(() => assert.deepEqual(listed[0].targets.map((t) => t.id), [oldId]), 'the proposal names the target');
  await check(() => assert.equal(listed[0].targets[0].live, true), 'the target is reported as still live');
  await check(() => assert.ok(listed[0].etag), 'the list carries the ETag the panel must echo');

  // 2. reject is final for that pair (F87-01)
  const rejected = review.rejectSupersede(db, newId, { source: 'p89' });
  await check(() => assert.equal(rejected.ok, true), 'a proposal can be rejected');
  await check(() => assert.deepEqual(edgesOf(db), []), 'rejecting writes no edge');
  await check(() => assert.deepEqual(db.get(newId).payload.rejectedSupersedes, [oldId]), 'rejecting leaves a tombstone for that pair');
  await check(() => assert.equal(review.listSupersedeProposals(db).length, 0), 'a rejected proposal leaves the queue');
  await check(
    () => assert.equal(review.confirmProposal(db, { proposalId: newId, targetId: oldId }).code, 'proposal-rejected'),
    'a rejected pair cannot be confirmed afterwards',
  );
  await check(
    () => assert.equal(review.supersedeBlockedByProposal(db, { oldId, successorId: newId }).code, 'proposal-rejected'),
    'the generic revision endpoint is blocked for the refused pair',
  );

  /*
   * 2b. F87-01: replaying the *same* event must not undo the refusal. The host
   * retries a window; there is no new user intent behind it.
   */
  const replay = await propose(db, ws, 'p89', '不再使用方案 A，改用方案 B。', '不再使用方案 A，改用方案 B。', 'm2');
  await check(
    () => assert.equal(replay.superseded.some((row) => row.skipped === 'proposal-rejected-replay'), true),
    'a replay of the same event is reported as a rejected replay',
  );
  await check(() => assert.equal(review.listSupersedeProposals(db).length, 0), 'the replay does not put the proposal back');
  await check(() => assert.deepEqual(db.get(newId).payload.rejectedSupersedes, [oldId]), 'the replay keeps the tombstone');

  // 3. HTTP: pending proposal, stale ETag, confirm, second confirm
  const second = await propose(db, ws, 'p89b', '别用方案 A，改用方案 B 了。', '别用方案 A，改用方案 B 了。', 'm3');
  const pending = review.listSupersedeProposals(db)[0];
  await check(() => assert.ok(pending), `the second attempt proposes as well (${JSON.stringify(second.superseded)})`);

  const { registerMemoryApi } = await import('../lib/server.js');
  const { createServer } = await import('node:http');
  let handler = null;
  registerMemoryApi({ webServer: { register(x) { handler = x.handler; return () => {}; } } }, { liveOptions: () => ({}), status: {} });
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const cwd = encodeURIComponent(ws);
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  try {
    await check(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dsh-trivium/supersede-proposals?cwd=${cwd}`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.proposals.length, 1);
      assert.equal(body.proposals[0].etag, pending.etag);
    }, 'GET /supersede-proposals lists the waiting proposal with its ETag');

    // Move the node (rename) so the ETag the panel saw is stale.
    store.updateNode(db, pending.id, { name: '上线方案 B（改）' });
    await check(async () => {
      const res = await post(`/api/dsh-trivium/supersede-proposals/${pending.id}/confirm?cwd=${cwd}`, {
        targetId: oldId,
        etag: pending.etag,
      });
      const body = await res.json();
      assert.equal(res.status, 409);
      assert.equal(body.code, 'proposal-stale');
    }, 'a stale proposal ETag is refused (F87-01)');

    /*
     * The same check has to cover the *candidate*: editing the decision that
     * would be retired changes what "confirm this replacement" means, and the
     * proposal node itself did not move.
     */
    const beforeTargetEdit = review.listSupersedeProposals(db)[0].etag;
    store.updateNode(db, oldId, { text: '本次上线按方案 A 执行（补充：周五 22:00 全量）。' });
    await check(async () => {
      const res = await post(`/api/dsh-trivium/supersede-proposals/${pending.id}/confirm?cwd=${cwd}`, {
        targetId: oldId,
        etag: beforeTargetEdit,
      });
      const body = await res.json();
      assert.equal(res.status, 409);
      assert.equal(body.code, 'proposal-stale');
    }, 'a candidate that changed after the page loaded also invalidates the ETag');

    await check(async () => {
      const res = await post(`/api/dsh-trivium/supersede-proposals/${pending.id}/confirm?cwd=${cwd}`, {
        targetId: oldId,
        etag: review.listSupersedeProposals(db)[0].etag,
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
      assert.equal(body.targetId, oldId);
    }, 'confirming through the proposal endpoint writes the edge');

    await check(() => assert.deepEqual(edgesOf(db), [`${pending.id}->${oldId}`]), 'exactly one edge exists');
    await check(() => assert.equal(store.currentHeadOf(db, oldId).id, pending.id), 'the confirmed correction becomes the head');
    await check(() => assert.equal(db.get(pending.id).payload.review, undefined), 'confirming clears the proposal mark');
    await check(() => assert.equal(db.get(pending.id).payload.supersedeConfirmedVia, 'http'), 'the surface is recorded, not a claimed identity');
    await check(() => assert.equal(review.listSupersedeProposals(db).length, 0), 'a confirmed proposal leaves the queue');
    await check(() => {
      /*
       * The edge carries an operationId and a timestamp, but neither says which
       * surface confirmed it. The change log is where a reader looks, so the
       * confirmation has to leave a row of its own (P2 follow-up).
       */
      // `cwd` in this file is the URL-encoded query value; the log lives on disk.
      const log = changes.readChanges(ws);
      const row = log.entries.find((entry) => entry.reason === 'supersede-confirmed' && entry.nodeId === pending.id);
      assert.ok(row, `no supersede-confirmed row in ${JSON.stringify(log.entries.slice(-3))}`);
      assert.equal(row.byId, oldId, 'the row names the retired fact');
      assert.match(row.detail, /via/, 'the row says which surface confirmed it');
    }, 'a confirmation leaves its own change-log row');

    await check(async () => {
      const res = await post(`/api/dsh-trivium/supersede-proposals/${pending.id}/confirm?cwd=${cwd}`, { targetId: oldId, etag: pending.etag });
      const body = await res.json();
      assert.equal(res.status, 409);
      assert.equal(body.code, 'proposal-not-pending');
    }, 'a second confirmation is refused');

    await check(async () => {
      const res = await post(`/api/dsh-trivium/supersede-proposals/${pending.id}/confirm?cwd=${cwd}`, { targetId: oldId });
      const body = await res.json();
      assert.equal(res.status, 409);
      assert.equal(body.code, 'proposal-missing-etag');
    }, 'a confirmation without the ETag is refused instead of racing a stale page');

    /*
     * 3b. Reject is not exempt either: a page that loaded before a candidate was
     * added must not be able to decline a proposal it never showed.
     */
    const wsRej = join(root, 'ws-rej');
    const dbRej = await store.openWorkspaceDb(wsRej);
    store.insertNode(dbRej, { type: 'decision', name: '方案 A', text: '主库用 MySQL。' });
    await propose(dbRej, wsRej, 'p89rej', '不再使用方案 A，改用方案 B。', '不再使用方案 A，改用方案 B。', 'm-rej');
    const rejProposal = review.listSupersedeProposals(dbRej)[0];
    const rejCwd = encodeURIComponent(wsRej);
    await check(async () => {
      const res = await post(`/api/dsh-trivium/supersede-proposals/${rejProposal.id}/reject?cwd=${rejCwd}`, {});
      const body = await res.json();
      assert.equal(res.status, 409);
      assert.equal(body.code, 'proposal-missing-etag');
    }, 'a rejection without the ETag is refused');
    store.updateNode(dbRej, rejProposal.id, { name: '数据库选型（改）' });
    await check(async () => {
      const res = await post(`/api/dsh-trivium/supersede-proposals/${rejProposal.id}/reject?cwd=${rejCwd}`, { etag: rejProposal.etag });
      const body = await res.json();
      assert.equal(res.status, 409);
      assert.equal(body.code, 'proposal-stale');
    }, 'a stale rejection is refused');
    await check(async () => {
      const res = await post(`/api/dsh-trivium/supersede-proposals/${rejProposal.id}/reject?cwd=${rejCwd}`, {
        etag: review.listSupersedeProposals(dbRej)[0].etag,
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(review.listSupersedeProposals(dbRej).length, 0);
    }, 'a rejection with the current ETag is accepted');

    // 4. the write routes take the workspace lock (F87-02)
    const held = lock.acquireWorkspaceLock(ws);
    try {
      await check(async () => {
        const res = await post(`/api/dsh-trivium/supersede-proposals/${newId}/reject?cwd=${cwd}`, {});
        const body = await res.json();
        assert.equal(res.status, 409);
        assert.equal(body.code, 'WORKSPACE_WRITE_BUSY');
      }, 'reject is refused while another process holds the workspace lock');

      /*
       * The same lock has to cover the older interactive edits: they mutate the
       * same store, and the panel used to report success while another process
       * held the writer.
       */
      await check(async () => {
        const res = await post(`/api/dsh-trivium/nodes/${oldId}?cwd=${cwd}`, { name: '方案 A（改名）' });
        const body = await res.json();
        assert.equal(res.status, 409, JSON.stringify(body));
        assert.equal(body.code, 'WORKSPACE_WRITE_BUSY');
      }, 'editing a fact is refused while the workspace lock is held');

      await check(async () => {
        const res = await post(`/api/dsh-trivium/nodes/${oldId}/merge?cwd=${cwd}`, { dropId: newId });
        const body = await res.json();
        assert.equal(res.status, 409, JSON.stringify(body));
        assert.equal(body.code, 'WORKSPACE_WRITE_BUSY');
      }, 'merging two facts is refused while the workspace lock is held');
    } finally {
      held.release?.();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 5. ambiguous proposals: one candidate, same validator, no cycle
  const ws2 = join(root, 'ws2');
  const db2 = await store.openWorkspaceDb(ws2);
  const a1 = store.insertNode(db2, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });
  const a2 = store.insertNode(db2, { type: 'decision', name: '方案 A', text: '回滚预案也按方案 A 执行' });
  await propose(db2, ws2, 'p89c', '不再使用方案 A，改用方案 B。', '不再使用方案 A，改用方案 B。');
  const ambiguous = review.listSupersedeProposals(db2);
  await check(() => assert.equal(ambiguous.length, 1), 'an ambiguous replacement is still one proposal');
  await check(
    () => assert.deepEqual(ambiguous[0].targets.map((t) => t.id).sort(), [a1, a2].sort()),
    'the ambiguous proposal keeps both candidates',
  );
  await check(
    () => assert.equal(review.confirmProposal(db2, { proposalId: ambiguous[0].id, targetId: 99999 }).code, 'proposal-target-not-listed'),
    'a target that is not a candidate is refused',
  );
  const picked = review.confirmProposal(db2, { proposalId: ambiguous[0].id, targetId: a1, source: 'p89' });
  await check(() => assert.equal(picked.ok, true), 'one of the candidates can be chosen');
  await check(() => assert.deepEqual(edgesOf(db2), [`${ambiguous[0].id}->${a1}`]), 'only the chosen candidate is retired');
  await check(() => assert.equal(store.currentHeadOf(db2, a2).id, a2), 'the other candidate stays current');
  await check(
    () => assert.equal(review.confirmProposal(db2, { proposalId: ambiguous[0].id, targetId: a2 }).code, 'proposal-not-pending'),
    'a second confirmation on the same node is refused',
  );

  /*
   * The helper must not be able to build a cycle: it delegates to
   * `revisions.supersede`. A → B → C is a chain, and a proposal on A that targets
   * C would close the loop; the validator has to say so, not merely "not pending".
   */
  const ws3 = join(root, 'ws3');
  const db3 = await store.openWorkspaceDb(ws3);
  const a3 = store.insertNode(db3, { type: 'decision', name: 'A', text: '按 A 执行' });
  const b3 = store.insertNode(db3, { type: 'decision', name: 'B', text: '按 B 执行' });
  const c3 = store.insertNode(db3, { type: 'decision', name: 'C', text: '按 C 执行' });
  store.ensureLink(db3, b3, a3, 'supersedes');
  store.ensureLink(db3, c3, b3, 'supersedes');
  store.updateNode(db3, a3, {
    review: 'supersede-proposed',
    proposedSupersedes: [c3],
    supersedeProposedFor: 'message:m-cycle',
  });
  await check(() => {
    const cyclic = review.confirmProposal(db3, { proposalId: a3, targetId: c3 });
    assert.equal(cyclic.ok, false, `a cycle must be refused, got ${JSON.stringify(cyclic)}`);
    assert.equal(cyclic.code, 'cycle', `expected the validator's cycle code, got ${JSON.stringify(cyclic)}`);
  }, 'confirm delegates to the revision validator, so no cycle can be created');
  await check(() => assert.deepEqual(edgesOf(db3).length, 2), 'the refused cycle wrote nothing');

  /*
   * F87-03: when the mark cannot be written, the extraction must not claim a
   * proposal. The fact is written, the replacement is reported as failed, and
   * nothing is left in the list that the panel could not see.
   */
  const ws5 = join(root, 'ws5');
  const db5 = await store.openWorkspaceDb(ws5);
  store.insertNode(db5, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });
  const failingWriter = {
    insert: (node) => store.insertNode(db5, node),
    merge: (id, node) => store.mergeInto(db5, id, node),
    link: (from, to, label) => store.ensureLink(db5, from, to, label),
    update: () => { throw new Error('sink down'); },
  };
  const failed = await extract.distill({
    db: db5,
    writer: failingWriter,
    turns: [turn('不再使用方案 A，改用方案 B。')],
    sessionId: 'p89-fail',
    llmCall: one({ type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: '不再使用方案 A，改用方案 B。' }),
  });
  await check(
    () => assert.equal(failed.superseded.some((row) => row.skipped === 'proposal-failed'), true),
    'a proposal that cannot be marked is reported as failed, not as proposed',
  );
  await check(
    () => assert.equal(failed.superseded.some((row) => Array.isArray(row.proposed) && row.proposed.length), false),
    'the failed attempt is not reported as proposed',
  );
  await check(() => assert.equal(review.listSupersedeProposals(db5).length, 0), 'the panel list stays truthful after the failure');

  /*
   * The window is kept (see `extractOutcome`), so the replay has to finish the
   * job: one proposal, and the fact already written is merged rather than
   * duplicated.
   */
  await check(() => {
    const failedOutcome = extract.extractOutcome({ llmFailed: false, superseded: [{ skipped: 'proposal-failed' }] });
    assert.equal(failedOutcome.consume, false, 'a failed proposal must not consume the window');
    assert.equal(failedOutcome.recovered, false, 'and it must not be reported as a recovery');
    const healthy = extract.extractOutcome({ llmFailed: false, superseded: [{ proposed: [2] }] });
    assert.equal(healthy.consume, true);
  }, 'extractOutcome keeps the window when a proposal could not be stored');

  const healed = await extract.distill({
    db: db5,
    turns: [turn('不再使用方案 A，改用方案 B。')],
    sessionId: 'p89-fail',
    llmCall: one({ type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: '不再使用方案 A，改用方案 B。' }),
  });
  await check(
    () => assert.equal(healed.superseded.some((row) => Array.isArray(row.proposed) && row.proposed.length), true),
    'the replay after the fault stores the proposal',
  );
  await check(() => assert.equal(review.listSupersedeProposals(db5).length, 1), 'the proposal is visible after the replay');
  await check(() => assert.equal(db5.allNodeIds().length, 3), 'the fact was merged, not duplicated');

  /*
   * F87-01/03: exercise the consumer, not just distill/extractOutcome. A new
   * agent starts recovery of the SAME historical window after a storage fault;
   * neither its historical session nor its event locator is changed for retry.
   * The stream is a local stub, so no host or model service is started.
   */
  const plugin = await import('../lib/index.js');
  const sentence = '不再使用方案 A，改用方案 B。';
  const answer = JSON.stringify({ candidates: [{ type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: sentence }] });
  for (const [kind, locator] of [
    ['message', { messageId: 'm-entry', seq: 2, recorded: true }],
    ['sequence', { seq: 2, recorded: true }],
    ['unlocated', { recorded: false }],
  ]) {
    const entryWs = join(root, `entry-${kind}`);
    const entryDb = await store.openWorkspaceDb(entryWs);
    const entryOld = seed(entryDb);
    const window = { sessionId: `historical-${kind}`, turns: [{ role: 'user', text: sentence, ...locator }] };
    await extract.savePending(entryWs, window);
    const originalWindow = extract.loadPendingWindows(entryWs)[0];
    let calls = 0;
    const handlers = new Map();
    const ctx = {
      llm: { async *stream() { calls += 1; yield { type: 'text-delta', index: 0, text: answer }; } },
      logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      inject(_deps, fn) { fn(ctx); },
      on(name, fn) { handlers.set(name, fn); return () => {}; },
      effect(fn) { fn(); return () => {}; },
      tools: { register() { return () => {}; } },
      webServer: { register() { return () => {}; } },
    };
    plugin.apply(ctx, {});
    const start = (attempt) => handlers.get('agent/created')({ agent: {
      session: { id: `recover-${kind}-${attempt}`, header: { cwd: entryWs }, requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }) },
      inject() {},
    } });
    const update = entryDb.updatePayload;
    let failedIds;
    entryDb.updatePayload = function (id, payload) {
      if (payload.review === 'supersede-proposed') throw new Error('synthetic proposal storage failure');
      return update.call(this, id, payload);
    };
    try {
      await start('failure');
      failedIds = store.findByType(entryDb, 'decision').map((row) => row.id).sort();
      await check(() => {
        assert.equal(calls, 1);
        assert.equal(failedIds.length, 2, 'the fact was written before the proposal failed');
        assert.equal(review.listSupersedeProposals(entryDb).length, 0);
        // Failure bookkeeping may add `error`; the event and window must stay exact.
        assert.deepEqual(extract.loadPendingWindows(entryWs).map(({ error, ...saved }) => saved), [originalWindow]);
      }, `${kind}: a real-entry proposal failure retains the identical historical window`);
      await check(() => {
        const status = plugin.workspaceStatus(entryWs);
        assert.equal(status.lastExtract.skippedBy, 'proposal-failed');
        assert.equal(status.lastExtract.proposalPending, true);
        assert.equal(status.recovery.state, 'failed');
      }, `${kind}: the consumer reports failure instead of recovery`);
    } finally {
      entryDb.updatePayload = update;
    }
    await start('healed');
    const entryProposal = review.listSupersedeProposals(entryDb)[0];
    await check(() => {
      assert.equal(calls, 2, 'the retained window was actually replayed');
      assert.deepEqual(extract.loadPendingWindows(entryWs), []);
      assert.equal(review.listSupersedeProposals(entryDb).length, 1);
      assert.deepEqual(store.findByType(entryDb, 'decision').map((row) => row.id).sort(), failedIds);
      assert.deepEqual(entryProposal.targets.map((row) => row.id), [entryOld]);
      assert.equal(entryDb.get(entryProposal.id).payload.source.sessionId, originalWindow.sessionId);
      assert.equal(entryDb.get(entryProposal.id).payload.supersedeProposedFor || '', extract.eventKeyOf({ ...locator, sessionId: originalWindow.sessionId }));
      assert.deepEqual(edgesOf(entryDb), []);
    }, `${kind}: the same window is consumed only after one proposal is stored without duplicating the fact`);
    await check(() => {
      const status = plugin.workspaceStatus(entryWs);
      assert.equal(status.lastExtract.skippedBy, undefined);
      assert.notEqual(status.lastExtract.proposalPending, true);
      assert.equal(status.recovery.state, 'succeeded');
    }, `${kind}: recovery succeeds only after the storage fault is removed`);

    if (kind === 'unlocated') {
      await check(() => {
        assert.equal(entryDb.get(entryProposal.id).payload.supersedeProposedFor, undefined);
        assert.equal(review.rejectSupersede(entryDb, entryProposal.id, { expectedEtag: entryProposal.etag }).ok, true);
      }, 'the first proposal really has neither messageId nor seq and can be rejected');
      await extract.savePending(entryWs, originalWindow);
      await check(() => assert.deepEqual(extract.loadPendingWindows(entryWs), [originalWindow]), 'the unlocated rejection replay uses the same saved window');
      await start('rejected-replay');
      await check(() => {
        assert.equal(calls, 3);
        assert.deepEqual(extract.loadPendingWindows(entryWs), []);
        assert.equal(review.listSupersedeProposals(entryDb).length, 0);
        assert.deepEqual(entryDb.get(entryProposal.id).payload.rejectedSupersedes, [entryOld]);
        assert.deepEqual(store.findByType(entryDb, 'decision').map((row) => row.id).sort(), failedIds);
        assert.deepEqual(edgesOf(entryDb), []);
        assert.equal(review.supersedeBlockedByProposal(entryDb, { oldId: entryOld, successorId: entryProposal.id }).code, 'proposal-rejected');
        assert.equal(plugin.workspaceStatus(entryWs).lastExtract.supersedeSkipped.some((row) => row.skipped === 'proposal-rejected-replay'), true);
      }, 'an initially unlocated event cannot reopen a refusal through the real replay entry');
      const newlyIdentified = await extract.distill({
        db: entryDb, turns: [turn(sentence, 'm-later')], sessionId: originalWindow.sessionId,
        llmCall: async () => answer,
      });
      await check(() => {
        assert.equal(newlyIdentified.superseded.some((row) => row.skipped === 'proposal-rejected-replay'), true);
        assert.equal(review.listSupersedeProposals(entryDb).length, 0);
        assert.deepEqual(entryDb.get(entryProposal.id).payload.rejectedSupersedes, [entryOld]);
      }, 'a locator arriving later cannot prove a new generation against an unlocated refusal');
    }
  }

  // 6. the legacy automatic path is still reachable, explicitly
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ supersedeMode: 'auto' }), 'utf8');
  const ws4 = join(root, 'ws4');
  const db4 = await store.openWorkspaceDb(ws4);
  const legacyOld = seed(db4);
  await propose(db4, ws4, 'p89-auto', '不再使用方案 A，改用方案 B。', '不再使用方案 A，改用方案 B。');
  await check(() => assert.equal(edgesOf(db4).length, 1), 'supersedeMode "auto" restores the immediate edge');
  await check(() => assert.equal(store.currentHeadOf(db4, legacyOld).id !== legacyOld, true), 'the automatic path still retires');
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P89: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
