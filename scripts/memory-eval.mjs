#!/usr/bin/env node
/**
 * Offline memory baseline: fact writes, retrieval scope/relevance and cost.
 *
 * The corpus (`scripts/fixtures/memory-eval-v1.json`) freezes, per scenario, the
 * workspace seeds, the user turn, the memory reads the agent performed, the
 * candidates the extractor is asked to consider, and the expected writes plus
 * the relevant/forbidden node ids for a scoped question. Nothing is generated at
 * run time and no model is called: `distill()` runs the real write path with a
 * stub `llmCall` that returns the frozen candidates, and retrieval runs through
 * the real entity-search backend with the semantic channel off.
 *
 * Therefore:
 *   - it is a "frozen-candidate" baseline, NOT a measurement of model extraction;
 *   - "final answer accuracy" is not measured (no answer is generated).
 *
 * Usage:
 *   node scripts/memory-eval.mjs --out docs/reviews/MEMORY-EVAL-BASELINE-2026-11-16.json
 *   node scripts/memory-eval.mjs --split holdout --reps 3 --print
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const FIXTURE_PATH = join(HERE, 'fixtures', 'memory-eval-v1.json');
export const EVALUATOR_VERSION = 'memory-eval-evaluator-1';

/** Whitespace and trailing punctuation are not facts; everything else is compared as written. */
export function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[。；;，,、]+$/g, '');
}

const sameText = (a, b) => normalizeText(a) === normalizeText(b);
const overlaps = (a, b) => {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
};

/**
 * Classify what the write path did against the frozen expectations.
 *
 * `observed.nodes` is the final database state, so a candidate that "succeeded"
 * but lost its body still counts as missed. A body that only overlaps the
 * expectation is `needs-review`, never silently correct.
 */
export function scoreWrites(scenario, observed) {
  const expect = scenario.expect || {};
  const nodes = observed.nodes || [];
  const before = new Set((observed.beforeIds || []).map(Number));
  const present = (expect.present || []).map((item) => {
    const exact = nodes.filter((node) => sameText(node.text, item.text));
    if (exact.length) {
      return { text: item.text, verdict: exact.length > 1 ? 'duplicate' : 'correct', ids: exact.map((n) => Number(n.id)) };
    }
    const near = nodes.filter((node) => overlaps(node.text, item.text));
    if (near.length) {
      return { text: item.text, verdict: 'needs-review', ids: near.map((n) => Number(n.id)), actual: near.map((n) => n.text) };
    }
    return { text: item.text, verdict: 'missed', ids: [] };
  });
  const absent = (expect.absent || []).map((item) => {
    const hit = nodes.filter((node) => overlaps(node.text, item.text));
    return { text: item.text, verdict: hit.length ? 'unsourced-new' : 'ok', ids: hit.map((n) => Number(n.id)) };
  });
  const duplicateGroups = [];
  const buckets = new Map();
  for (const node of nodes) {
    const key = `${node.type}\u0000${normalizeText(node.text)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(Number(node.id));
  }
  for (const [key, ids] of buckets) {
    if (ids.length > 1) duplicateGroups.push({ type: key.split('\u0000')[0], ids });
  }
  const intact = (expect.intact || []).map((item) => {
    const node = nodes.find((row) => Number(row.id) === Number(item.id));
    const ok = !!node && String(node.text || '').includes(item.contains);
    return { id: Number(item.id), contains: item.contains, verdict: ok ? 'intact' : 'overwritten', actual: node ? node.text : null };
  });
  const newNodes = nodes.filter((node) => !before.has(Number(node.id)));
  const echoes = (expect.echoes || []).map((item) => {
    const leaked = newNodes.filter((node) => overlaps(node.text, item.text));
    return { text: item.text, verdict: leaked.length ? 'leaked-as-new' : 'not-written', ids: leaked.map((n) => Number(n.id)) };
  });
  const skipped = observed.skipped || [];
  const applied = observed.applied || [];
  /*
   * Deterministic rules and the model can both write the same sentence (the rule
   * layer keeps the whole instruction as a preference). Those nodes are not
   * duplicates by text, but they are redundant content for one fact, so they are
   * counted separately instead of disappearing into "correct".
   */
  const redundantNew = newNodes.filter((node) =>
    present.some((row) => overlaps(node.text, row.text) && !sameText(node.text, row.text)));
  return {
    present,
    absent,
    intact,
    echoes,
    duplicateGroups,
    redundantNew: redundantNew.map((node) => ({ id: Number(node.id), type: node.type, text: node.text })),
    echoSkipped: skipped.filter((row) => row.reason === 'memory-read-echo').length,
    skippedReasons: skipped.map((row) => row.reason),
    applied: {
      inserted: applied.filter((row) => row.action === 'insert').length,
      merged: applied.filter((row) => row.action === 'merge').length,
    },
    newNodes: newNodes.map((node) => ({
      id: Number(node.id),
      type: node.type,
      text: node.text,
      source: String(node.source?.kind || node.source || ''),
    })),
    counts: {
      expected: present.length,
      correct: present.filter((row) => row.verdict === 'correct').length,
      duplicate: present.filter((row) => row.verdict === 'duplicate').length,
      needsReview: present.filter((row) => row.verdict === 'needs-review').length,
      missed: present.filter((row) => row.verdict === 'missed').length,
      absentChecked: absent.length,
      unsourcedNew: absent.filter((row) => row.verdict === 'unsourced-new').length,
      intactChecked: intact.length,
      intactBroken: intact.filter((row) => row.verdict !== 'intact').length,
      echoExpected: echoes.length,
      echoLeaked: echoes.filter((row) => row.verdict === 'leaked-as-new').length,
      duplicateGroups: duplicateGroups.length,
      redundantNew: redundantNew.length,
    },
  };
}

/** Top-1 / Top-5 against the frozen relevant ids; forbidden ids are reported separately. */
export function scoreRetrieval(scenario, result) {
  const spec = scenario.retrieval;
  if (!spec) return null;
  const ids = (result?.textCandidates || []).map((row) => Number(row.id));
  const relevant = (spec.relevant || []).map(Number);
  const forbidden = (spec.forbidden || []).map(Number);
  const scored = spec.kind === 'answerable';
  const top1 = scored && ids.length ? relevant.includes(ids[0]) : null;
  const top5 = scored ? ids.slice(0, 5).some((id) => relevant.includes(id)) : null;
  const forbiddenHits = ids.filter((id) => forbidden.includes(id));
  /*
   * The scope anchor is itself returned as a candidate, and it is never the
   * answer. Reported as a second, clearly labelled view rather than by shrinking
   * the frozen relevant set after seeing the result.
   */
  const nonAnchor = ids.filter((id) => id !== Number(spec.anchor));
  const top1ExcludingAnchor = scored && nonAnchor.length ? relevant.includes(nonAnchor[0]) : null;
  let textCheck = null;
  if (spec.textCheck) {
    const row = (result?.textCandidates || []).find((item) => Number(item.id) === Number(spec.textCheck.id));
    textCheck = {
      id: Number(spec.textCheck.id),
      present: !!row,
      contains: spec.textCheck.contains,
      ok: !!row && String(row.text || '').includes(spec.textCheck.contains),
    };
  }
  return {
    kind: spec.kind,
    state: result?.state || '',
    answerability: result?.answerability || '',
    candidates: ids,
    top1,
    top5,
    top1ExcludingAnchor,
    forbiddenHits,
    textCheck,
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/** Aggregate scenario results into the reportable counters. */
export function aggregate(results) {
  const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) || 0), 0);
  const writeRows = results.filter((row) => row.writes);
  const retrievalRows = results.filter((row) => row.retrieval);
  const answerable = retrievalRows.filter((row) => row.retrieval.kind === 'answerable');
  const unanswerable = retrievalRows.filter((row) => row.retrieval.kind !== 'answerable');
  return {
    scenarios: results.length,
    writes: {
      expected: sum(writeRows, (row) => row.writes.counts.expected),
      correct: sum(writeRows, (row) => row.writes.counts.correct),
      duplicate: sum(writeRows, (row) => row.writes.counts.duplicate),
      needsReview: sum(writeRows, (row) => row.writes.counts.needsReview),
      missed: sum(writeRows, (row) => row.writes.counts.missed),
      absentChecked: sum(writeRows, (row) => row.writes.counts.absentChecked),
      unsourcedNew: sum(writeRows, (row) => row.writes.counts.unsourcedNew),
      intactChecked: sum(writeRows, (row) => row.writes.counts.intactChecked || 0),
      intactBroken: sum(writeRows, (row) => row.writes.counts.intactBroken || 0),
      echoExpected: sum(writeRows, (row) => row.writes.counts.echoExpected),
      echoLeaked: sum(writeRows, (row) => row.writes.counts.echoLeaked),
      duplicateGroups: sum(writeRows, (row) => row.writes.counts.duplicateGroups),
      redundantNew: sum(writeRows, (row) => row.writes.counts.redundantNew || 0),
      inserted: sum(writeRows, (row) => row.writes.applied.inserted),
      merged: sum(writeRows, (row) => row.writes.applied.merged),
      echoSkipped: sum(writeRows, (row) => row.writes.echoSkipped),
    },
    retrieval: {
      answerable: answerable.length,
      top1: answerable.filter((row) => row.retrieval.top1 === true).length,
      top5: answerable.filter((row) => row.retrieval.top5 === true).length,
      top1ExcludingAnchor: answerable.filter((row) => row.retrieval.top1ExcludingAnchor === true).length,
      unanswerable: unanswerable.length,
      unanswerableCandidateTotal: sum(unanswerable, (row) => row.retrieval.candidates.length),
      forbiddenViolations: retrievalRows.filter((row) => row.retrieval.forbiddenHits.length).length,
    },
  };
}

async function evaluateScenario({ scenario, store, extract, source, searchEntity, root, index, rep }) {
  const cwd = join(root, `r${rep}-s${index}-${scenario.id}`);
  const started = process.hrtime.bigint();
  const db = await store.openWorkspaceDb(cwd);
  const seed = scenario.seed || {};
  for (const node of seed.nodes || []) {
    const { id, ...payload } = node;
    db.insertWithId(id, Array(1536).fill(0), {
      status: 'active',
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
      ...payload,
    });
  }
  for (const [from, to, label] of seed.edges || []) db.link(from, to, label, 1);
  if (seed.supersede) {
    const revisions = await import(new URL('../lib/revisions.js', import.meta.url).href);
    const result = revisions.supersede(db, {
      oldId: seed.supersede.oldId,
      successorId: seed.supersede.successorId,
      reason: 'synthetic eval',
    });
    if (!result || result.ok !== true) throw new Error(`supersede seed failed for ${scenario.id}: ${JSON.stringify(result)}`);
  }
  for (const id of seed.archive || []) store.archiveNode(db, id);
  if (seed.foreign) {
    const foreign = await store.openWorkspaceDb(join(cwd, 'foreign'));
    for (const node of seed.foreign.nodes || []) {
      const { id, ...payload } = node;
      foreign.insertWithId(id, Array(1536).fill(0), {
        status: 'active',
        createdAt: '2026-11-16T00:00:00.000Z',
        updatedAt: '2026-11-16T00:00:00.000Z',
        ...payload,
      });
    }
    for (const [from, to, label] of seed.foreign.edges || []) foreign.link(from, to, label, 1);
  }
  db.flush();

  const beforeIds = db.allNodeIds().map(Number);
  const turns = [
    source.turnFromEvent({
      type: 'user/message', seq: 11, time: 1794820542000,
      data: { id: 'user-11', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: scenario.prompt }] },
    }),
  ];
  for (const [offset, read] of (scenario.readBack || []).entries()) {
    const seq = 20 + offset;
    const payload = db.get(read.nodeId)?.payload || {};
    const text = read.tool === 'ctx_read'
      ? JSON.stringify({ id: read.nodeId, payload, edges: [], incoming: [] })
      : `[4.000] id=${read.nodeId} type=${payload.type || ''}\n${payload.text || ''}`;
    turns.push(source.turnFromEvent({
      type: 'tool/result', seq, time: 1794820543000 + offset,
      data: {
        turn: 1, step: 1,
        message: {
          id: `tool-${seq}`, role: 'tool', source: { kind: 'tool', callId: `call-${seq}` },
          isError: false, content: [{ type: 'text', text }],
        },
      },
    }, { name: read.tool }));
  }
  turns.push({ role: 'assistant', text: '已处理。', seq: 34, messageId: 'assistant-34' });

  let llmCalls = 0;
  const result = await extract.distill({
    db,
    turns,
    sessionId: `eval-${scenario.id}`,
    now: new Date('2026-11-16T00:00:00.000Z'),
    llmCall: async () => {
      llmCalls += 1;
      return JSON.stringify({ candidates: scenario.candidates || [] });
    },
  });

  let retrieval = null;
  if (scenario.retrieval) {
    const search = await searchEntity(db, {
      entityId: scenario.retrieval.anchor,
      query: scenario.retrieval.question,
      limit: scenario.retrieval.limit || 5,
    });
    retrieval = scoreRetrieval(scenario, search);
  }

  const nodesAfter = db.allNodeIds().map((id) => {
    const payload = db.get(id)?.payload || {};
    return { id, type: payload.type, text: payload.text, source: payload.source };
  });
  const writes = scenario.expect
    ? scoreWrites(scenario, { nodes: nodesAfter, beforeIds, applied: result.applied, skipped: result.skipped })
    : null;
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  store.closeAll();
  return {
    id: scenario.id,
    split: scenario.split,
    category: scenario.category,
    writes,
    retrieval,
    llmCalls,
    embedCalls: 0,
    ms: durationMs,
  };
}

export async function runEvaluation({ fixturePath = FIXTURE_PATH, split = 'all', reps = 1, only = null } = {}) {
  const raw = readFileSync(fixturePath, 'utf8');
  const fixture = JSON.parse(raw);
  const fixtureHash = createHash('sha256').update(raw).digest('hex');
  const selected = fixture.scenarios.filter((scenario) =>
    (split === 'all' || scenario.split === split) && (!only || only.includes(scenario.id)));
  if (!selected.length) throw new Error(`no scenario matches split=${split}`);

  const root = mkdtempSync(join(tmpdir(), 'trivium-memory-eval-'));
  process.env.DSH_HOME = join(root, 'home');
  process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
  const store = await import(new URL('../lib/store.js', import.meta.url).href);
  const extract = await import(new URL('../lib/extract.js', import.meta.url).href);
  const source = await import(new URL('../lib/source-events.js', import.meta.url).href);
  const { searchEntity } = await import(new URL('../lib/entity-search.js', import.meta.url).href);

  const results = [];
  const started = Date.now();
  try {
    for (let rep = 0; rep < reps; rep += 1) {
      for (const [index, scenario] of selected.entries()) {
        const row = await evaluateScenario({ scenario, store, extract, source, searchEntity, root, index, rep });
        results.push({ ...row, rep });
      }
    }
  } finally {
    try { store.closeAll(); } catch { /* already closed */ }
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const lastRep = results.filter((row) => row.rep === reps - 1);
  const bySplit = {};
  for (const name of [...new Set(selected.map((scenario) => scenario.split))]) {
    bySplit[name] = aggregate(lastRep.filter((row) => row.split === name));
  }
  const byCategory = {};
  for (const name of [...new Set(selected.map((scenario) => scenario.category))]) {
    byCategory[name] = aggregate(lastRep.filter((row) => row.category === name));
  }
  const durations = results.map((row) => row.ms);
  return {
    meta: {
      evaluator: EVALUATOR_VERSION,
      fixture: fixture.version,
      fixtureHash,
      fixturePath: relative(ROOT, fixturePath).split(sep).join('/'),
      split,
      reps,
      scenarios: lastRep.length,
      runs: results.length,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      realModelCalls: 0,
      realEmbeddingCalls: 0,
      tokens: 'not measured',
      billing: 'not measured',
      finalAnswerAccuracy: 'not measured (no answer is generated)',
    },
    timing: {
      samples: durations.length,
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: Math.max(...durations),
    },
    aggregate: aggregate(lastRep),
    bySplit,
    byCategory,
    results: lastRep.map(({ ms, ...row }) => row),
  };
}

function parseArgs(argv) {
  const out = { split: 'all', reps: 1, out: '', print: false, only: null, fixturePath: FIXTURE_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.out = argv[++i];
    else if (arg === '--split') out.split = argv[++i];
    else if (arg === '--reps') out.reps = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--only') out.only = String(argv[++i] || '').split(',').filter(Boolean);
    else if (arg === '--fixture') out.fixturePath = resolve(argv[++i]);
    else if (arg === '--print') out.print = true;
    else if (arg === '--help') out.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

const fmtRate = (hit, total) => (total ? `${hit}/${total} (${((hit / total) * 100).toFixed(1)}%)` : `${hit}/0 (n/a)`);

export function printSummary(report) {
  const a = report.aggregate;
  console.log(`Memory eval ${report.meta.fixture} · ${report.meta.split} · ${report.meta.scenarios} scenarios × ${report.meta.reps} rep(s)`);
  console.log(`fact writes   : correct ${fmtRate(a.writes.correct, a.writes.expected)} · missed ${a.writes.missed} · needs-review ${a.writes.needsReview} · duplicate ${a.writes.duplicate}`);
  console.log(`unsourced new : ${fmtRate(a.writes.unsourcedNew, a.writes.absentChecked)} (lower is better)`);
  console.log(`old fact kept : ${a.writes.intactChecked - a.writes.intactBroken}/${a.writes.intactChecked} (overwritten ${a.writes.intactBroken})`);
  console.log(`tool echoes   : leaked ${fmtRate(a.writes.echoLeaked, a.writes.echoExpected)} · echo rows skipped ${a.writes.echoSkipped}`);
  console.log(`duplicates    : ${a.writes.duplicateGroups} group(s) · redundant new ${a.writes.redundantNew} · inserts ${a.writes.inserted} · merges ${a.writes.merged}`);
  console.log(`retrieval     : Top-1 ${fmtRate(a.retrieval.top1, a.retrieval.answerable)} · Top-5 ${fmtRate(a.retrieval.top5, a.retrieval.answerable)}`
    + ` · Top-1 without anchor ${fmtRate(a.retrieval.top1ExcludingAnchor, a.retrieval.answerable)}`);
  console.log(`unanswerable  : ${a.retrieval.unanswerable} scenario(s), ${a.retrieval.unanswerableCandidateTotal} candidate(s) listed (not scored as answers)`);
  console.log(`forbidden hits: ${a.retrieval.forbiddenViolations} scenario(s)`);
  console.log('cost          : real model calls 0 · embedding calls 0 · tokens not measured · final answer accuracy not measured');
  console.log(`timing        : p50 ${report.timing.p50.toFixed(1)} ms · p95 ${report.timing.p95.toFixed(1)} ms · n=${report.timing.samples}`);
  for (const row of report.results) {
    const w = row.writes
      ? `w ${row.writes.counts.correct}/${row.writes.counts.expected}${row.writes.counts.missed ? ` miss=${row.writes.counts.missed}` : ''}${row.writes.counts.unsourcedNew ? ` unsourced=${row.writes.counts.unsourcedNew}` : ''}${row.writes.counts.echoLeaked ? ` echoLeak=${row.writes.counts.echoLeaked}` : ''}`
      : 'w -';
    const r = row.retrieval
      ? `r ${row.retrieval.kind === 'answerable' ? `${row.retrieval.top1 ? 'T1' : 'x1'}${row.retrieval.top5 ? '/T5' : '/x5'}` : `cand=${row.retrieval.candidates.length}`}${row.retrieval.forbiddenHits.length ? ` forbid=${row.retrieval.forbiddenHits.join(',')}` : ''}`
      : 'r -';
    console.log(`  ${row.id.padEnd(6)} ${row.split.padEnd(8)} ${w} ${r}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/memory-eval.mjs [--out FILE] [--split all|dev|holdout] [--reps N] [--only ID,ID] [--fixture FILE] [--print]');
  } else {
    const report = await runEvaluation({ fixturePath: args.fixturePath, split: args.split, reps: args.reps, only: args.only });
    if (args.out) {
      const target = resolve(args.out);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
      console.log(`wrote ${relative(ROOT, target)}`);
    }
    if (args.print || !args.out) printSummary(report);
    else printSummary(report);
  }
}
