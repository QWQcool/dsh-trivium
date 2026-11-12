/** Real local embedding retrieval and backfill. Opt-in; never part of offline smoke. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import engine from "triviumdb";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { configureEmbedding, normalizeVector } from "../lib/embed.js";
import { openWorkspaceDb, closeAll, backfillEmbeddings, searchNodes } from "../lib/store.js";
import { DIM, zeroVector, indexTextFor } from "../lib/schema.js";

const args = process.argv.slice(2);
function option(key, fallback) { const at = args.indexOf(key); return at < 0 ? fallback : args[at + 1]; }
if (args.includes("--help")) {
  console.log("node scripts/verify-local-embedding.mjs --url http://127.0.0.1:11435/v1/embeddings --model local --output .tmp/embedding-run --budget 0 [--nodes 5000]");
  console.log("  --compare-workspace .tmp/embedding-run/bulk --writes 128 --output .tmp/write-comparison --budget 0   # cached vectors, no HTTP");
  process.exit(0);
}
const url = new URL(option("--url", "http://127.0.0.1:11435/v1/embeddings"));
if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("This experiment accepts loopback HTTP only.");
if (option("--budget", "") !== "0") throw Error("Pass --budget 0; this experiment permits no paid calls.");
const model = option("--model", "gte-local");
const output = resolve(option("--output", ".tmp/local-embedding-run"));
const nodes = Number(option("--nodes", "5000"));
if (!Number.isSafeInteger(nodes) || nodes < 0 || nodes > 5000) throw Error("--nodes must be 0..5000");
if (existsSync(join(output, "results.json")) || existsSync(join(output, "comparison.json"))) throw Error("Choose a fresh output directory.");
mkdirSync(output, { recursive: true });
process.on("exit", code => writeFileSync(join(output,"exit.json"),JSON.stringify({code,at:new Date().toISOString()}),"utf8"));
process.env.DSH_HOME = join(output, "home");
process.env.DSH_TRIVIUM_SETTINGS = join(output, "settings.json");
const prefix = "Instruct: Given a question about project memory, retrieve relevant facts that answer the question\nQuery: ";
const corpusPath = new URL("./fixtures/local-embedding-corpus.json", import.meta.url);
const corpusBytes = readFileSync(corpusPath);
const corpus = JSON.parse(corpusBytes);
const latencies = [], cache = new Map();
let calls = 0, tokens = 0, badVectors = 0;
const times = (values) => { const v = values.slice().sort((a,b) => a-b); return { count: v.length, p50Ms: v[Math.ceil(v.length * .5)-1] || 0, p95Ms: v[Math.ceil(v.length * .95)-1] || 0 }; };
if (option("--compare-workspace", "")) {
  const { TriviumDB } = engine;
  const size = Number(option("--writes", "128"));
  if (!Number.isSafeInteger(size) || size < 1 || size > 5000) throw Error("--writes must be 1..5000");
  const source = new TriviumDB(join(resolve(option("--compare-workspace")), ".dsh", "trivium.tdb"), { dim: DIM, accessMode: "readOnly" });
  let rows;
  try { rows = source.allNodeIds().map(id => ({ id, ...source.get(id) })); } finally { source.close(); }
  const selected = rows.filter(r => r.payload.type !== "workspace").slice(0, size);
  if (selected.length !== size) throw Error("The source has too few business nodes.");
  const handles = {}, samples = { "per-vector": [], "batch-16": [] };
  const comparison = { kernel: "0.9.0", nodes: rows.length - rows.filter(r => r.payload.type === "workspace").length,
    vectorsPerRound: size, rounds: 3, networkCalls: 0, costYuan: 0,
    note: "Cached real vectors in identical isolated stores; measures read/update/flush cost, not full backfill." };
  try {
    for (const mode of Object.keys(samples)) {
      const path = join(output, mode + ".tdb");
      if (existsSync(path)) throw Error("Choose a fresh output directory.");
      const db = handles[mode] = new TriviumDB(path, { dim: DIM });
      for (const row of rows) db.insertWithId(row.id, row.vector, row.payload);
      db.flush();
    }
    for (let round = 0; round < 3; round++) for (const mode of round % 2 ? ["batch-16", "per-vector"] : ["per-vector", "batch-16"]) {
      const db = handles[mode], group = mode === "per-vector" ? 1 : 16, flushTimes = [], started = performance.now();
      for (let i = 0; i < selected.length; i += group) {
        for (const row of selected.slice(i, i + group)) {
          if (mode === "per-vector") db.get(row.id); else db.getPayload(row.id);
          db.updateVector(row.id, row.vector);
        }
        const at = performance.now(); db.flush(); flushTimes.push(performance.now() - at);
      }
      const record = { round, elapsedMs: performance.now() - started, flushes: flushTimes.length, flush: times(flushTimes) };
      samples[mode].push(record); console.log(mode, JSON.stringify(record));
    }
    for (const mode of Object.keys(samples)) comparison[mode] = { elapsed: times(samples[mode].map(r => r.elapsedMs)), samples: samples[mode] };
  } finally {
    for (const db of Object.values(handles)) db.close();
    writeFileSync(join(output, "comparison.json"), JSON.stringify(comparison, null, 2) + "\n", "utf8");
  }
  process.exit(0);
}
async function request(input, cached = false) {
  if (cached && cache.has(input)) return cache.get(input);
  const started = performance.now();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input }), signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  calls++; tokens += Number(data.usage?.prompt_tokens || 0); latencies.push(performance.now()-started);
  const vector = normalizeVector(data.data?.[0]?.embedding);
  if (!response.ok || !vector) { badVectors++; throw Error("Embedding endpoint failed the finite 1536-D nonzero contract"); }
  if (cached) cache.set(input, vector);
  return vector;
}
const report = { startedAt: new Date().toISOString(), costYuan: 0, kernel: "0.9.0", model,
  endpoint: `loopback:${url.port || 80}`, dimension: DIM, queryPrefix: prefix,
  corpusSha256: createHash("sha256").update(corpusBytes).digest("hex"), documents: corpus.documents.length,
  questions: corpus.queries.length, caveat: "Hand-labelled synthetic retrieval corpus; no production accuracy claim or identity threshold calibration." };
const write = () => writeFileSync(join(output, "results.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
try {
  const db = await openWorkspaceDb(join(output, "quality"));
  const keys = new Map();
  for (let i=0;i<corpus.documents.length;i++) {
    const item = corpus.documents[i], id=i+2;
    keys.set(id,item.key);
    const payload = { ...item, status:"active", createdAt:"2026-11-01T00:00:00Z" }; delete payload.key;
    db.insertWithId(id, await request(indexTextFor(payload), true), payload);
    db.indexText(id,indexTextFor(payload));
    if (payload.name) db.indexKeyword(id,payload.name);
  }
  db.buildTextIndex(); db.flush();
  const variants = ["keyword-graph", "hybrid-raw", "hybrid-instructed", "dense-instructed"];
  report.retrieval = {};
  for (const variant of variants) {
    const rows=[];
    for (const q of corpus.queries) {
      const vector = variant === "keyword-graph" ? undefined : await request((variant.endsWith("raw") ? "" : prefix) + q.text, true);
      const hits = variant === "dense-instructed" ? db.search(vector,5,0,0) : searchNodes(db,q.text,{ topK:5,queryVector:vector,includeStale:false });
      const found=hits.map(h => keys.get(h.id)).filter(Boolean);
      rows.push({ ...q, top: found, hit1:q.relevant.includes(found[0]), hit5:found.slice(0,5).some(k=>q.relevant.includes(k)) });
    }
    const metrics = (items) => ({ n:items.length, hit1:items.filter(r=>r.hit1).length, hit5:items.filter(r=>r.hit5).length });
    report.retrieval[variant] = { ...metrics(rows), byGroup:Object.fromEntries([...new Set(rows.map(r=>r.group))].map(g=>[g,metrics(rows.filter(r=>r.group===g))])), rows };
    console.log(variant, JSON.stringify(metrics(rows)));
  }
  report.unanswerable=[];
  for (const text of corpus.unanswerable) {
    const queryVector=await request(prefix+text,true);
    report.unanswerable.push({text, nearest:db.search(queryVector,3,0,0).map(h=>({key:keys.get(h.id),score:h.score}))});
  }
  const identity=JSON.parse(readFileSync(new URL("./fixtures/identity-corpus.json",import.meta.url),"utf8"));
  report.identityPairs=[];
  for (const pair of identity.pairs) {
    const a=await request(indexTextFor(pair.a),true), b=await request(indexTextFor(pair.b),true);
    const dot=a.reduce((s,v,i)=>s+v*b[i],0), norm=v=>Math.sqrt(v.reduce((s,x)=>s+x*x,0));
    report.identityPairs.push({ label:pair.label,why:pair.why,cosine:dot/(norm(a)*norm(b)) });
  }
  report.identityNote="Cosine diagnostics only. No semantic merge enabled; labels were not used to choose a threshold.";
  write();
  if (nodes) {
    configureEmbedding({embeddingEnabled:false});
    const bulk = await openWorkspaceDb(join(output,"bulk"));
    for (let i=0;i<nodes;i++) {
      const item=corpus.documents[i%corpus.documents.length];
      const payload={type:item.type,name:item.name+" "+i,text:item.text+" Fixture record "+i+".",status:"active",createdAt:"2026-11-01T00:00:00Z"};
      bulk.insertWithId(i+2,zeroVector(),payload);
    }
    bulk.flush();
    let flushes=0, vectorWrites=0;
    const flush=bulk.flush.bind(bulk), update=bulk.updateVector.bind(bulk);
    const flushMs=[];
    bulk.flush=(...a)=>{flushes++;const at=performance.now();try{return flush(...a)}finally{
      flushMs.push(performance.now()-at);
      writeFileSync(join(output,"progress.json"),JSON.stringify({calls,flushes,vectorWrites,at:new Date().toISOString()}),"utf8");
    }};
    bulk.updateVector=(...a)=>{vectorWrites++;return update(...a)};
    // Observe real HTTP calls while exercising the production backfill path.
    const nativeFetch=globalThis.fetch;
    globalThis.fetch=async(...a)=>{
      const start=performance.now(); const response=await nativeFetch(...a);
      latencies.push(performance.now()-start);calls++;
      const data=await response.clone().json();tokens+=Number(data.usage?.prompt_tokens||0);
      if(!response.ok||!normalizeVector(data.data?.[0]?.embedding))badVectors++;
      if(calls%500===0) console.log("progress",JSON.stringify({calls,vectorWrites,flushes}));
      return response;
    };
    configureEmbedding({embeddingEnabled:true,embeddingUrl:url.href,embeddingModel:model,embeddingApiKey:"",embeddingQueryPrefix:prefix});
    const started=performance.now();
    let backfill;
    try { backfill=await backfillEmbeddings(bulk); } finally {globalThis.fetch=nativeFetch;}
    const elapsedMs=performance.now()-started;
    const persisted=bulk.get(2).vector;
    report.backfill={requested:nodes,...backfill,elapsedMs,nodesPerSecond:nodes/(elapsedMs/1000),flushes,vectorWrites,
      flushTimings:times(flushMs),
      firstVectorDimension:persisted.length,firstVectorNorm:Math.sqrt(persisted.reduce((s,x)=>s+x*x,0)),
      note:"5000 synthetic facts for write cost; retrieval quality is measured separately."};
    console.log("backfill",JSON.stringify(report.backfill));
  }
  report.completedAt=new Date().toISOString();
} catch(error) { report.failure=String(error.message); process.exitCode=1; }
finally { report.http={calls,tokens,badVectors,...times(latencies)}; write(); configureEmbedding({embeddingEnabled:false});closeAll(); }
