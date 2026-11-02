/**
 * p73 — B2 map heat (S0-1).
 *
 * Covers, in order:
 *   1. 50 facts, only 3 referenced -> the short map names those 3, within 400
 *      tokens, and the same fixture's token count does not rise;
 *   2. the legacy (type-quota only) selection would NOT have named them, so the
 *      assertion is not vacuous;
 *   3. ctx_read's hit point (listIncomingBusiness without opts) counts, and the
 *      panel's (listNodes -> track:false) does not;
 *   4. automatic recall / preview (formatHit with track:false) does not count;
 *   5. a reference to a superseded node is credited to its current head;
 *   6. the sidecar write is throttled to one per 60 s per workspace, and the
 *      heat never reaches the graph payloads (schema untouched).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p73-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const usage = await import('../lib/usage.js');
const { DIM } = await import('../lib/schema.js');
const { estimateTokens } = await import('../lib/tokens.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const cwd = join(root, 'ws');
const db = await store.openWorkspaceDb(cwd);

/** The eight `named:` entries of a map text, in order. */
function namedOf(text) {
  const line = String(text).split('\n').find((row) => row.startsWith('named: ')) || '';
  return line ? line.slice('named: '.length).split('; ') : [];
}

try {
  // Names are padded so every `type:name` is 14 characters: the fixture then
  // differs only in *which* fact is shown, never in how long the line is, and a
  // token change can only come from the map's structure.
  const ids = { prefs: [], entities: [], experiences: [] };
  for (let i = 0; i < 20; i += 1) ids.prefs.push(store.insertNode(db, { type: 'preference', name: `p${String(i).padStart(2, '0')}`, text: `p${String(i).padStart(2, '0')}` }));
  for (let i = 0; i < 20; i += 1) ids.entities.push(store.insertNode(db, { type: 'entity', name: `ent-${String(i).padStart(3, '0')}`, text: `ent-${String(i).padStart(3, '0')}` }));
  for (let i = 0; i < 10; i += 1) ids.experiences.push(store.insertNode(db, { type: 'experience', name: `x${String(i).padStart(2, '0')}`, text: `x${String(i).padStart(2, '0')}` }));

  // Oldest three: recency ordering alone pushes them out, so only heat can
  // bring them back.
  const hotEntityA = ids.entities[0];
  const hotEntityB = ids.entities[1];
  const hotExperience = ids.experiences[0];

  const before = store.buildShortMapReport(db, 400);
  // A/B on the same code path: only the heat differs between `before` and `after`.
  await check(() => assert.ok(!namedOf(before.text).includes('entity:ent-000')), 'fixture: ent-000 is outside the map before any reference');
  await check(() => assert.ok(!namedOf(before.text).includes('experience:x00')), 'fixture: x00 is outside the map before any reference');

  // 1) ctx_find: searchNodes -> formatHit, exactly the tools path.
  const hits = store.searchNodes(db, 'ent-000', { topK: 8 });
  assert.ok(hits.length, 'fixture: the entity is searchable');
  store.formatHit(db, hits[0], { includeWorkspace: false });
  // 2) ctx_read: tools.js passes no opts to listIncomingBusiness.
  store.listIncomingBusiness(db, hotEntityB);
  // 3) ctx_read on an experience.
  store.listIncomingBusiness(db, hotExperience);
  await check(() => assert.equal(usage.flushUsage(cwd), true), 'the throttled sidecar flushes on demand');

  const after = store.buildShortMapReport(db, 400);
  const named = namedOf(after.text);
  await check(() => assert.ok(named.includes('entity:ent-000')), `rebuilt map names the found entity (got ${named.join(' | ')})`);
  await check(() => assert.ok(named.includes('entity:ent-001')), 'rebuilt map names the read entity');
  await check(() => assert.ok(named.includes('experience:x00')), 'rebuilt map names the read experience');
  await check(() => assert.ok(after.tokens <= 400), `map stays within 400 estimated tokens (${after.tokens})`);
  await check(() => assert.ok(after.tokens <= before.tokens), `injection tokens do not rise (${before.tokens} -> ${after.tokens})`);
  await check(() => assert.equal(named.length, 8), 'the map still names at most eight facts');
  await check(() => assert.equal(estimateTokens(after.text), after.tokens), 'reported tokens match the text');
  await check(() => assert.ok(after.version && after.version.startsWith('mapv-')), 'the map carries a version fingerprint');
  await check(() => assert.ok(after.hidden >= 42), `the report knows how many facts stay unexpanded (${after.hidden})`);

  // Panel browsing and automatic recall must not move the heat.
  const snapshot = usage.usageFor(cwd);
  store.listNodes(db);
  store.formatHit(db, { id: ids.entities[0], score: 1 }, { track: false });
  usage.flushUsage(cwd);
  await check(
    () => assert.deepEqual(usage.usageFor(cwd), snapshot),
    'listNodes and track:false renders leave the counters untouched',
  );

  // A reference to a retired node is credited to its head.
  const oldDecision = store.insertNode(db, { type: 'decision', name: 'plan-old', text: 'plan-old' });
  const newDecision = store.insertNode(db, { type: 'decision', name: 'plan-new', text: 'plan-new' });
  const { supersede } = await import('../lib/revisions.js');
  const superseded = supersede(db, { oldId: oldDecision, successorId: newDecision });
  assert.equal(superseded.ok, true, 'fixture: the replacement edge is created');
  store.formatHit(db, { id: oldDecision, score: 1 }, { includeWorkspace: false });
  usage.flushUsage(cwd);
  const heat = usage.usageFor(cwd);
  await check(() => assert.equal(heat[String(newDecision)]?.count, 1), 'a hit on a retired node credits the current head');
  await check(() => assert.equal(heat[String(oldDecision)], undefined), 'the retired node is not charged');

  // Throttle: one write per 60 s per workspace. A fresh workspace starts with
  // no previous write, which is the "single-shot process still records it" case.
  const throttledCwd = join(root, 'throttle');
  usage.resetUsageCache(throttledCwd);
  const t0 = Date.now();
  const first = usage.noteNodeUse(throttledCwd, [ids.prefs[0]], { now: t0 });
  const second = usage.noteNodeUse(throttledCwd, [ids.prefs[1]], { now: t0 + 1000 });
  usage.flushUsage(throttledCwd, { now: t0 + 1000 });
  const third = usage.noteNodeUse(throttledCwd, [ids.prefs[2]], { now: t0 + 61_000 });
  await check(() => assert.equal(first.written, true), 'the first reference writes the sidecar immediately');
  await check(() => assert.equal(second.written, false), 'a second reference inside the window is coalesced');
  await check(() => assert.equal(second.throttled, true), 'the coalesced reference reports itself as throttled');
  await check(() => assert.equal(third.written, true), 'the next reference after 60 s writes again');
  await check(() => assert.equal(usage.usageFor(throttledCwd)[String(ids.prefs[2])]?.count, 1), 'the flushed file keeps the coalesced reference');
  await check(() => assert.equal(usage.USAGE_WRITE_THROTTLE_MS, 60_000), 'the throttle is 60 s');

  // The heat never enters the graph: same node count, no payload fields.
  await check(() => {
    const node = db.get(hotEntityA);
    assert.equal(node.payload.count, undefined);
    assert.equal(node.payload.lastUsedAt, undefined);
    assert.equal(node.payload.usage, undefined);
  }, 'graph payloads carry no heat fields');
  await check(() => assert.ok(existsSync(join(cwd, '.dsh', 'trivium-usage.json'))), 'the sidecar lives beside the database');
  await check(() => assert.equal(DIM, 1536), 'DIM is untouched');

  // Robustness: no workspace -> no throw, no write.
  await check(() => assert.equal(usage.noteNodeUse('', [1]).written, false), 'a reference without a workspace is ignored');
  await check(() => assert.deepEqual(usage.usageFor(''), {}), 'reading heat without a workspace returns nothing');

  // Corruption degrades to "no heat" instead of breaking a read.
  const broken = join(root, 'broken');
  const brokenDb = await store.openWorkspaceDb(broken);
  store.insertNode(brokenDb, { type: 'preference', name: 'kept', text: 'kept' });
  mkdirSync(join(broken, '.dsh'), { recursive: true });
  writeFileSync(join(broken, '.dsh', 'trivium-usage.json'), '{not json', 'utf8');
  usage.resetUsageCache(broken);
  await check(() => {
    const report = store.buildShortMapReport(brokenDb, 400);
    assert.ok(report.text.includes('preference:kept'));
  }, 'a corrupt usage file degrades to no heat');
} finally {
  store.closeAll();
  usage.resetUsageCache();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P73: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
