/**
 * p89 — the P route: a replacement is a proposal until a person confirms it.
 *
 * Until 0.8.6 the extraction wrote a `supersedes` edge whenever the wording
 * looked like a correction. Four review rounds showed the model's claim is not
 * authorisation, so the automatic path now only records the intent and the edge
 * comes from the panel/API. This pins:
 *
 *   1. the default is propose: the correction is stored, no edge is written, the
 *      old decision stays the head, and both facts stay in the short map;
 *   2. the proposal names its targets and survives a read of the library;
 *   3. confirming one target through the HTTP surface writes the edge and clears
 *      the mark; rejecting leaves both facts live;
 *   4. an ambiguous label keeps every candidate, and confirming one of them does
 *      not touch the other;
 *   5. the legacy automatic path still exists behind `supersedeMode: "auto"`.
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

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const turn = (text) => ({ role: 'user', text, seq: 2, messageId: 'm2', at: '2026-11-02T09:00:00.000Z', recorded: true });
const one = (candidate) => async () => JSON.stringify({ candidates: [candidate] });
const edgesOf = (db) => {
  const out = [];
  for (const id of db.allNodeIds()) {
    for (const edge of (db.get(id)?.edges || [])) if (String(edge.label) === 'supersedes') out.push(`${id}->${edge.targetId}`);
  }
  return out;
};
const seed = (db) => store.insertNode(db, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });

const ws = join(root, 'ws');
const db = await store.openWorkspaceDb(ws);
const oldId = seed(db);
const sentence = '不再使用方案 A，改用方案 B。';

try {
  // 1. propose by default
  const out = await extract.distill({
    db,
    turns: [turn(sentence)],
    sessionId: 'p89',
    llmCall: one({ type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: sentence }),
  });
  const newId = db.allNodeIds().map(Number).filter((id) => id !== oldId).at(-1);
  await check(() => assert.deepEqual(edgesOf(db), []), 'the default route writes no supersedes edge');
  await check(() => assert.equal(store.currentHeadOf(db, oldId).id, oldId), 'the old decision is still the head');
  await check(() => assert.equal(db.get(newId).payload.review, 'supersede-proposed'), 'the correction is marked as a proposal');
  await check(
    () => assert.deepEqual(db.get(newId).payload.proposedSupersedes, [oldId]),
    'the proposal keeps the target ids',
  );
  await check(() => assert.equal(out.superseded.some((row) => row.proposed?.includes(oldId)), true), 'the intent is reported, not silent');

  // 2. both sides stay visible to the model
  const map = store.buildShortMapReport(db, 400).text;
  await check(() => assert.match(map, /方案 A/), 'the decision being replaced stays in the short map');
  await check(() => assert.match(map, /方案 B/), 'the proposed correction is in the short map too');

  const proposals = review.listSupersedeProposals(db);
  await check(() => assert.equal(proposals.length, 1), 'one proposal is waiting');
  await check(() => assert.deepEqual(proposals[0].targets.map((t) => t.id), [oldId]), 'the proposal names the target');
  await check(() => assert.equal(proposals[0].targets[0].live, true), 'the target is reported as still live');

  // 3a. reject leaves both facts current
  const rejected = review.rejectSupersede(db, newId, { by: 'p89' });
  await check(() => assert.equal(rejected.ok, true), 'a proposal can be rejected');
  await check(() => assert.deepEqual(edgesOf(db), []), 'rejecting writes no edge');
  await check(() => assert.equal(db.get(newId).payload.review, undefined), 'rejecting clears the mark');
  await check(() => assert.equal(store.currentHeadOf(db, oldId).id, oldId), 'both decisions are still current after a reject');
  await check(() => assert.equal(review.listSupersedeProposals(db).length, 0), 'a rejected proposal leaves the queue');

  // 3b. confirm through the HTTP surface
  const again = await extract.distill({
    db,
    turns: [turn('别用方案 A，改用方案 B 了。')],
    sessionId: 'p89b',
    llmCall: one({ type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: '别用方案 A，改用方案 B 了。' }),
  });
  const proposalId = review.listSupersedeProposals(db)[0]?.id;
  await check(() => assert.ok(proposalId), `the second attempt proposes as well (${JSON.stringify(again.superseded)})`);

  const { registerMemoryApi } = await import('../lib/server.js');
  const { createServer } = await import('node:http');
  let handler = null;
  registerMemoryApi({ webServer: { register(x) { handler = x.handler; return () => {}; } } }, { liveOptions: () => ({}), status: {} });
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const cwd = encodeURIComponent(ws);
  try {
    await check(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dsh-trivium/supersede-proposals?cwd=${cwd}`);
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.proposals.length, 1);
      assert.equal(body.proposals[0].id, proposalId);
    }, 'GET /supersede-proposals lists the waiting proposal');

    await check(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dsh-trivium/nodes/${oldId}/supersede?cwd=${cwd}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ successorId: proposalId }),
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.ok, true);
    }, 'the existing supersede endpoint is the confirmation path');

    await check(() => assert.deepEqual(edgesOf(db), [`${proposalId}->${oldId}`]), 'confirming writes exactly one edge');
    await check(() => assert.equal(store.currentHeadOf(db, oldId).id, proposalId), 'the confirmed correction becomes the head');
    await check(() => assert.equal(db.get(proposalId).payload.review, undefined), 'confirming clears the proposal mark');
    await check(() => assert.equal(review.listSupersedeProposals(db).length, 0), 'a confirmed proposal leaves the queue');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // 4. ambiguous labels keep every candidate
  const ws2 = join(root, 'ws2');
  const db2 = await store.openWorkspaceDb(ws2);
  const a1 = store.insertNode(db2, { type: 'decision', name: '方案 A', text: '本次上线按方案 A 执行' });
  const a2 = store.insertNode(db2, { type: 'decision', name: '方案 A', text: '回滚预案也按方案 A 执行' });
  await extract.distill({
    db: db2,
    turns: [turn('不再使用方案 A，改用方案 B。')],
    sessionId: 'p89c',
    llmCall: one({ type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: '不再使用方案 A，改用方案 B。' }),
  });
  const ambiguous = review.listSupersedeProposals(db2);
  await check(() => assert.equal(ambiguous.length, 1), 'an ambiguous replacement is still one proposal');
  await check(
    () => assert.deepEqual(ambiguous[0].targets.map((t) => t.id).sort(), [a1, a2].sort()),
    'the ambiguous proposal keeps both candidates',
  );
  await check(() => assert.deepEqual(edgesOf(db2), []), 'an ambiguous proposal writes no edge');
  const picked = review.confirmSupersede(db2, ambiguous[0].id, a1, { by: 'p89' });
  await check(() => assert.equal(picked.ok, true), 'one of the candidates can be chosen');
  await check(() => assert.deepEqual(edgesOf(db2), [`${ambiguous[0].id}->${a1}`]), 'only the chosen candidate is retired');
  await check(() => assert.equal(store.currentHeadOf(db2, a2).id, a2), 'the other candidate stays current');
  await check(
    () => assert.equal(review.confirmSupersede(db2, ambiguous[0].id, a2, { by: 'p89' }).ok, false),
    'a second confirmation on the same node is refused',
  );

  // 5. the legacy automatic path is still reachable, explicitly
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ supersedeMode: 'auto' }), 'utf8');
  const ws3 = join(root, 'ws3');
  const db3 = await store.openWorkspaceDb(ws3);
  const legacyOld = seed(db3);
  await extract.distill({
    db: db3,
    turns: [turn(sentence)],
    sessionId: 'p89-auto',
    llmCall: one({ type: 'decision', name: '上线方案 B', text: '改用方案 B', quote: sentence }),
  });
  await check(() => assert.equal(edgesOf(db3).length, 1), 'supersedeMode "auto" restores the immediate edge');
  await check(() => assert.equal(store.currentHeadOf(db3, legacyOld).id !== legacyOld, true), 'the automatic path still retires');
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P89: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
