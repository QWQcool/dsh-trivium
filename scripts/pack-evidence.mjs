#!/usr/bin/env node
/**
 * 把 .tmp 里的实验账本整理成可提交的证据包（docs/evidence/）。
 *
 * 只做三件事：瘦身（保留原始 response 与候选）、改名（日期 + 协议 + 场景）、算 sha256。
 * 不改任何数字——答案、usage、判分、注入 token 都原样保留，否则就不是证据了。
 *
 *   node scripts/pack-evidence.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const OUT_DIR = resolve(String(process.argv.find((a) => a.startsWith("--out-dir="))?.split("=")[1] || join(REPO, "docs/evidence")));
const DATE = "2026-10-29";

const SOURCES = [
  { file: ".tmp/c4/online-full.json", name: "c4-arms-6scenario.json", what: "C4：两个对手 + 我方 + 纯文本，7 臂 × 6 场景（修复前）" },
  { file: ".tmp/c4/step1.json", name: "d0-step1-8arms-3reps.json", what: "D0：修完后 8 臂 × 6 场景 × 3 重复" },
  { file: ".tmp/c4/step2-deepseek-chat.json", name: "d0-step2-alias-rerun.json", what: "D0：deepseek-chat 别名重跑（实为 flash，非第二模型）" },
  { file: ".tmp/c4/step2b-v4pro.json", name: "d0-step2b-v4pro.json", what: "D0：真第二模型 deepseek-v4-pro" },
  { file: ".tmp/c4/d1-5b.json", name: "d1-5turn-compaction.json", what: "D1：5 轮压缩会话，4 臂" },
  { file: ".tmp/c4/d1-10b.json", name: "d1-10turn-compaction.json", what: "D1b：10 轮压缩会话，4 臂" },
  { file: ".tmp/c4/extract-online2.json", name: "d2-extract-cost.json", what: "D2：抽取成本（每轮 / 批量 / 规则）" },
  { file: ".tmp/c4/scale-1k-10k.json", name: "scale-1k-10k.json", what: "规模基准：1k / 10k 档" },
  { file: ".tmp/c4/cost-normalized.json", name: "cost-normalized.json", what: "全部账本的峰价/谷价重算" },
];

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function trim(ledger) {
  const clone = structuredClone(ledger);
  // Requests, answers and stored candidates are necessary to audit semantic correctness.
  // Retain provider answers, requests, tool traces and extraction candidates.
  // Missing historical output stays missing; never manufacture it.
  if (Array.isArray(clone.cells)) {
    for (const c of clone.cells) {
      if (typeof c.contextPreview === "string" && c.contextPreview.length > 400) c.contextPreview = c.contextPreview.slice(0, 400);
    }
  }
  return clone;
}

mkdirSync(OUT_DIR, { recursive: true });
const manifest = { date: DATE, priceSource: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/", costBasis: "offpeak", files: [] };

for (const src of SOURCES) {
  const path = join(REPO, src.file);
  if (!existsSync(path)) { manifest.files.push({ name: src.name, missing: src.file }); continue; }
  const raw = readFileSync(path);
  let parsed;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { manifest.files.push({ name: src.name, error: "not-json" }); continue; }
  const body = Buffer.from(JSON.stringify(trim(parsed), null, 2) + "\n", "utf8");
  const outName = `${DATE}-${src.name}`;
  const target = join(OUT_DIR, outName);
  if (existsSync(target) && !readFileSync(target).equals(body)) throw new Error(`Refuse overwrite of historical evidence: ${outName}`);
  writeFileSync(target, body);
  manifest.files.push({
    name: outName,
    from: src.file,
    what: src.what,
    bytes: body.length,
    sha256: sha(body),
    protocol: parsed.protocol || null,
    variant: parsed.variant || null,
    status: parsed.status || null,
    calls: Array.isArray(parsed.calls) ? parsed.calls.length : null,
    model: parsed.model || [...new Set((parsed.calls || []).map((c) => c.model).filter(Boolean))].join(",") || null,
  });
}

writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
const latest = { date: DATE, manifest: "manifest.json", datasets: manifest.files.map((f) => f.name) };
writeFileSync(join(OUT_DIR, "LATEST.json"), JSON.stringify(latest, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ out: OUT_DIR, files: manifest.files.map((f) => ({ name: f.name, calls: f.calls, bytes: f.bytes })) }, null, 2));
