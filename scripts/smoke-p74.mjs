/**
 * p74 — B3 incremental map injection (S0-2).
 *
 * Covers:
 *   1. three turns with no new facts cost zero injection tokens (>= 50 % less
 *      than repeating the full map), while the facts from the first injection
 *      are still in the session context;
 *   2. a changed fact set injects a summary + diff lines, and the summary says
 *      how many entries stay unexpanded;
 *   3. the map carries a version that includes the budget;
 *   4. a forced full injection on the first turn, every N turns, and whenever
 *      the version cannot be computed;
 *   5. repeated pre-steps inside one user turn do not advance the counter.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p74-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const plugin = await import('../lib/index.js');

let checks = 0;
let failures = 0;
async function check(fn, label) {
  checks += 1;
  try { await fn(); console.log('ok ' + label); } catch (e) { failures += 1; console.error('FAIL ' + label + ': ' + e.message); }
}

const cwd = join(root, 'ws');
const db = await store.openWorkspaceDb(cwd);
const options = { mapTokenBudget: 400 };

function fakeAgent(id) {
  const agent = {
    session: { id, header: { cwd } },
    injected: [],
    inject(message) { agent.injected.push(message); },
  };
  return agent;
}
const textOf = (message) => (message?.content || []).map((block) => block?.text || '').join('\n');

try {
  // Five noise entities keep the map at exactly its eight slots once the three
  // kept facts are added, so "the facts are named" is about selection, not luck.
  for (let i = 0; i < 5; i += 1) store.insertNode(db, { type: 'entity', name: `noise-${String(i).padStart(2, '0')}`, text: `noise-${String(i).padStart(2, '0')}` });
  const kept = [
    store.insertNode(db, { type: 'decision', name: 'deploy-window', text: 'deploy-window' }),
    store.insertNode(db, { type: 'preference', name: 'pkg-mgr', text: 'pkg-mgr' }),
    store.insertNode(db, { type: 'entity', name: 'auth-gateway', text: 'auth-gateway' }),
  ];

  const agent = fakeAgent('sess-p74');
  await plugin.ensureShortMap(agent, options);
  const firstText = textOf(agent.injected[0]);
  const fullTokens = store.buildShortMapReport(db, 400).tokens;
  await check(() => assert.equal(agent.injected.length, 1), 'the first turn injects the map');
  await check(() => assert.ok(firstText.includes('auth-gateway')), 'the full map names the facts');
  await check(() => assert.match(firstText, /^dsh-trivium memory map:/), 'the first injection is the full map, not a diff');

  // Three quiet turns: same database, only the turn key moves.
  const quiet = [];
  for (const turnKey of ['turn-2', 'turn-3', 'turn-4']) {
    const plan = plugin.refreshShortMap(agent, db, options, turnKey);
    quiet.push({ turnKey, plan });
  }
  const quietTokens = quiet.reduce((sum, row) => sum + Number(row.plan?.tokens || 0), 0);
  const baseline = fullTokens * 3;
  await check(() => assert.equal(agent.injected.length, 1), 'quiet turns inject nothing');
  await check(() => assert.ok(quiet.every((row) => row.plan?.mode === 'skip')), 'each quiet turn is reported as a skip');
  await check(() => assert.ok(quiet.every((row) => row.plan?.reason === 'unchanged')), 'the skip reason is "unchanged"');
  await check(
    () => assert.ok((baseline - quietTokens) / baseline >= 0.5),
    `three quiet turns drop injection tokens by >= 50% (${baseline} -> ${quietTokens})`,
  );
  await check(
    () => assert.ok(kept.every((id) => firstText.includes(db.get(id).payload.name))),
    'the facts are still named in the session context that was already injected',
  );

  // Same user turn re-entered (tool loop): no counter movement, no injection.
  await check(() => assert.equal(plugin.refreshShortMap(agent, db, options, 'turn-4'), null), 'a repeated pre-step in the same turn does nothing');
  await check(() => assert.equal(agent.injected.length, 1), 'the repeated pre-step injects nothing');

  // A new fact: summary + diff line.
  const added = store.insertNode(db, { type: 'decision', name: 'release-train', text: 'release-train' });
  const changedPlan = plugin.refreshShortMap(agent, db, options, 'turn-5');
  const changedText = textOf(agent.injected[agent.injected.length - 1]);
  await check(() => assert.equal(changedPlan?.mode, 'diff'), 'a changed fact set injects a diff');
  await check(() => assert.equal(agent.injected.length, 2), 'exactly one new message is injected');
  await check(() => assert.ok(changedText.includes('+decision:release-train')), `the diff names the new fact (got ${changedText})`);
  await check(() => assert.match(changedText, /memory map changed: \+1 new, -0 retired, ~0 relabeled/), 'the diff starts with a summary line');
  await check(() => assert.match(changedText, /\d+ more entries stay unexpanded/), 'the summary says how many entries are not expanded');
  await check(() => assert.ok(changedPlan.tokens > 0 && changedPlan.tokens < fullTokens), `the diff is smaller than the full map (${changedPlan.tokens} vs ${fullTokens})`);
  await check(() => assert.equal(db.get(added).payload.name, 'release-train'), 'the diff did not write anything');

  // A retired fact shows up as a removal.
  const { archiveNode } = store;
  archiveNode(db, added);
  const retirePlan = plugin.refreshShortMap(agent, db, options, 'turn-6');
  const retireText = textOf(agent.injected[agent.injected.length - 1]);
  await check(() => assert.equal(retirePlan?.mode, 'diff'), 'a retired fact injects a diff');
  await check(() => assert.ok(retireText.includes('-decision:release-train')), `the retired fact is listed as removed (got ${retireText})`);
  await check(() => assert.match(retireText, /-1 retired/), 'the summary counts the removal');

  // Forced full refresh after N turns.
  const stateReport = store.buildShortMapReport(db, 400);
  const forced = plugin.planMapInjection(
    { version: stateReport.version, entries: stateReport.entries },
    stateReport,
    { turnsSince: plugin.MAP_FULL_REFRESH_TURNS },
  );
  await check(() => assert.equal(forced.mode, 'full'), 'a full map is forced once N turns have passed');
  await check(() => assert.equal(forced.reason, 'refresh'), 'the forced full injection says why');
  await check(() => assert.equal(plugin.MAP_FULL_REFRESH_TURNS, 6), 'N is six turns');
  await check(() => {
    const before = plugin.planMapInjection(
      { version: stateReport.version, entries: stateReport.entries },
      stateReport,
      { turnsSince: plugin.MAP_FULL_REFRESH_TURNS - 1 },
    );
    assert.equal(before.mode, 'skip');
  }, 'N-1 turns still skips');

  // Uncomputable version -> full, never a diff against an unknown baseline.
  await check(() => {
    const plan = plugin.planMapInjection({ version: 'mapv-x-1-400' }, { text: 'anything', tokens: 3 }, { turnsSince: 1 });
    assert.equal(plan.mode, 'full');
    assert.equal(plan.reason, 'no-version');
    assert.equal(plan.text, 'anything');
  }, 'a map without a version is injected in full');

  // The version depends on the budget and on the visible set.
  const withBudget = store.buildShortMapReport(db, 400);
  const otherBudget = store.buildShortMapReport(db, 300);
  await check(() => assert.notEqual(withBudget.version, otherBudget.version), 'the version includes the budget');
  const mutated = { ...withBudget, entries: withBudget.entries.slice(1) };
  await check(() => assert.notEqual(mutated.entries.length, withBudget.entries.length), 'fixture: the entry list is mutable for the comparison');
  await check(() => assert.match(withBudget.version, /^mapv-fnv1a-[0-9a-f]+-\d+-400$/), `the version is a fingerprint + count + budget (${withBudget.version})`);

  // A body-only edit must not produce a "0 new, 0 retired" diff.
  const bodyOnly = store.buildShortMapReport(db, 400);
  await check(() => {
    const fakePrevious = {
      version: 'mapv-fnv1a-deadbeef-0-400',
      entries: bodyOnly.entries.map((row) => ({ ...row })),
    };
    const plan = plugin.planMapInjection(fakePrevious, bodyOnly, { turnsSince: 1 });
    assert.equal(plan.mode, 'skip');
    assert.equal(plan.reason, 'version-only');
    assert.equal(plan.tokens, 0);
  }, 'a version-only change does not buy a diff');

  /*
   * A tool loop hands over the delta on later steps, so those pre-steps carry no
   * user message and `mapTurnKeyOf` returns "". Counting each of them as a turn
   * made `turnsSince` walk 0 -> 3 inside one user turn on a real host
   * (2026-11-06, measured twice), which buys a forced full map every second turn.
   */
  const beforeDeltas = agent.injected.length;
  const deltas = [1, 2, 3].map(() => plugin.refreshShortMap(agent, db, options, ''));
  await check(() => assert.deepEqual(deltas, [null, null, null]), 'pre-steps without a user message do not move the counter');
  await check(() => assert.equal(agent.injected.length, beforeDeltas), 'those pre-steps inject nothing');
  await check(() => assert.ok(plugin.refreshShortMap(agent, db, options, 'turn-7')), 'the next real turn still refreshes');

  /*
   * F86-01 (external review, 2026-11-06): a host that never exposes a user
   * message keeps writing "" into `previous.turnKey`, so the anchor is missing
   * and six empty pre-steps walked 1 -> 2 -> 3 -> 4 -> 5 -> full/refresh.
   * The first empty observation may start a turn; the rest may not.
   */
  const keyless = fakeAgent('sess-p74-keyless');
  await plugin.ensureShortMap(keyless, options);
  const keylessInjections = keyless.injected.length;
  const firstEmpty = plugin.refreshShortMap(keyless, db, options, '');
  const restEmpty = [1, 2, 3, 4, 5].map(() => plugin.refreshShortMap(keyless, db, options, ''));
  await check(() => assert.ok(firstEmpty), 'a key-less host still gets its first refresh');
  await check(
    () => assert.deepEqual(restEmpty, [null, null, null, null, null]),
    'repeated empty observations do not move the counter',
  );
  await check(
    () => assert.equal(keyless.injected.length, keylessInjections),
    'six empty pre-steps never force a full refresh',
  );
  await check(
    () => assert.ok(plugin.refreshShortMap(keyless, db, options, 'turn-after-keyless')),
    'a real key still starts a new turn after empty observations',
  );
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P74: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
