#!/usr/bin/env node
/**
 * C 批负载基线（C2）。只回答工程问题：给定节点规模，能不能导入、能不能重开、检索多快、吃多少磁盘和内存。
 *
 * 不调用模型、不请求 embedding、不写用户 .dsh。每个档位一个临时合成库，跑完即删。
 * 每个数字都标了测量层级：
 *   open/plan/import/reopen/search = 本进程内实测耗时（不是模型延迟，也不是端到端回答延迟）
 *   rss = process.memoryUsage().rss（不是系统总占用）
 *   tdbMb = 库文件字节数（不是索引内存）
 *
 * 用法：
 *   node scripts/bench-scale.mjs                                  # 默认 1000,10000,50000 各 1 次
 *   node scripts/bench-scale.mjs --tiers=1000,10000 --repeats=3
 *   node scripts/bench-scale.mjs --tiers=10000 --out=.tmp/c-2/scale-10k.json
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const store = await import("../lib/store.js");
const { searchNodes } = store;

const args = new Map(
  process.argv.slice(2).map((raw) => {
    const [k, v = "true"] = raw.replace(/^--/, "").split("=");
    return [k, v];
  }),
);
const tiers = String(args.get("tiers") || "1000,10000,50000").split(",").map(Number).filter((n) => n > 0);
const repeats = Math.max(1, Number(args.get("repeats") || 1));
const seed = Number(args.get("seed") || 20261028);
const outPath = args.get("out") || "";

/** 固定种子的 LCG：同一 (tier, seed) 必须生成同一份图，否则结果不可复现。 */
function lcg(s) {
  let state = s >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const TOPICS = ["retrieval", "budget", "revision", "import", "workspace", "embedding", "sidecar", "etag"];

/**
 * 合成图。正文写进 `payload.text` —— 这是规范正文键（ctx_remember 写 args.text，
 * indexTextFor 只读 text）。用 `body` 会造出一个全部零命中的假库。
 */
function buildGraph(n, root, rand) {
  const nodes = [];
  const edges = [];
  for (let i = 1; i <= n; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const stamp = new Date(1700000000000 + i * 1000).toISOString();
    nodes.push({
      id: i,
      payload: {
        uri: `bench://scale/${i}`,
        type: i % 7 === 0 ? "decision" : "entity",
        name: `${topic} note ${i}`,
        aliases: [`alias-${topic}-${i}`],
        text: `synthetic body ${i} about ${topic} plan ${i % 97} with marker m${i}`,
        status: "active",
        createdAt: stamp,
        updatedAt: stamp,
      },
    });
    // 约 1.2 条业务边/节点，避免退化成无边森林
    if (i > 3) {
      edges.push({ from: i, to: i - 1, label: "about", weight: 1 });
      if (rand() < 0.2) edges.push({ from: i, to: i - 3, label: "decided", weight: 1 });
    }
  }
  return { format: "dsh-trivium-graph", version: 2, cwd: root, nodes, edges };
}

/**
 * 查询集固定，不随档位变。每个正例都指向一个唯一可判定的目标（URI / 全文独有片段 / 唯一别名），
 * 负例要求零命中。判据故意保持"严格 URI 包含"，避免用模糊短语自我评分。
 */
function querySet(n) {
  const at = (i) => (i <= n ? i : Math.max(1, n - (i % n)));
  const uri = (i) => `bench://scale/${at(i)}`;
  // 名称里的主题必须和 buildGraph 用同一个函数算，否则会自造"召回失败"的假象。
  const nameOf = (i) => `${TOPICS[at(i) % TOPICS.length]} note ${at(i)}`;
  const positive = (q, i) => ({ q, expect: uri(i) });
  const rows = [
    positive(`bench://scale/${at(17)}`, 17),
    positive(`marker m${at(42)}`, 42),
    positive(`synthetic body ${at(4)}`, 4),
    positive(nameOf(4), 4),
    positive(nameOf(21), 21),
    positive(nameOf(8), 8),
    positive(nameOf(6), 6),
    positive(nameOf(15), 15),
    positive(nameOf(2), 2),
    positive(`alias-${TOPICS[at(3) % TOPICS.length]}-${at(3)}`, 3),
    positive(`m${at(998)}`, 998),
    positive(nameOf(777), 777),
    positive(nameOf(31), 31),
    positive(`synthetic body ${at(44)}`, 44),
    positive(`marker m${at(13)}`, 13),
    positive(`marker m${at(996)}`, 996),
  ];
  const negative = (q) => ({ q, expect: null });
  return [
    ...rows,
    negative("zzz 完全不存在的查询词"),
    negative("维护者 不存在的词"),
    negative("quantumbridge"),
  ];
}

const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);
const dirMb = (dir) => {
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else total += st.size;
  };
  walk(dir);
  return Math.round((total / 1024 / 1024) * 10) / 10;
};
const quantile = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return 0;
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
};

async function runTier(tier, repeat) {
  const root = mkdtempSync(join(tmpdir(), `bench-tier${tier}-r${repeat}-`));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const rand = lcg(seed + tier * 7919 + repeat);
  const row = { tier, repeat, seed: seed + tier * 7919 + repeat };

  let t = performance.now();
  let db = await store.openWorkspaceDb(root);
  row.openMs = Math.round(performance.now() - t);
  row.emptyRssMb = rss();

  const graph = buildGraph(tier, root, rand);
  t = performance.now();
  const plan = store.planImportGraph(db, graph);
  row.planMs = Math.round(performance.now() - t);
  row.planOk = plan.ok === true;
  if (!row.planOk) {
    row.planMessage = plan.message || plan.code || "unknown";
    store.closeAll();
    return row;
  }

  t = performance.now();
  const imported = store.importGraph(db, graph);
  row.importMs = Math.round(performance.now() - t);
  row.importOk = imported.ok !== false;
  row.importCreated = imported.created ?? imported.preview?.created ?? null;
  row.importRssMb = rss();
  row.tdbMb = dirMb(join(root, ".dsh"));

  // 冷启动：关库重开，含 BM25 索引全量重建（openWorkspaceDb 里的 rebuildTextIndex）
  t = performance.now();
  store.closeAll();
  db = await store.openWorkspaceDb(root);
  row.reopenMs = Math.round(performance.now() - t);
  row.reopenRssMb = rss();
  row.reopenNodeCount = store.nodeCountOf(db);

  // 冷路径：重开后第一条查询（索引刚重建完，不含重建成本）
  const first = querySet(tier)[1];
  t = performance.now();
  const firstHits = searchNodes(db, first.q, { topK: 8 });
  row.firstQueryMs = Math.round(performance.now() - t);
  row.firstQueryHits = firstHits.length;

  // 热路径：同一进程内 20 条固定查询
  const latencies = [];
  const recall = [];
  for (const item of querySet(tier)) {
    t = performance.now();
    const hits = searchNodes(db, item.q, { topK: 8 });
    latencies.push(performance.now() - t);
    const uris = hits.map((h) => String(h.payload?.uri || ""));
    recall.push({
      q: item.q,
      expect: item.expect,
      hits: hits.length,
      topUris: uris.slice(0, 3),
      // 正例：期望 URI 进 top8 即算命中；负例：零命中才算正确
      ok: item.expect ? uris.includes(item.expect) : hits.length === 0,
    });
  }
  row.searchP50Ms = quantile(latencies, 50);
  row.searchP95Ms = quantile(latencies, 95);
  row.searchMaxMs = quantile(latencies, 100);
  row.searchMs = latencies.map((ms) => Math.round(ms));
  row.positiveTotal = recall.filter((r) => r.expect).length;
  row.positiveHit = recall.filter((r) => r.expect && r.ok).length;
  row.negativeTotal = recall.filter((r) => !r.expect).length;
  row.negativeCorrect = recall.filter((r) => !r.expect && r.ok).length;
  row.failedQueries = recall.filter((r) => !r.ok);

  // 冷重开一半后再测一次：验证「重开成本」是否随查询数摊薄
  t = performance.now();
  store.closeAll();
  db = await store.openWorkspaceDb(root);
  row.reopenAgainMs = Math.round(performance.now() - t);
  row.peakRssMb = rss();

  store.closeAll();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 句柄可能未释放 */ }
  return row;
}

const rows = [];
/*
 * RSS 必须每档一个独立进程：closeAll() 不会把内存全部归还，同进程连续跑多个档位
 * 会让后面的档位读到前一个档位的残留（实测 1k 三轮 86→145→193 MB）。
 * 因此默认 isolate：父进程只负责派活和汇总，指标在子进程里量。
 */
if (!args.has("row")) {
  const { spawnSync } = await import("node:child_process");
  for (const tier of tiers) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      process.stderr.write(`[bench] tier=${tier} repeat=${repeat + 1}/${repeats} (isolated) …\n`);
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), `--row=${tier},${repeat}`, `--seed=${seed}`],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      if (child.status !== 0) {
        rows.push({ tier, repeat, error: String(child.stderr || "").slice(-800) });
        continue;
      }
      try {
        rows.push(JSON.parse(child.stdout));
      } catch (err) {
        rows.push({ tier, repeat, error: `unparsable child output: ${err.message}` });
      }
    }
  }
} else {
  const [tier, repeat] = String(args.get("row")).split(",").map(Number);
  const row = await runTier(tier, repeat);
  process.stdout.write(JSON.stringify(row));
  process.exit(0);
}

const report = {
  generatedAt: new Date().toISOString(),
  pluginVersion: JSON.parse(readFileSyncSafe(resolve("package.json")))?.version || null,
  kernelVersion: JSON.parse(readFileSyncSafe(resolve("package.json")))?.dependencies?.triviumdb || null,
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  seed,
  repeats,
  measurement: {
    timing: "in-process wall clock, single run, not model latency and not end-to-end answer latency",
    rss: "process.memoryUsage().rss, not system-wide",
    recall: "top-8 URI containment; negative queries must return zero hits",
    semantic: "off (no query vector, no embedding request)",
  },
  rows,
};

function readFileSyncSafe(p) {
  try { return readFileSync(p, "utf8"); } catch { return "{}"; }
}

console.log(JSON.stringify(report, null, 2));
if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stderr.write(`[bench] wrote ${outPath}\n`);
}
