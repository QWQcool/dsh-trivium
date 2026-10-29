#!/usr/bin/env node
/**
 * 把任意一批账本（bench-c4 / bench-d1 的 JSON）按**谷价**重算成本，并同时给出峰价。
 *
 * 存在的理由：跑的时候可能落在峰价时段，直接相加会让「今天跑的」比「昨天跑的」贵一倍。
 * 本脚本只读 token 用量，不猜时间，因此可以把所有历史数据换算到同一口径。
 *
 *   node scripts/cost-normalize.mjs --out=docs/evidence/cost-normalized.json .tmp/c4/*.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { PRICE_CAPTURED_AT, PRICE_SOURCE, PRICING, priceBoth } from "./pricing.mjs";

import { validUsage } from "./model-ledger.mjs";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const out = resolve(value("out", ".tmp/c4/cost-normalized.json"));
const files = args.filter((a) => !a.startsWith("--")).map((p) => resolve(p));
if (!files.length) {
  console.error("用法: node scripts/cost-normalize.mjs --out=<file> <ledger.json...>");
  process.exit(2);
}

const pickUsage = (row) => row?.usage || row?.receipt?.usage || null;
const modelOf = (ledger, row) => String(row?.model || ledger?.model || "deepseek-flash");

const report = {
  priceSource: PRICE_SOURCE,
  capturedAt: PRICE_CAPTURED_AT,
  costBasis: "offpeak (peak/2). Peak is reported alongside; never mix the two in one table.",
  note: "Computed from stored token usage only — no guessing of the wall-clock window each call ran in.",
  sets: [],
};

for (const file of files) {
  let ledger;
  try { ledger = JSON.parse(readFileSync(file, "utf8")); } catch (err) {
    report.sets.push({ file: basename(file), error: String(err.message) });
    continue;
  }
  // bench-c4: cells[] 带 arm；bench-d1: cells[] 带 arm，sessionsOut[] 带汇总
  if (!Array.isArray(ledger.calls)) { report.sets.push({file:basename(file),error:"Missing request ledger; cannot infer requests from cells"}); continue; }
  const rows = ledger.calls;
  const byArm = {};
  const models = new Set();
  let calls = 0;
  for (const row of rows) {
    const usage = pickUsage(row);
    if (!validUsage(usage) || !PRICING[modelOf(ledger,row)]) continue;
    const model = modelOf(ledger, row);
    models.add(model);
    const both = priceBoth(usage, model);
    const arm = row.arm || (row.label ? String(row.label).split("/")[0] : "unknown");
    byArm[arm] ??= { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cnyPeak: 0, cnyOffpeak: 0 };
    const a = byArm[arm];
    a.calls += 1;
    a.promptTokens += Number(usage.prompt_tokens);
    a.cachedTokens += Number(usage.prompt_cache_hit_tokens || 0);
    a.completionTokens += Number(usage.completion_tokens || 0);
    a.cnyPeak += both.peak;
    a.cnyOffpeak += both.offpeak;
    calls += 1;
  }
  const total = Object.values(byArm).reduce((acc, a) => ({
    calls: acc.calls + a.calls,
    promptTokens: acc.promptTokens + a.promptTokens,
    completionTokens: acc.completionTokens + a.completionTokens,
    cnyPeak: acc.cnyPeak + a.cnyPeak,
    cnyOffpeak: acc.cnyOffpeak + a.cnyOffpeak,
  }), { calls: 0, promptTokens: 0, completionTokens: 0, cnyPeak: 0, cnyOffpeak: 0 });
  report.sets.push({
    file: basename(file),
    protocol: ledger.protocol || null,
    variant: ledger.variant || null,
    status: ledger.status || null,
    models: [...models],
    calls: rows.length,
    pricedCalls: calls,
    cells: Array.isArray(ledger.cells) ? ledger.cells.length : null,
    unresolved: rows.filter(r => r.state === "stopped" || r.state === "reserved" || !validUsage(pickUsage(r)) || !PRICING[modelOf(ledger,r)]).length,
    byArm,
    total,
  });
}

const grand = report.sets.reduce((acc, s) => (s.total ? {
  calls: acc.calls + s.calls,
  cnyPeak: acc.cnyPeak + s.total.cnyPeak,
  cnyOffpeak: acc.cnyOffpeak + s.total.cnyOffpeak,
} : acc), { calls: 0, cnyPeak: 0, cnyOffpeak: 0 });
report.grandTotal = grand;
report.complete = report.sets.every(s => !s.error && s.unresolved === 0);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ out, sets: report.sets.map((s) => ({ file: s.file, calls: s.calls, cnyOffpeak: s.total ? Number(s.total.cnyOffpeak.toFixed(6)) : null })), grand }, null, 2));
