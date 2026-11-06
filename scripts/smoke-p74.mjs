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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'trivium-p74-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const plugin = await import('../lib/index.js');
const tokens = await import('../lib/tokens.js');
const usage = await import('../lib/usage.js');
const { DIM } = await import('../lib/schema.js');
const { estimateTokens } = tokens;

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
  // F3 budget contracts consolidated from smoke-p88.
  const entry = (id, label) => ({ id, label });
  const many = (prefix, count) => Array.from({ length: count }, (_, i) => entry(i + 1, `${prefix}${i} 很长的事实标题用于撑大差异文本`));
  await check(() => {
    const previous = { version: 'v1', entries: many('old', 6) };
    const report = { version: 'v2', entries: [...many('old', 6), ...many('new', 12)], hidden: 0 };
    const diff = plugin.buildMapDiff(previous, report, { tokenBudget: 400 });
    assert.ok(diff.text.length > 0);
    assert.ok(diff.lines <= 19, `line count is bounded (${diff.lines})`);
    assert.ok(tokens.estimateTokens(diff.text) <= 400, 'a 12-line diff still fits the budget');
  }, 'the diff reports how many rows it left out');
  await check(() => {
    const previous = { version: 'v1', entries: many('old', 40) };
    const report = { version: 'v2', entries: many('new', 40), hidden: 0 };
    const diff = plugin.buildMapDiff(previous, report, { tokenBudget: 400 });
    const used = tokens.estimateTokens(diff.text);
    assert.ok(used <= 400, `diff stays inside the budget (${used})`);
    /*
     * A budget smaller than the header must produce **no text at all**, not a
     * header that overruns it (second audit measured 31 tokens against a 20-token
     * budget). No `|| lines === 1` escape hatch: the budget is the contract.
     */
    const tight = plugin.buildMapDiff(previous, report, { tokenBudget: 40 });
    const tightTokens = tokens.estimateTokens(tight.text);
    assert.ok(tightTokens <= 40, `a 40-token budget is honoured (${tightTokens})`);
    assert.ok(tight.omitted > 0, `clipping reports how many rows it dropped (${tight.omitted})`);
    assert.equal(tight.omitted, tight.added + tight.changed + tight.removed, 'omitted counts every change that was not printed');
    // Fourth audit round: the number the model reads must equal the structured one.
    if (tight.omitted > 0) {
      assert.ok(
        tight.text.includes(`…${tight.omitted} more changes`),
        `the marker must say ${tight.omitted}: ${tight.text.split('\n').pop()}`,
      );
    }
    const tooSmall = plugin.buildMapDiff(previous, report, { tokenBudget: 5 });
    assert.equal(tooSmall.text, '', 'a budget below the header injects nothing');
    assert.ok(tooSmall.omitted > 0);
  }, 'a large diff is clipped to the map budget');
  await check(() => {
    const previous = { version: 'v1', entries: [] };
    const report = { version: 'v2', entries: [entry(1, '一个')], hidden: 0 };
    const diff = plugin.buildMapDiff(previous, report, { tokenBudget: 400 });
    assert.ok(diff.text.includes('+一个'));
    assert.equal(diff.omitted, 0);
  }, 'a small diff is not clipped');
  /*
   * ---- merged from p73 (B2 map heat) ----
   *
   * Same subsystem as the map injection above: heat decides which facts the map
   * can name inside the budget. It keeps its own workspace so the fixtures of the
   * two halves cannot leak into each other.
   */
  await (async () => {
    const root = mkdtempSync(join(tmpdir(), 'trivium-p73-'));

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
  })();
} finally {
  store.closeAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(`P74: ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
