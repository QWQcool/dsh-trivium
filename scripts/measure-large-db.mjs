#!/usr/bin/env node
/**
 * Large-library timing probe (P2-B).
 *
 * Paging and async cursors are only worth building if a measured read actually
 * blocks. This seeds a synthetic library, then times the read paths the panel
 * uses and reports p50/p95 plus how often the fixed work budget rejects them.
 *
 * Usage: node scripts/measure-large-db.mjs [--sizes 5000,20000] [--reps 20] [--out FILE]
 */
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith('--')) continue;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) args[key.slice(2)] = true;
  else { args[key.slice(2)] = value; i += 1; }
}
const sizes = String(args.sizes || '5000').split(',').map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
const reps = Math.max(3, Number(args.reps || 20));

const root = mkdtempSync(join(tmpdir(), 'trivium-large-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
const store = await import('../lib/store.js');
const { searchEntity } = await import('../lib/entity-search.js');

const base = { status: 'active', createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z' };
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};
const time = async (fn) => {
  const started = process.hrtime.bigint();
  let code = '';
  try { await fn(); } catch (error) { code = error.code || error.message; }
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, code };
};

const report = { at: new Date().toISOString(), reps, sizes: [] };
try {
  for (const size of sizes) {
    const cwd = join(root, `db-${size}`);
    let db = await store.openWorkspaceDb(cwd);
    const seeded = Date.now();
    db.insertWithId(101, Array(1536).fill(0), { type: 'entity', name: 'ScaleHub', text: '规模测试实体。', ...base });
    const hubFacts = Math.min(900, Math.floor(size / 5));
    for (let i = 0; i < hubFacts; i += 1) {
      const id = 1001 + i;
      db.insertWithId(id, Array(1536).fill(0), { type: 'decision', name: `策略 ${i}`, text: `ScaleHub 的第 ${i} 条合成事实：保留 ${i % 97} 天。`, ...base });
      db.link(id, 101, 'about', 1);
    }
    const remaining = Math.max(0, size - 1 - hubFacts);
    for (let i = 0; i < remaining; i += 1) {
      const id = 50000 + i;
      db.insertWithId(id, Array(1536).fill(0), { type: 'entity', name: `Noise ${i}`, text: `与实体无关的第 ${i} 条背景记录。`, ...base });
    }
    db.flush();
    const seedMs = Date.now() - seeded;

    const entityRuns = [];
    for (let i = 0; i < reps; i += 1) {
      // A distinct query per sample: an identical one is served from the query cache and would hide the real work.
      entityRuns.push(await time(() => searchEntity(db, { entityId: 101, query: `第 ${i} 条合成事实 保留 ${i % 97} 天`, limit: 5 })));
    }
    const packRuns = [];
    for (let i = 0; i < reps; i += 1) {
      packRuns.push(await time(() => searchEntity(db, { entityId: 101, query: `ScaleHub 第 ${i} 条保留多少天`, limit: 5, packTokens: 300 })));
    }
    const statusRuns = [];
    for (let i = 0; i < reps; i += 1) {
      statusRuns.push(await time(() => { db.allNodeIds(); }));
    }
    const bytes = readdirSync(join(cwd, '.dsh')).reduce((total, name) => {
      try { return total + statSync(join(cwd, '.dsh', name)).size; } catch { return total; }
    }, 0);

    report.sizes.push({
      size,
      hubFacts,
      seedMs,
      diskBytes: bytes,
      entitySearch: {
        p50: pct(entityRuns.map((r) => r.ms), 50),
        p95: pct(entityRuns.map((r) => r.ms), 95),
        rejected: entityRuns.filter((r) => r.code === 'ENTITY_SEARCH_WORK_LIMIT').length,
        samples: entityRuns.length,
      },
      packSearch: {
        p50: pct(packRuns.map((r) => r.ms), 50),
        p95: pct(packRuns.map((r) => r.ms), 95),
        rejected: packRuns.filter((r) => r.code === 'ENTITY_SEARCH_WORK_LIMIT').length,
        samples: packRuns.length,
      },
      nodeCount: {
        p50: pct(statusRuns.map((r) => r.ms), 50),
        p95: pct(statusRuns.map((r) => r.ms), 95),
        samples: statusRuns.length,
      },
    });
    store.closeAll();
  }
} finally {
  try { store.closeAll(); } catch { /* closed */ }
  rmSync(root, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
if (args.out) {
  const target = resolve(args.out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  console.log('wrote ' + target);
}
