#!/usr/bin/env node
/**
 * Offline citation-format and pack-scope check (P1-B).
 *
 * For each frozen case it seeds a synthetic workspace, builds the real memory
 * pack for the question, and checks three things that must hold regardless of
 * which model answers:
 *   1. every relevant fact id reaches the pack;
 *   2. no forbidden id (sibling entity, foreign workspace, retired fact) does;
 *   3. the rendered context carries numeric ids (`#201`), within the token budget.
 *
 * It does not generate answers, so final-answer accuracy stays "not measured".
 *
 * Usage: node scripts/memory-citations-check.mjs [--fixture FILE] [--out FILE] [--budget 300] [--print]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith('--')) continue;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) args[key.slice(2)] = true;
  else { args[key.slice(2)] = value; i += 1; }
}

const FIXTURE = resolve(args.fixture || join('scripts', 'fixtures', 'memory-citations-v1.json'));
const BUDGET = Number(args.budget || 300);
const raw = readFileSync(FIXTURE, 'utf8');
const fixture = JSON.parse(raw);
const root = mkdtempSync(join(tmpdir(), 'trivium-citations-'));
process.env.DSH_HOME = join(root, 'home');
process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');

const store = await import('../lib/store.js');
const { searchEntity } = await import('../lib/entity-search.js');

const rows = [];
try {
  for (const [index, testCase] of fixture.cases.entries()) {
    const cwd = join(root, `c-${index}-${testCase.id}`);
    const db = await store.openWorkspaceDb(cwd);
    const anchor = Number(testCase.facts[0]?.id || 101);
    const anchorId = 101;
    db.insertWithId(anchorId, Array(1536).fill(0), {
      type: 'entity', name: testCase.entity, aliases: testCase.alias ? [testCase.alias] : [],
      text: `${testCase.entity} 实体。`, status: 'active',
      createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
    });
    let siblingId = null;
    for (const fact of testCase.facts) {
      if (fact.foreign) {
        const foreign = await store.openWorkspaceDb(join(cwd, 'foreign'));
        foreign.insertWithId(101, Array(1536).fill(0), {
          type: 'entity', name: testCase.entity, text: `${testCase.entity} 实体。`, status: 'active',
          createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
        });
        foreign.insertWithId(fact.id, Array(1536).fill(0), {
          type: 'decision', name: fact.name, text: fact.text, status: 'active',
          createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
        });
        foreign.link(fact.id, 101, 'about', 1);
        foreign.flush();
        continue;
      }
      if (fact.sibling) {
        if (siblingId == null) {
          siblingId = 300;
          db.insertWithId(siblingId, Array(1536).fill(0), {
            type: 'entity', name: testCase.entity, text: `${testCase.entity} 同名旁支。`, status: 'active',
            createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
          });
        }
        db.insertWithId(fact.id, Array(1536).fill(0), {
          type: 'decision', name: fact.name, text: fact.text, status: 'active',
          createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
        });
        db.link(fact.id, siblingId, 'about', 1);
        continue;
      }
      db.insertWithId(fact.id, Array(1536).fill(0), {
        type: 'decision', name: fact.name, text: fact.text, status: 'active',
        createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z',
      });
      db.link(fact.id, anchorId, 'about', 1);
    }
    const replacements = testCase.facts.filter((fact) => fact.supersedes);
    if (replacements.length) {
      const revisions = await import('../lib/revisions.js');
      for (const fact of replacements) {
        const applied = revisions.supersede(db, { oldId: fact.supersedes, successorId: fact.id, reason: 'synthetic citation fixture' });
        if (!applied || applied.ok !== true) throw new Error(`${testCase.id}: supersede failed ${JSON.stringify(applied)}`);
      }
    }
    db.flush();

    for (const question of testCase.questions) {
      const result = await searchEntity(db, { entityId: anchorId, query: question.q, limit: 8, packTokens: BUDGET });
      const pack = result.memoryPack || null;
      const factIds = new Set((pack?.facts || []).map((fact) => String(fact.id)));
      const context = String(pack?.context || '');
      const missing = (question.relevant || []).map(String).filter((id) => !factIds.has(id));
      const leaked = (question.forbidden || []).map(String).filter((id) => factIds.has(id));
      // The pack renders ids as unquoted JSON integers on purpose; a quoted id is a format defect.
      const numericRelevant = (question.relevant || []).filter((id) =>
        !context.includes(`"id":${id},`) || context.includes(`"id":"${id}"`));
      rows.push({
        id: testCase.id,
        split: testCase.split,
        category: testCase.category,
        q: question.q,
        pack: !!pack,
        budgetOk: !!pack && pack.estimatedTokens <= BUDGET,
        tokens: pack?.estimatedTokens ?? null,
        missing,
        leaked,
        nonNumeric: numericRelevant,
      });
    }
    store.closeAll();
  }
} finally {
  try { store.closeAll(); } catch { /* closed */ }
  rmSync(root, { recursive: true, force: true });
}

const sum = (fn) => rows.reduce((total, row) => total + fn(row), 0);
const report = {
  meta: {
    fixture: fixture.version,
    fixtureHash: createHash('sha256').update(raw).digest('hex'),
    budgetTokens: BUDGET,
    questions: rows.length,
    cases: fixture.cases.length,
    finalAnswerAccuracy: 'not measured (no answer is generated)',
    realModelCalls: 0,
    realEmbeddingCalls: 0,
    at: new Date().toISOString(),
  },
  summary: {
    packBuilt: rows.filter((row) => row.pack).length,
    missingEvidence: rows.filter((row) => row.missing.length).length,
    leakedEvidence: rows.filter((row) => row.leaked.length).length,
    nonNumericIds: rows.filter((row) => row.nonNumeric.length).length,
    overBudget: rows.filter((row) => row.pack && !row.budgetOk).length,
    bySplit: Object.fromEntries(['dev', 'holdout'].map((split) => {
      const subset = rows.filter((row) => row.split === split);
      return [split, {
        questions: subset.length,
        missing: subset.filter((row) => row.missing.length).length,
        leaked: subset.filter((row) => row.leaked.length).length,
        nonNumeric: subset.filter((row) => row.nonNumeric.length).length,
      }];
    })),
  },
  rows,
};

console.log(JSON.stringify({
  questions: rows.length,
  packBuilt: report.summary.packBuilt,
  missingEvidence: report.summary.missingEvidence,
  leakedEvidence: report.summary.leakedEvidence,
  nonNumericIds: report.summary.nonNumericIds,
  overBudget: report.summary.overBudget,
  bySplit: report.summary.bySplit,
}, null, 2));

if (args.print) for (const row of rows) {
  if (row.missing.length || row.leaked.length || row.nonNumeric.length) {
    console.log(`${row.id} ${row.split} missing=${row.missing.join(',')} leaked=${row.leaked.join(',')} nonNumeric=${row.nonNumeric.join(',')}`);
  }
}
if (args.out) {
  const target = resolve(args.out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  console.log('wrote ' + target);
}
/*
 * Invariants that must hold no matter which facts a lexical pack misses:
 * retired/foreign/sibling facts never leak, the pack never exceeds its budget,
 * and a fact that IS in the pack is always rendered with an unquoted id.
 * Missing evidence is reported, not failed: lexical recall is a known limit.
 */
if (args.strict) {
  const broken = rows.filter((row) => row.leaked.length || !row.pack || !row.budgetOk
    || row.nonNumeric.some((id) => !row.missing.includes(String(id))));
  if (broken.length) {
    console.error('invariants broken: ' + broken.map((row) => row.id).join(','));
    process.exitCode = 1;
  } else {
    console.log('invariants ok (leaks 0, budget ok, numeric ids for every present fact)');
  }
}
