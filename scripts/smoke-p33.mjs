/**
 * Scoring rubrics: the offline quality fixtures (p33) and the extraction rubric
 * (p40, merged here 2026-11-11 to stay under the scripts/ cap).
 *
 * Both answer the same question — "does this answer count as correct?" — so they
 * share a file. Nothing was dropped: each block keeps its own assertions.
 */
import assert from "node:assert/strict";
import { grade, scenarios } from "./quality-fixtures.mjs";
import { scoreExtraction } from "./extraction-rubric.mjs";

/* ---- quality fixtures: gold, negation, generic, missing/extra fields ---- */
const cases = scenarios();
for (const sc of cases) assert.equal(grade(JSON.stringify(sc.gold), sc.gold).pass, true, sc.id);
const s02 = cases.find((sc) => sc.id === "S02"), s07 = cases.find((sc) => sc.id === "S07"), s10 = cases.find((sc) => sc.id === "S10");
for (const answer of ['教程与实际演示并非都可以，仍然只推教程', JSON.stringify({ ...s02.gold, old_allowed: true }), JSON.stringify({ ...s02.gold, contradiction: "旧标签仍生效" })]) assert.equal(grade(answer, s02.gold).pass, false);
for (const answer of ['建议先跑基线', '{"codes":["基线"]}', JSON.stringify({ codes: s07.gold.codes.slice(0,5) }), JSON.stringify({ codes: [...s07.gold.codes, s07.gold.codes[0]] })]) assert.equal(grade(answer, s07.gold).pass, false);
assert.equal(grade('{"reason":"增量失效"}', s10.gold).pass, false);
assert.equal(grade(JSON.stringify({ codes: s07.gold.codes.toReversed() }), s07.gold).pass, true);
assert.equal(grade('null', { owner: null }).pass, false);
assert.equal(grade('{"owner":"不知道"}', { owner: null }).pass, false);
assert.equal(grade('{"owner":null}', { owner: null }).pass, true);
console.log("P33 rubric passed: all gold, negation, generic answer, missing/extra/duplicate fields, unknown and order-independent set");

/* ---- extraction rubric: body-only, subject/value/polarity/time ---- */
const facts = ['重试次数上限为 3 次。', '生产端口是 9443。'];
const row = (text) => ({ type: 'decision', text });
assert.equal(scoreExtraction(facts.map(row), facts).pass, true);
assert.equal(scoreExtraction([row(facts.join(''))], facts).pass, true);
for (const c of [row('重试次数上限为 30 次。'), row('重试次数上限不是 3 次。'), row('测试端口是 9443。'), row('生产端口曾是 9443，现在是 8443。'), { ...row('未知'), quote: facts.join(''), name: '3 / 9443' }]) {
  assert.equal(scoreExtraction([c], facts).pass, false);
}
assert.equal(scoreExtraction([row('重试最多三次。')], [facts[0]]).needsSemanticReview, true);
assert.equal(scoreExtraction([row(facts[0]), row(facts[0])], [facts[0]]).duplicates.length, 1);
assert.equal(scoreExtraction([row(facts[0])], facts).missing.length, 1);
assert.equal(scoreExtraction([row(facts.join('')), row('额外臆测')], facts).pass, false);
console.log('P40 extraction rubric passed: body-only, whole facts, subject/value/polarity/time, missing, duplicate, extra and manual-review cases');
