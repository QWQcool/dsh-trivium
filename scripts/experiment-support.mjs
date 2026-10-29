import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';

export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function assertInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  assert.ok(rel && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel), 'Refuse non-synthetic path');
  return resolve(target);
}
export function cellIdentity(root, arm, rep, scenario) {
  for (const s of [arm, String(rep), scenario]) assert.match(s, /^[a-zA-Z0-9_-]+$/, 'Invalid cell identity');
  const cell = assertInside(root, join(root, arm, `r${rep}`, scenario));
  return { cell, wsA: join(cell, 'ws-a'), wsB: join(cell, 'ws-b'), sessionId: `${arm}/${rep}/${scenario}`, settings: join(cell, 'settings.json'), home: join(cell, 'home') };
}
export function prepareCell(root, arm, rep, scenario) {
  const row = cellIdentity(root, arm, rep, scenario);
  assert.equal(existsSync(row.cell), false, 'A cell must never be replanted');
  mkdirSync(row.cell, { recursive: true });
  assertInside(realpathSync(root), realpathSync(row.cell));
  process.env.DSH_HOME = row.home;
  process.env.DSH_TRIVIUM_SETTINGS = row.settings;
  writeFileSync(row.settings, JSON.stringify({ recallMode: 'auto', extractEnabled: false, gitSidecarEnabled: false, embeddingEnabled: false }));
  return row;
}
export function fixtureReceipt(facts, observedTexts) {
  const expected = facts.map((f) => String(f.text)).sort();
  const observed = observedTexts.map(String).sort();
  assert.deepEqual(observed, expected, 'Stored fixture facts differ from the shared source');
  return { count: observed.length, contentHash: digest(observed), sourceHash: digest(facts) };
}
