#!/usr/bin/env node
/**
 * Real-host error-state probe for the entity-search panel.
 *
 * The panel maps HTTP status+code to one message per code (covered by `p101`).
 * This script checks the other half against a *running host*: which envelopes a
 * real plugin build actually produces, how long each takes, and which states
 * cannot be produced in a small synthetic library at all.
 *
 * It talks to the host's own HTTP API, so `cwd` must already be open in that
 * host; `--unopened` probes the 409 WORKSPACE_NOT_OPEN path with a path the host
 * does not know.
 *
 * Usage:
 *   node scripts/verify-panel-errors-live.mjs --base http://127.0.0.1:7800 --token TOKEN --cwd <open> [--unopened <dir>] [--out FILE]
 *   node scripts/verify-panel-errors-live.mjs --seed <dir> [--facts 1200]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith('--')) args[key.slice(2)] = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
}
const header = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function seed(dir, facts) {
  const store = await import('../lib/store.js');
  const db = await store.openWorkspaceDb(dir);
  db.insertWithId(101, Array(1536).fill(0), {
    type: 'entity', name: 'P0Hub', text: '压力测试实体。', status: 'active',
    createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
  });
  for (let i = 0; i < facts; i += 1) {
    const id = 1001 + i;
    db.insertWithId(id, Array(1536).fill(0), {
      type: 'decision', name: `策略 ${i}`, text: `P0Hub 的第 ${i} 条合成事实：保留 ${i % 97} 天。`,
      status: 'active', createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
    });
    db.link(id, 101, 'about', 1);
  }
  db.flush();
  const total = db.allNodeIds().length;
  store.closeAll();
  console.log(JSON.stringify({ seeded: total, dir }, null, 2));
}

async function probe(base, token, cwd, body) {
  const started = Date.now();
  const url = `${base}/api/dsh-trivium/entity-search?cwd=${encodeURIComponent(cwd)}`;
  const res = await fetch(url, { method: 'POST', headers: header(token), body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, code: json?.code || '', ok: json?.ok, ms: Date.now() - started, bytes: Buffer.byteLength(text) };
}

if (args.seed) {
  await seed(resolve(args.seed), Number(args.facts || 1200));
} else {
  const base = args.base;
  const cwd = resolve(args.cwd);
  if (!base || !args.token || !args.cwd) throw new Error('--base, --token and --cwd are required');
  const report = { base, cwd, at: new Date().toISOString(), single: null, burst: [], unopened: null, missingSnapshot: null };
  report.single = await probe(base, args.token, cwd, { entityId: Number(args.entityId || 101), query: args.query || '第 5 条合成事实', limit: 5 });
  report.burst = (await Promise.all(Array.from({ length: 8 }, (_, i) =>
    probe(base, args.token, cwd, { entityId: Number(args.entityId || 101), query: `第 ${i} 条合成事实`, limit: 5 }))))
    .map((row) => `${row.status}${row.code ? ':' + row.code : ''}`);
  report.missingSnapshot = await probe(base, args.token, cwd, { entityId: Number(args.entityId || 101), query: '第 5 条合成事实', limit: 5, snapshotId: 'latest' });
  if (args.unopened) report.unopened = await probe(base, args.token, resolve(args.unopened), { entityId: 101, query: '任意问题', limit: 5 });
  const summary = {
    single: `${report.single.status}${report.single.code ? ':' + report.single.code : ''} (${report.single.ms} ms)`,
    burst: report.burst.join(' '),
    missingSnapshot: `${report.missingSnapshot.status}:${report.missingSnapshot.code} (${report.missingSnapshot.ms} ms)`,
    unopened: report.unopened ? `${report.unopened.status}:${report.unopened.code} (${report.unopened.ms} ms)` : 'not probed',
  };
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(resolve(args.out), JSON.stringify(report, null, 2) + '\n');
    console.log('wrote ' + join(args.out));
  }
}
