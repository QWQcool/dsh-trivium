/** Real local embedding retrieval and backfill. Opt-in; never part of offline smoke. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import engine from "triviumdb";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { configureEmbedding, normalizeVector } from "../lib/embed.js";
import { openWorkspaceDb, closeAll, backfillEmbeddings, searchNodes, currentHeadOf } from "../lib/store.js";
import { DIM, zeroVector, indexTextFor } from "../lib/schema.js";
import { isStalePayload } from "../lib/until.js";

const args = process.argv.slice(2);
function option(key, fallback) { const at = args.indexOf(key); return at < 0 ? fallback : args[at + 1]; }
if (args.includes("--help")) {
  console.log("node scripts/verify-local-embedding.mjs --url http://127.0.0.1:11435/v1/embeddings --model local --output .tmp/embedding-run --budget 0 [--nodes 5000]");
  console.log("  --compare-workspace .tmp/embedding-run/bulk --writes 128 --output .tmp/write-comparison --budget 0   # cached vectors, no HTTP");
  console.log("  --attribution [--source-workspace .tmp/embedding-run/quality] [--query-cache cache.json --offline] --output .tmp/attribution --budget 0");
  console.log("  --scoped-text [--query-cache cache.json --offline] --output .tmp/scoped-text --budget 0   # isolated native probes + relation-truth evaluation");
  console.log("  --entity-search-acceptance [--query-cache cache.json --offline] --output .tmp/entity-search --budget 0   # production HTTP backend, new frozen questions");
  process.exit(0);
}
const url = new URL(option("--url", "http://127.0.0.1:11435/v1/embeddings"));
if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("This experiment accepts loopback HTTP only.");
if (option("--budget", "") !== "0") throw Error("Pass --budget 0; this experiment permits no paid calls.");
const model = option("--model", "gte-local");
const output = resolve(option("--output", ".tmp/local-embedding-run"));
const nodes = Number(option("--nodes", "5000"));
if (!Number.isSafeInteger(nodes) || nodes < 0 || nodes > 5000) throw Error("--nodes must be 0..5000");
if (["results.json", "comparison.json", "attribution.json", "scoped-text.json", "entity-search.json"].some(name => existsSync(join(output, name)))) throw Error("Choose a fresh output directory.");
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
  if (args.includes("--offline")) throw Error("Offline evaluation is missing a cached embedding.");
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
if (args.includes("--attribution")) {
  try { await attributeRetrieval(); }
  finally { configureEmbedding({ embeddingEnabled: false, embeddingApiKey: "" }); closeAll(); }
  process.exit(0);
}
if (args.includes("--scoped-text")) {
  try { await evaluateScopedText(); }
  finally { configureEmbedding({ embeddingEnabled: false, embeddingApiKey: "" }); closeAll(); }
  process.exit(0);
}
if (args.includes("--entity-search-acceptance")) {
  await acceptEntitySearch();
  process.exit(0);
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

/** Read-only attribution and temporary-fixture counterfactuals. Production ranking is untouched. */
async function attributeRetrieval() {
  const digest = value => createHash("sha256").update(value).digest("hex");
  const corpusHash = digest(corpusBytes);
  const cachePath = option("--query-cache", "");
  if (cachePath) {
    const saved = JSON.parse(readFileSync(resolve(cachePath), "utf8"));
    if (saved.model !== model || saved.corpusSha256 !== corpusHash || saved.queryPrefix !== prefix) throw Error("Embedding cache identity mismatch.");
    for (const [text, vector] of saved.entries) {
      const validated = normalizeVector(vector);
      if (!validated) throw Error("Invalid cached embedding.");
      cache.set(text, validated);
    }
  }
  const sourcePath = option("--source-workspace", "");
  const { TriviumDB } = engine;
  const snapshotFiles = path => Object.fromEntries(readdirSync(path).filter(name => name !== "trivium-write.lock")
    .sort().map(name => [name, digest(readFileSync(join(path, name)))]));
  const sourceDirectory = sourcePath ? join(resolve(sourcePath), ".dsh") : null;
  const diskBefore = sourceDirectory ? snapshotFiles(sourceDirectory) : null;
  const fixturePath = join(output, "fixture.tdb");
  const db = new TriviumDB(sourceDirectory ? join(sourceDirectory, "trivium.tdb") : fixturePath, {
    dim: DIM, accessMode: sourceDirectory ? "readOnly" : "readWrite", loadTextIndex: true, autoBuildQuiver: false,
  });
  const keys = new Map(corpus.documents.map((doc, i) => [i + 2, doc.key]));
  const fixtureTypes = ["entity", "decision", "preference", "experience"];
  const filter = { type: { $in: fixtureTypes }, status: { $ne: "archived" } };
  const challengeBytes = readFileSync(new URL("./fixtures/embedding-attribution-queries.json", import.meta.url));
  const challenge = JSON.parse(challengeBytes);
  const modeNames = ["keyword-graph", "hybrid-raw", "dense", "exact", "native-hybrid", "plugin-hybrid",
    "plugin-pool-all", "plugin-text-off", "plugin-expand-zero", "hybrid-min-zero"];
  const result = {
    baselineCommit: "3c1830f", startedAt: new Date().toISOString(), kernel: "0.9.0", model, dimension: DIM, costYuan: 0,
    corpusSha256: corpusHash, challengeSha256: digest(challengeBytes), queryPrefix: prefix,
    source: sourcePath ? "prior persisted quality fixture, opened readOnly" : "fresh fixture with a public bookkeeping node",
    method: "Same vectors, documents and production code. Intercepted text/pool inputs are diagnostic only; no weight or ranking change is applied to lib/.",
    caveat: "The 32 questions are a reused diagnostic set. Challenge questions were written after seeing the failure, not an independent quality holdout.",
    arms: { baseline: {}, challenge: {} }, misses: [], checks: [],
  };
  const check = (condition, name) => { result.checks.push({ name, passed: Boolean(condition) }); if (!condition) throw Error(name); };
  const full = rows => rows.map(hit => ({ id: hit.id, key: keys.get(hit.id) || "bookkeeping", score: hit.score }));
  const metric = rows => ({ n: rows.length, hit1: rows.filter(r => r.hit1).length, hit5: rows.filter(r => r.hit5).length,
    mrrAt5: rows.reduce((sum, r) => sum + (r.hit5 ? 1 / r.firstRelevantRank : 0), 0) / (rows.length || 1) });
  const proxy = search => new Proxy(db, { get(target, property) {
    if (property === "searchHybrid") return search;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  let businessRows;
  try {
    if (!sourceDirectory) {
      const rootPayload = { type: "workspace", name: "Evaluation workspace", text: "Isolated synthetic evaluation", status: "active" };
      db.insertWithId(1, zeroVector(), rootPayload); db.indexText(1, indexTextFor(rootPayload)); db.indexKeyword(1, rootPayload.name);
      for (let i = 0; i < corpus.documents.length; i++) {
        const { key, ...doc } = corpus.documents[i];
        const payload = { ...doc, status: "active", createdAt: "2026-11-01T00:00:00Z" };
        db.insertWithId(i + 2, await request(indexTextFor(payload), true), payload);
        db.indexText(i + 2, indexTextFor(payload)); db.indexKeyword(i + 2, doc.name);
      }
      db.buildTextIndex(); db.flush();
    }
    businessRows = corpus.documents.map((doc, i) => ({ id: i + 2, key: doc.key, node: db.get(i + 2) }));
    check(db.nodeCount() === corpus.documents.length + 1, "fixture node count matches the original 36 + bookkeeping");
    check(businessRows.every((row, i) => row.node && indexTextFor(row.node.payload) === indexTextFor(corpus.documents[i])
      && normalizeVector(row.node.vector)), "business payloads and valid vectors match the fixed corpus");
    result.documentVectorsSha256 = digest(Buffer.concat(businessRows.map(row => Buffer.from(new Float32Array(row.node.vector).buffer))));
    result.businessEdges = businessRows.reduce((n, row) => n + row.node.edges.filter(edge => ["about", "decided", "broke", "fixed"].includes(edge.label)).length, 0);

    // Export inspection helpers from an otherwise verbatim temporary copy.
    // Never edit lib/store.js, and verify this copy's retrieval against production.
    const storePath = new URL("../lib/store.js", import.meta.url);
    const storeSource = readFileSync(storePath, "utf8");
    result.productionStoreSha256 = digest(storeSource.replaceAll("\r\n", "\n"));
    const auditPath = join(output, "store-audit.mjs");
    writeFileSync(auditPath, storeSource.replace(/(from\s+["'])\.\/([^"']+)(["'])/g,
      (_all, start, path, end) => start + new URL(path, storePath).href + end)
      + "\nexport { queryTerms, primaryScore, rankBoost };\n", "utf8");
    const audit = await import(pathToFileURL(auditPath).href);
    const now = new Date("2026-11-12T00:00:00Z");
    const rowsBySet = [["baseline", corpus.queries], ["challenge", challenge.queries]];
    for (const [setName, questions] of rowsBySet) {
      for (const name of modeNames) result.arms[setName][name] = { rows: [] };
      for (const question of questions) {
        const vector = await request(prefix + question.text, true);
        const rawVector = await request(question.text, true);
        const nativeAll = db.searchHybrid(vector, question.text, 37, 0, .01, .2, filter);
        const dense = db.search(vector, 37, 0, 0, filter);
        const exact = db.searchExact(vector, 37).filter(hit => keys.has(hit.id));
        const stages = [];
        const options = { topK: 5, queryVector: vector, includeStale: false, now };
        const plugin = searchNodes(db, question.text, { ...options, onStage: (stage, ids) => stages.push({ stage, keys: ids.map(id => keys.get(id)) }) });
        const expanded = searchNodes(db, question.text, { ...options, topK: 37 });
        const textOff = proxy((v, _text, ...rest) => db.searchHybrid(v, "", ...rest));
        const poolAll = proxy((v, text, _k, ...rest) => db.searchHybrid(v, text, 37, ...rest));
        const variants = {
          "keyword-graph": searchNodes(db, question.text, { topK: 5, includeStale: false, now }),
          "hybrid-raw": searchNodes(db, question.text, { ...options, queryVector: rawVector }),
          dense, exact, "native-hybrid": nativeAll, "plugin-hybrid": plugin,
          "plugin-pool-all": searchNodes(poolAll, question.text, options),
          "plugin-text-off": searchNodes(textOff, question.text, options),
          "plugin-expand-zero": searchNodes(db, question.text, { ...options, expandDepth: 0 }),
          "hybrid-min-zero": db.searchHybrid(vector, question.text, 37, 0, 0, .2, filter),
        };
        check(JSON.stringify(full(plugin)) === JSON.stringify(full(audit.searchNodes(db, question.text, options))),
          `${setName}: inspection copy equals production: ${question.text}`);
        for (const [name, hits] of Object.entries(variants)) {
          const ranked = full(hits), first = ranked.findIndex(hit => question.relevant.includes(hit.key));
          result.arms[setName][name].rows.push({ ...question, top: ranked.slice(0, 5), hit1: first === 0,
            hit5: first >= 0 && first < 5, firstRelevantRank: first >= 0 ? first + 1 : null });
        }
        const relevantRank = hits => { const at = hits.findIndex(hit => question.relevant.includes(keys.get(hit.id))); return at < 0 ? null : at + 1; };
        if (!relevantRank(plugin)) result.misses.push({ set: setName, question, denseRank: relevantRank(dense),
          nativeFullRank: relevantRank(nativeAll), pluginFullRank: relevantRank(expanded), stages });
        if (question.text === "Can a 768-number vector be accepted by this plugin?") {
          const sparse = db.searchHybrid(zeroVector(), question.text, 37, 0, .01, .2, filter);
          const sparseRanks = new Map(sparse.map((hit, i) => [hit.id, i + 1]));
          const denseNative = db.search(vector, 37, 0, .01, filter);
          const denseRanks = new Map(denseNative.map((hit, i) => [hit.id, i + 1]));
          const weight = Math.fround(Math.fround(1 - Math.fround(.2)) * 3);
          const terms = audit.queryTerms(question.text);
          const tokenList = [...new Set(question.text.toLowerCase().match(/[a-z0-9]+/g))];
          const contribution = (rank, w) => rank ? Math.fround(Math.fround(w * 60) / (60 + rank)) : 0;
          const explained = nativeAll.map((hit, index) => {
            const densePart = contribution(denseRanks.get(hit.id), 1), sparsePart = contribution(sparseRanks.get(hit.id), weight);
            const predicted = Math.fround(densePart + sparsePart), payload = db.getPayload(hit.id);
            const docTerms = new Set(indexTextFor(payload).toLowerCase().match(/[a-z0-9]+/g));
            return { ...full([hit])[0], nativeRank: index + 1, denseRank: denseRanks.get(hit.id) || null,
              sparseRank: sparseRanks.get(hit.id) || null, densePart, sparsePart, predicted, error: Math.abs(hit.score - predicted),
              pluginLexical: audit.primaryScore(payload, question.text, now, terms), pluginRankBoost: audit.rankBoost(db, { id: hit.id, payload, edges: db.getEdges(hit.id) }, question.text, now),
              nativeTokenOverlap: tokenList.filter(token => docTerms.has(token)) };
          });
          check(explained.every(hit => hit.error < 1e-5), "weighted RRF reproduces every native score for the failed question");
          const textInputs = { full: question.text, genericOnly: "can a be by this plugin", contentOnly: "768 number vector accepted", noText: "" };
          const textAblations = Object.fromEntries(Object.entries(textInputs).map(([name, text]) => [name,
            full(db.searchHybrid(vector, text, 37, 0, .01, .2, filter))]));
          const permutations = [];
          for (let repeat = 0; repeat < 5; repeat++) {
            const calls = repeat % 2 ? ["plugin", "dense", "native"] : ["native", "dense", "plugin"];
            const orders = {};
            for (const call of calls) orders[call] = full(call === "native" ? db.searchHybrid(vector, question.text, 37, 0, .01, .2, filter)
              : call === "dense" ? db.search(vector, 37, 0, 0, filter) : searchNodes(db, question.text, options));
            permutations.push(orders);
          }
          check(permutations.every(row => JSON.stringify(row.native) === JSON.stringify(full(nativeAll))
            && JSON.stringify(row.plugin) === JSON.stringify(full(plugin))), "five alternating call orders reproduce identical failed-question ranks");
          const withContext = db.searchWithContext(vector, { topK: 16, expandDepth: 0, minScore: .01,
            enableAdvancedPipeline: false, enableTextHybridSearch: true, textBoost: weight, customQueryText: question.text, payloadFilter: filter });
          result.failureTrace = { question, nativeTokens: tokenList, pluginTerms: terms, nativeTextWeight: weight, rrfK: 60,
            stages, explained, nativeAll: full(nativeAll), denseAll: full(dense), sparseAll: full(sparse),
            pluginAll: full(expanded), textAblations, callOrderRepeats: permutations,
            context: { counts: withContext.context.counts, observations: { vectorRecallCandidates: withContext.context.observations.vector_recall_candidates,
              quiverRoute: withContext.context.observations.vector_route_quiver } } };
        }
      }
      for (const arm of Object.values(result.arms[setName])) Object.assign(arm, metric(arm.rows));
      const arms = result.arms[setName];
      const equalTop = (left, right) => left.top.map(row => row.key).join("\0") === right.top.map(row => row.key).join("\0");
      result.arms[setName].comparisons = {
        n: questions.length,
        denseExactSameTop5: arms.dense.rows.filter((row, i) => equalTop(row, arms.exact.rows[i])).length,
        nativePluginSameTop5: arms["native-hybrid"].rows.filter((row, i) => equalTop(row, arms["plugin-hybrid"].rows[i])).length,
        poolAllSameTop5: arms["plugin-pool-all"].rows.filter((row, i) => equalTop(row, arms["plugin-hybrid"].rows[i])).length,
        graphOffSameTop5: arms["plugin-expand-zero"].rows.filter((row, i) => equalTop(row, arms["plugin-hybrid"].rows[i])).length,
        minZeroSameTop5: arms["hybrid-min-zero"].rows.filter((row, i) => equalTop(row, arms["native-hybrid"].rows[i])).length,
        textOffTop1Regressions: arms["plugin-text-off"].rows.filter((row, i) => !row.hit1 && arms["plugin-hybrid"].rows[i].hit1).map(row => row.text),
        textOffTop1Gains: arms["plugin-text-off"].rows.filter((row, i) => row.hit1 && !arms["plugin-hybrid"].rows[i].hit1).map(row => row.text),
      };
    }
    // Bookkeeping text participates in native corpus statistics even when
    // payload filters exclude its row. Hold business vectors/payloads fixed.
    result.bookkeepingControls = {};
    for (const policy of ["public-root-index", "no-root-index"]) {
      const clone = new TriviumDB(join(output, policy + ".tdb"), { dim: DIM, autoBuildQuiver: false });
      try {
        for (const id of db.allNodeIds()) {
          const node = db.get(id);
          clone.insertWithId(id, node.vector, node.payload);
          if (keys.has(id)) {
            clone.indexText(id, indexTextFor(node.payload));
            clone.indexKeyword(id, node.payload.name);
          } else if (policy === "public-root-index") {
            clone.indexText(id, "workspace Evaluation workspace Isolated synthetic evaluation");
            clone.indexKeyword(id, "Evaluation workspace");
          }
        }
        clone.buildTextIndex(); clone.flush();
        const rows = [];
        for (const question of corpus.queries) {
          const vector = await request(prefix + question.text, true);
          const ranked = full(searchNodes(clone, question.text, { topK: 5, queryVector: vector, includeStale: false, now }));
          const at = ranked.findIndex(hit => question.relevant.includes(hit.key));
          rows.push({ ...question, top: ranked, hit1: at === 0, hit5: at >= 0, firstRelevantRank: at < 0 ? null : at + 1 });
        }
        const question = result.failureTrace.question;
        const vector = await request(prefix + question.text, true);
        const nativeAll = full(clone.searchHybrid(vector, question.text, 37, 0, .01, .2, filter));
        result.bookkeepingControls[policy] = { ...metric(rows), rows,
          failedQuestionNativeRank: nativeAll.findIndex(hit => hit.key === "embeddingdim") + 1 };
      } finally { clone.close(); }
    }
    result.unanswerable = [];
    for (const text of corpus.unanswerable) {
      const vector = await request(prefix + text, true);
      result.unanswerable.push({ text, dense: full(db.search(vector, 5, 0, 0, filter)),
        hybrid: full(searchNodes(db, text, { topK: 5, queryVector: vector, includeStale: false, now })) });
    }
    result.completedAt = new Date().toISOString();
  } finally {
    db.close();
    result.sourceFilesUnchanged = sourceDirectory ? JSON.stringify(diskBefore) === JSON.stringify(snapshotFiles(sourceDirectory)) : null;
    result.http = { calls, tokens, badVectors };
    writeFileSync(join(output, "query-cache.json"), JSON.stringify({ model, corpusSha256: corpusHash, queryPrefix: prefix, entries: [...cache] }), "utf8");
    writeFileSync(join(output, "attribution.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  }
  if (sourceDirectory) check(result.sourceFilesUnchanged, "prior quality fixture files remain byte-identical after read-only evaluation");
  // Include the final source-file check in the saved result as well.
  writeFileSync(join(output, "attribution.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  for (const [setName, variants] of Object.entries(result.arms)) console.log(setName, JSON.stringify(Object.fromEntries(
    Object.entries(variants).filter(([, value]) => value.rows).map(([name, value]) => [name, { n: value.n, hit1: value.hit1, hit5: value.hit5 }]))));
  console.log(`attribution: ${result.checks.length}/${result.checks.length} checks; HTTP ${calls}; cost 0`);
}

/** Native ID-set capability probes followed by experimental payload retrieval.
 * No tool registration, production route or default retrieval is modified.
 */
async function evaluateScopedText() {
  const { TriviumDB, ConsoleSession } = engine;
  if (["native-unique", "native-duplicate", "native-missing", "native-large", "relations"].some(name => existsSync(join(output, name + ".tdb")))) {
    throw Error("Choose a fresh output directory; a prior partial scoped-text fixture exists.");
  }
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const unit = [1, ...Array(DIM - 1).fill(0)];
  const relationBytes = readFileSync(new URL("./fixtures/scoped-text-relations.json", import.meta.url));
  const fixture = JSON.parse(relationBytes);
  const result = { baselineCommit: "b55369b", kernel: "0.9.0", model, dimension: DIM, costYuan: 0,
    corpusSha256: digest(corpusBytes), relationSha256: digest(relationBytes), startedAt: new Date().toISOString(),
    note: "Synthetic development diagnostics. Relation/answer labels are declared, not inferred by a model; no independent real-user holdout claim.",
    native: [], checks: [], queryPrefix: prefix };
  const check = (condition, name) => { result.checks.push({ name, passed: Boolean(condition) }); if (!condition) throw Error(name); };
  const files = prefixName => Object.fromEntries(readdirSync(output).filter(name => name.startsWith(prefixName + ".tdb"))
    .sort().map(name => [name, digest(readFileSync(join(output, name)))]));
  for (const policy of ["unique", "duplicate", "missing"]) {
    const name = "native-" + policy, path = join(output, name + ".tdb");
    let db = new TriviumDB(path, { dim: DIM, autoBuildQuiver: false });
    const docs = [
      { id: 10, payload: { id: 999, fixtureScope: "inside", uri: "urn:unique:inside", text: "needle " + "padding ".repeat(60) } },
      { id: 20, payload: { id: 10, fixtureScope: "outside", uri: policy === "duplicate" ? "urn:unique:inside" : "urn:unique:outside", text: "needle needle needle" } },
      { id: 21, payload: { id: 30, fixtureScope: "outside", uri: "urn:unique:third", text: "needle needle" } },
    ];
    for (const doc of docs) {
      if (policy === "missing") delete doc.payload.uri;
      db.insertWithId(doc.id, unit, doc.payload); db.indexText(doc.id, doc.payload.text);
    }
    db.buildTextIndex(); db.flush(); db.close();
    const before = files(name);
    db = new TriviumDB(path, { dim: DIM, accessMode: "readOnly", autoBuildQuiver: false, loadTextIndex: true });
    const session = new ConsoleSession(JSON.stringify({ readOnly: true, features: ["query"], maxOperations: 1000, queryTimeoutMs: 50, maxResponseBytes: 500000 }));
    try {
      const text = query => {
        try { return { ok: true, ...JSON.parse(db.consoleRequest(session, JSON.stringify({ version: 1, requestId: "scope-probe", command: { operation: "query", query, parameters: {} } }))).data }; }
        catch (error) { return { ok: false, code: error.code, message: error.message }; }
      };
      const hits = filter => db.searchHybrid(zeroVector(), "needle", 1, 0, .01, .2, filter).map(hit => ({ id: hit.id, score: hit.score }));
      const observed = { policy, candidates: [10], global: hits(), payloadId: hits({ id: { $in: [10] } }),
        payloadScope: hits({ fixtureScope: "inside" }), uriWhitelist: hits({ uri: { $in: ["urn:unique:inside"] } }),
        globalVector: db.search(unit, 1, 0, 0).map(hit => hit.id), graphFirstCandidates: [21],
        graphFirst: db.searchGraphFirst(unit, [21], 1, 1000).map(hit => hit.id),
        textThenFilter: text('TEXT BM25 "needle" TOP 1 AS hit WITH hit WHERE hit.id == 10 RETURN hit.id AS id, text_score(hit) AS score'),
        textFullThenFilter: text('TEXT BM25 "needle" TOP 3 AS hit WITH hit WHERE hit.id == 10 RETURN hit.id AS id, text_score(hit) AS score'),
        seedThenText: text('FIND {fixtureScope: "inside"} AS seed WITH seed TEXT BM25 "needle" TOP 1 AS hit WITH hit RETURN hit.id AS id') };
      check(observed.global[0]?.id === 20 && observed.payloadId[0]?.id === 20, `${policy}: payload.id differs from actual NodeId`);
      check(observed.globalVector[0] === 10 && observed.graphFirst[0] === 21, `${policy}: GraphFirst applies the actual ID set to vector ranking only`);
      check(observed.payloadScope[0]?.id === 10, `${policy}: existing payload fields filter before text Top-K`);
      check(observed.textThenFilter.ok && observed.textThenFilter.rows.length === 0
        && observed.textFullThenFilter.rows[0]?.id === 10, `${policy}: TQL postfilter cannot recover a cut candidate`);
      check(!observed.seedThenText.ok && observed.seedThenText.code === "TDB_QUERY_PARSE", `${policy}: documented text source cannot consume an ID-set seed`);
      check(policy === "unique" ? observed.uriWhitelist[0]?.id === 10 : policy === "duplicate" ? observed.uriWhitelist[0]?.id === 20 : observed.uriWhitelist.length === 0,
        `${policy}: URI mapping requires complete unique identifiers`);
      result.native.push(observed);
    } finally { session.detach(); db.close(); }
    check(JSON.stringify(before) === JSON.stringify(files(name)), `${policy}: native probes leave persisted files unchanged`);
  }
  result.nativeConclusion = { arbitraryNodeIdTextWhitelist: false, payloadPrefilterBeforeTopK: true,
    uniqueCompleteUriConditional: true, textStatisticsAndPostingSearchRemainGlobal: true,
    basis: "Installed Node declarations, Console v1 contract and pinned 0.9.0 TQL TextSearchClause/TextSearchSource; runtime counterexamples above." };
  {
    const name = "native-large", path = join(output, name + ".tdb");
    let large = new TriviumDB(path, { dim: DIM, autoBuildQuiver: false, maxQueryRows: 1000, rowOverflow: "throw" });
    large.insertWithId(10, unit, { text: "needle padding", fixtureScope: "inside" });
    large.indexText(10, "needle padding");
    for (let i = 0; i < 1199; i++) { large.insertWithId(3000 + i, zeroVector(), { text: "background", fixtureScope: "outside" }); large.indexText(3000 + i, "background"); }
    large.buildTextIndex(); large.flush(); large.close();
    const before = files(name);
    large = new TriviumDB(path, { dim: DIM, accessMode: "readOnly", autoBuildQuiver: false, loadTextIndex: true, maxQueryRows: 1000, rowOverflow: "throw" });
    const session = new ConsoleSession(JSON.stringify({ readOnly: true, features: ["query"], maxOperations: 1000, queryTimeoutMs: 50, maxResponseBytes: 500000 }));
    try {
      let textResult;
      try { textResult = { ok: true, data: JSON.parse(large.consoleRequest(session, JSON.stringify({ version: 1, requestId: "large-text", command: { operation: "query", query: 'TEXT BM25 "needle" TOP 1 AS hit WITH hit WHERE hit.id == 10 RETURN hit.id AS id', parameters: {} } }))).data }; }
      catch (error) { textResult = { ok: false, code: error.code, message: error.message }; }
      result.largeNativeControl = { nodes: large.nodeCount(), intendedCandidates: [10], textResult,
        consoleMaxOperations: 1000, sourcePipelineDefaultMaxNodes: 100000,
        graphFirst: large.searchGraphFirst(unit, [10], 1, 1000).map(hit => hit.id) };
      check(textResult.ok && textResult.data.rows[0]?.id === 10, "1200-node TEXT succeeds: maxOperations is not the TEXT input-node budget");
      check(result.largeNativeControl.graphFirst[0] === 10, "GraphFirst one-node vector read works in the same 1200-node store");
    } finally { session.detach(); large.close(); }
    check(JSON.stringify(before) === JSON.stringify(files(name)), "large native controls are read-only");
  }

  const cachePath = option("--query-cache", "");
  if (cachePath) {
    const saved = JSON.parse(readFileSync(resolve(cachePath), "utf8"));
    if (saved.model !== model || saved.corpusSha256 !== digest(corpusBytes) || saved.queryPrefix !== prefix) throw Error("Embedding cache identity mismatch.");
    for (const [input, vector] of saved.entries) { const value = normalizeVector(vector); if (!value) throw Error("Invalid cached vector."); cache.set(input, value); }
  }
  const storePath = new URL("../lib/store.js", import.meta.url), source = readFileSync(storePath, "utf8");
  result.productionStoreSha256 = digest(source.replaceAll("\r\n", "\n"));
  const auditPath = join(output, "store-audit.mjs");
  writeFileSync(auditPath, source.replace(/(from\s+["'])\.\/([^"']+)(["'])/g,
    (_all, start, path, end) => start + new URL(path, storePath).href + end) + "\nexport { queryTerms, primaryScore };\n", "utf8");
  const audit = await import(pathToFileURL(auditPath).href);
  const ids = new Map(corpus.documents.map((doc, index) => [doc.key, index + 2]));
  for (const entity of fixture.entities) ids.set(entity.key, entity.id);
  for (const doc of fixture.extraDocuments) ids.set(doc.key, doc.id);
  const keyOf = new Map([...ids].map(([key, id]) => [id, key]));
  const ref = key => { if (!ids.has(key)) throw Error("Unknown fixture reference: " + key); return ids.get(key); };
  const path = join(output, "relations.tdb");
  if (existsSync(path)) throw Error("Choose a fresh output directory; a prior partial relation fixture exists.");
  let db = new TriviumDB(path, { dim: DIM, autoBuildQuiver: false });
  const add = async (id, doc, metadataOnly = false) => {
    const payload = { status: "active", createdAt: "2026-11-01T00:00:00Z", ...doc };
    delete payload.key; delete payload.id;
    db.insertWithId(id, metadataOnly ? zeroVector() : await request(indexTextFor(payload), true), payload);
    db.indexText(id, indexTextFor(payload)); if (payload.name) db.indexKeyword(id, payload.name);
  };
  try {
    for (const doc of corpus.documents) await add(ref(doc.key), doc);
    for (const entity of fixture.entities.filter(row => !row.existing)) await add(entity.id, { type: "entity", name: entity.name }, true);
    for (const doc of fixture.extraDocuments) await add(ref(doc.key), doc);
    for (const [from, to, label] of fixture.edges) db.link(ref(from), ref(to), label, 1);
    for (const key of fixture.allTopicBusinessMembers) db.link(ref(key), ref("@all"), "about", 1);
    db.buildTextIndex(); db.flush();
  } finally { db.close(); }
  const before = files("relations");
  db = new TriviumDB(path, { dim: DIM, accessMode: "readOnly", autoBuildQuiver: false, loadTextIndex: true });
  const now = new Date("2026-11-12T00:00:00Z");
  const sorted = values => [...values].sort();
  const scopes = new Map();
  const scopeOf = (entityKey, cap = 1000) => {
    const entityId = ref(entityKey);
    if (db.getPayload(entityId)?.type !== "entity") throw Error("Not an entity");
    const walk = db.reachableDetailed(entityId, { minDepth: 1, maxDepth: 1, direction: "both", labels: ["about", "decided", "broke", "fixed"], maxVisitedNodes: cap, maxResults: cap, maxEdges: 10000 });
    if (walk.truncated) throw Object.assign(Error("Incomplete scope"), { code: "SCOPE_WORK_LIMIT" });
    const raw = new Set([entityId, ...walk.results.map(row => row.targetId)]);
    const eligible = new Set(), gaps = [];
    for (const id of raw) {
      const payload = db.getPayload(id);
      if (!payload || payload.status === "archived" || isStalePayload(payload, now)) continue;
      const head = currentHeadOf(db, id);
      if (!head.ok) throw Error("Invalid revision chain");
      if (!raw.has(head.id)) { gaps.push({ matched: keyOf.get(id), current: keyOf.get(head.id) }); continue; }
      const current = db.getPayload(head.id);
      if (current && current.status !== "archived" && !isStalePayload(current, now)) eligible.add(head.id);
    }
    return { raw: [...raw], eligible: [...eligible], gaps, paths: walk.results.map(row => ({ key: keyOf.get(row.targetId), path: row.path.map(id => keyOf.get(id)), steps: row.steps.map(step => ({ from: keyOf.get(step.from), to: keyOf.get(step.to), label: step.label })) })) };
  };
  try {
    result.scopes = {};
    for (const entity of fixture.entities) {
      const scoped = scopeOf(entity.key); scopes.set(entity.key, scoped);
      const expectedRaw = entity.key === "@all" ? ["@all", ...fixture.allTopicBusinessMembers] : fixture.expectedRaw[entity.key];
      const expectedEligible = entity.key === "@all" ? expectedRaw : fixture.expectedEligible[entity.key];
      check(JSON.stringify(sorted(scoped.raw.map(id => keyOf.get(id)))) === JSON.stringify(sorted(expectedRaw)), entity.name + ": exact one-hop relation truth");
      check(JSON.stringify(sorted(scoped.eligible.map(id => keyOf.get(id)))) === JSON.stringify(sorted(expectedEligible)), entity.name + ": current/expiry/revision membership truth");
      result.scopes[entity.key] = { raw: scoped.raw.map(id => keyOf.get(id)), eligible: scoped.eligible.map(id => keyOf.get(id)), gaps: scoped.gaps, paths: scoped.paths };
    }
    const labels = new Set([...scopes.values()].flatMap(scope => scope.paths.flatMap(path => path.steps.map(step => step.label))));
    check(["about", "decided", "broke", "fixed"].every(label => labels.has(label)), "relation truth exercises all four business labels");
    result.fixture = { nodes: db.nodeCount(), entities: fixture.entities.length, declaredEdges: fixture.edges.length + fixture.allTopicBusinessMembers.length,
      vectorsSha256: digest(Buffer.concat(db.allNodeIds().sort((a, b) => a - b).map(id => Buffer.from(new Float32Array(db.get(id).vector).buffer)))) };
    check(scopes.get("@release").gaps.some(gap => gap.current === "gap-current"), "a replacement outside the business scope is reported, never smuggled through an old path");
    let bounded = false; try { scopeOf("@memory", 1); } catch (error) { bounded = error.code === "SCOPE_WORK_LIMIT"; }
    check(bounded, "truncated traversal is an explicit failure, not an empty complete scope");
    const tokenize = text => {
      const output = []; let word = "", cjk = [];
      const flushWord = () => { if (word) output.push(word); word = ""; };
      const flushCjk = () => { if (cjk.length === 1) output.push(cjk[0]); else for (let i = 0; i + 1 < cjk.length; i++) output.push(cjk[i] + cjk[i + 1]); cjk = []; };
      for (const char of String(text).toLowerCase()) {
        const n = char.codePointAt(0);
        if (/[a-z0-9]/.test(char)) { flushCjk(); word += char; }
        else if ((n >= 0x3400 && n <= 0x9fff) || (n >= 0x3040 && n <= 0x30ff) || (n >= 0xac00 && n <= 0xd7af)) { flushWord(); cjk.push(char); }
        else { flushWord(); flushCjk(); }
      }
      flushWord(); flushCjk(); return output;
    };
    const rank = scored => scored.sort((a, b) => b.score - a.score || a.id - b.id);
    const payloadLexical = (candidateIds, query) => {
      const terms = audit.queryTerms(query);
      return rank(candidateIds.map(id => ({ id, score: audit.primaryScore(db.getPayload(id), query, now, terms) })).filter(row => row.score > 0));
    };
    const payloadBm25 = (candidateIds, query) => {
      const documents = candidateIds.map(id => { const words = tokenize(indexTextFor(db.getPayload(id))), tf = new Map(); for (const word of words) tf.set(word, (tf.get(word) || 0) + 1); return { id, words, tf }; });
      const avg = documents.reduce((n, row) => n + row.words.length, 0) / (documents.length || 1);
      const terms = [...new Set(tokenize(query))], scores = new Map();
      for (const word of terms) {
        const containing = documents.filter(doc => doc.tf.has(word)), df = containing.length;
        if (!df) continue;
        const idf = Math.log(1 + (documents.length - df + .5) / (df + .5));
        for (const doc of containing) { const tf = doc.tf.get(word), score = idf * tf * 2.2 / (tf + 1.2 * (.25 + .75 * doc.words.length / avg)); scores.set(doc.id, (scores.get(doc.id) || 0) + score); }
      }
      return rank([...scores].map(([id, score]) => ({ id, score })));
    };
    const fuse = (dense, text) => {
      if (!text.length) return dense;
      const scores = new Map();
      for (const [i, hit] of dense.entries()) scores.set(hit.id, 60 / (61 + i));
      for (const [i, hit] of text.entries()) scores.set(hit.id, (scores.get(hit.id) || 0) + 2.4 * 60 / (61 + i));
      return rank([...scores].map(([id, score]) => ({ id, score })));
    };
    const compact = rows => rows.map(hit => ({ key: keyOf.get(hit.id), id: hit.id, score: hit.score }));
    const questions = [...corpus.queries.map((question, i) => ({ ...question, entity: fixture.baselineEntities[i], set: "reused-32" })),
      ...fixture.scopedQuestions.map(question => ({ ...question, set: "relation-diagnostics" }))];
    result.questions = [];
    result.experimentalMethods = { lexical: "production primaryScore, scoped payload scan, descending score then NodeId",
      bm25: "temporary in-memory payload BM25; ASCII words/CJK bigrams; k1=1.2,b=0.75; local scope corpus statistics; no AC or tuned stopwords",
      fusion: "diagnostic only: existing 1:2.4 rank weights, no final-slot rescue; not production ranking" };
    for (const question of questions) {
      const candidateIds = scopes.get(question.entity).eligible;
      check(question.relevant.every(key => candidateIds.includes(ref(key))), "declared relevant facts are eligible in " + question.entity + ": " + question.text);
      const vector = await request(prefix + question.text, true);
      const vectorIds = candidateIds.filter(id => db.get(id).vector.some(n => n !== 0));
      const dense = vectorIds.length ? db.searchGraphFirst(vector, vectorIds, vectorIds.length, 1000).filter(hit => hit.score >= .01) : [];
      let lexical, bm25; const payloadReads = [];
      const originalGet = db.get, originalPayload = db.getPayload;
      try {
        db.get = () => { throw Error("Payload lexical evaluation must not materialize vectors"); };
        db.getPayload = id => { payloadReads.push(id); return originalPayload.call(db, id); };
        lexical = payloadLexical(candidateIds, question.text); bm25 = payloadBm25(candidateIds, question.text);
      } finally { db.get = originalGet; db.getPayload = originalPayload; }
      check(payloadReads.length === candidateIds.length * 2 && payloadReads.every(id => candidateIds.includes(id)),
        "both payload text methods read only the admitted ID set: " + question.text);
      const global = searchNodes(db, question.text, { topK: 5, queryVector: vector, includeStale: false, now });
      const variants = { "global-current": global, "payload-lexical": lexical.slice(0, 5), "payload-bm25": bm25.slice(0, 5),
        "scoped-dense": dense.slice(0, 5), "scoped-lexical-rrf": fuse(dense, lexical).slice(0, 5), "scoped-bm25-rrf": fuse(dense, bm25).slice(0, 5) };
      for (const [name, rows] of Object.entries(variants)) if (name !== "global-current") check(rows.every(hit => candidateIds.includes(hit.id)), name + " stays inside " + question.entity + ": " + question.text);
      const entry = { ...question, scopeSize: candidateIds.length, payloadReads: payloadReads.length, vectorReadsInPayloadScoring: 0,
        variants: Object.fromEntries(Object.entries(variants).map(([name, rows]) => {
        const at = rows.findIndex(hit => question.relevant.includes(keyOf.get(hit.id)));
        return [name, { rows: compact(rows), hit1: at === 0, hit5: at >= 0, outside: rows.filter(hit => !candidateIds.includes(hit.id)).length }];
      })) };
      entry.lexicalStatus = candidateIds.length === 1 && candidateIds[0] === ref(question.entity) && !lexical.length ? "scope_has_anchor_only" : lexical.length ? "lexical_candidates" : "no_lexical_match";
      entry.semanticStatus = dense.length ? "semantic_candidates_answerability_not_assessed" : "no_semantic_candidates";
      if (question.group === "same-entity-generic-noise" || question.group === "outside-top-hit") entry.rankTrace = {
        dense: compact(dense), lexical: compact(lexical), bm25: compact(bm25),
        lexicalRrf: compact(fuse(dense, lexical)), bm25Rrf: compact(fuse(dense, bm25)) };
      result.questions.push(entry);
    }
    result.metrics = {};
    for (const set of ["reused-32", "relation-diagnostics"]) {
      const answerable = result.questions.filter(q => q.set === set && q.relevant.length);
      result.metrics[set] = Object.fromEntries(Object.keys(answerable[0].variants).map(name => [name, { n: answerable.length,
        hit1: answerable.filter(q => q.variants[name].hit1).length, hit5: answerable.filter(q => q.variants[name].hit5).length,
        outsideResults: answerable.reduce((n, q) => n + q.variants[name].outside, 0) }]));
    }
    result.unanswerable = result.questions.filter(q => !q.relevant.length);
    result.completedAt = new Date().toISOString();
  } finally {
    db.close(); result.relationFilesUnchanged = JSON.stringify(before) === JSON.stringify(files("relations"));
    result.http = { calls, tokens, badVectors }; result.costYuan = 0;
    writeFileSync(join(output, "query-cache.json"), JSON.stringify({ model, corpusSha256: digest(corpusBytes), queryPrefix: prefix, entries: [...cache] }), "utf8");
    writeFileSync(join(output, "scoped-text.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  }
  check(result.relationFilesUnchanged, "scope construction and ranking leave relation fixture files byte-identical");
  writeFileSync(join(output, "scoped-text.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(result.metrics));
  console.log(`scoped-text: ${result.checks.length}/${result.checks.length} checks; HTTP ${calls}; cost 0`);
}

/** New questions frozen at 11fbe0c; exercise the actual HTTP route and worker. */
async function acceptEntitySearch() {
  const { default: http } = await import("node:http");
  const { registerMemoryApi } = await import("../lib/server.js");
  const { readUiSettings } = await import("../lib/settings.js");
  const { setTestEmbed } = await import("../lib/embed.js");
  const bytes = Buffer.from(readFileSync(new URL("./fixtures/entity-search-acceptance.json", import.meta.url), "utf8").replaceAll("\r\n", "\n"), "utf8");
  const hash = value => createHash("sha256").update(value).digest("hex");
  const fixture = JSON.parse(bytes);
  const cachePath = option("--query-cache", "");
  if (cachePath) {
    const saved = JSON.parse(readFileSync(resolve(cachePath), "utf8"));
    if (saved.model !== model || saved.corpusSha256 !== hash(bytes) || saved.queryPrefix !== prefix) throw Error("Acceptance cache identity mismatch.");
    for (const [input, vector] of saved.entries) { const valid = normalizeVector(vector); if (!valid) throw Error("Invalid cache."); cache.set(input, valid); }
  }
  const report = { frozenQuestionCommit: "11fbe0c", questionSha256: hash(bytes), model, kernel: "0.9.0", costYuan: 0,
    startedAt: new Date().toISOString(), note: "New synthetic domains and predeclared questions; not a third-party human review. No scoring adjustment or merged-ranking claim.",
    queries: [], checks: [] };
  const check = (condition, name) => { report.checks.push({ name, passed: Boolean(condition) }); if (!condition) throw Error(name); };
  const cwd = join(output, "workspace");
  if (existsSync(join(cwd, ".dsh", "trivium.tdb"))) throw Error("Choose a fresh acceptance directory.");
  let db, server, modelReplays = 0, apiModelRequests = 0, fetchOriginal = globalThis.fetch;
  const record = async (doc, metadata = false) => {
    const payload = { type: "decision", status: "active", createdAt: "2026-11-01T00:00:00Z", ...doc };
    for (const field of ["id", "entity", "entities", "supersededBy"]) delete payload[field];
    db.insertWithId(doc.id, metadata ? zeroVector() : await request(indexTextFor(payload), true), payload);
    db.indexText(doc.id, indexTextFor(payload)); if (payload.name) db.indexKeyword(doc.id, payload.name);
  };
  const dataFiles = directory => Object.fromEntries(readdirSync(directory).filter(name => name !== "read-snapshots" && !name.endsWith(".lock"))
    .sort().map(name => [name, hash(readFileSync(join(directory, name)))]));
  try {
    setTestEmbed(null); configureEmbedding({ embeddingEnabled: false, embeddingApiKey: "" });
    db = await openWorkspaceDb(cwd);
    for (const entity of fixture.entities) await record({ ...entity, type: "entity" }, true);
    for (const fact of [...fixture.facts, ...fixture.special]) {
      await record(fact);
      for (const parent of fact.entities || (fact.entity ? [fact.entity] : [])) db.link(fact.id, parent, "about", 1);
      if (fact.supersededBy) db.link(fact.supersededBy, fact.id, "supersedes", 1);
    }
    db.buildTextIndex(); db.flush();
    writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ workspaces: [cwd], extractEnabled: false, recallMode: "off",
      embeddingEnabled: true, embeddingUrl: url.href, embeddingModel: model, embeddingApiKey: "", embeddingQueryPrefix: prefix }), "utf8");
    globalThis.fetch = async (target, options) => {
      if (String(target) !== url.href) return fetchOriginal(target, options);
      const input = JSON.parse(options.body).input;
      if (args.includes("--offline")) {
        if (!cache.has(input)) throw Error("Offline provider replay cache miss.");
        modelReplays++;
        return new Response(JSON.stringify({ data: [{ embedding: cache.get(input) }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      apiModelRequests++;
      const response = await fetchOriginal(target, options), data = await response.clone().json();
      calls++; tokens += Number(data.usage?.prompt_tokens || 0);
      const vector = normalizeVector(data.data?.[0]?.embedding);
      if (response.ok && vector) cache.set(input, vector); else badVectors++;
      return response;
    };
    let handler;
    registerMemoryApi({ webServer: { register(entry) { handler = entry.handler; return () => {}; } } }, { liveOptions: readUiSettings, status: {} });
    server = http.createServer((req, res) => handler(req, res));
    await new Promise(done => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${server.address().port}/api/dsh-trivium`;
    const post = async (path, body) => {
      const response = await fetch(base + path + "?cwd=" + encodeURIComponent(cwd), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const initialCalls = apiModelRequests + modelReplays;
    const defaultRead = await post("/entity-search", { entityId: 101, query: fixture.questions[0].query });
    check(defaultRead.status === 200 && defaultRead.body.channels.semantic.status === "not_requested"
      && apiModelRequests + modelReplays === initialCalls, "HTTP semantic mode is off unless explicitly requested");
    const captured = await post("/snapshots", {});
    check(captured.status === 200, "real snapshot capture route creates the fixed acceptance source");
    const sourceBefore = dataFiles(join(cwd, ".dsh"));
    const snapBefore = dataFiles(captured.body.directory);
    for (const source of ["live", "snapshot"]) for (const question of fixture.questions) {
      const response = await post("/entity-search", { entityId: question.entityId, query: question.query, semantic: true, limit: 5,
        ...(source === "snapshot" ? { snapshotId: captured.body.snapshotId } : {}) });
      check(response.status === 200, source + " request completed: " + question.query);
      const value = response.body;
      const raw = new Set([question.entityId, ...db.reachableDetailed(question.entityId, { minDepth: 1, maxDepth: 1, direction: "both",
        labels: ["about", "decided", "broke", "fixed"], maxVisitedNodes: 1001, maxResults: 1000, maxEdges: 10000 }).results.map(row => row.targetId)]);
      const returned = [...value.textCandidates, ...value.semanticCandidates];
      check(returned.every(row => raw.has(Number(row.id)) && ![301, 302, 303, 304].includes(Number(row.id))), source + " current in-scope IDs only: " + question.query);
      check(value.answerability === "not_assessed" && value.scope.complete && !value.expanded, source + " truthful scope and answerability: " + question.query);
      if (question.entityId !== 105) check(value.channels.semantic.status === "ran", source + " real semantic channel completed: " + question.query);
      else check(value.state === "scope_anchor_only" && value.channels.semantic.status === "skipped", source + " empty entity skips model lookup");
      if (source === "snapshot") check(value.asOf === captured.body.createdAt && value.snapshotId === captured.body.snapshotId, "pinned capture reference time: " + question.query);
      const textIds = value.textCandidates.map(row => Number(row.id)), semanticIds = value.semanticCandidates.map(row => Number(row.id));
      report.queries.push({ source, ...question, textIds, semanticIds,
        textHit1: question.relevant.includes(textIds[0]), textHit5: textIds.some(id => question.relevant.includes(id)),
        semanticHit1: question.relevant.includes(semanticIds[0]), semanticHit5: semanticIds.some(id => question.relevant.includes(id)),
        eitherChannelHit: [...textIds, ...semanticIds].some(id => question.relevant.includes(id)),
        scope: value.scope, state: value.state, channels: value.channels, answerability: value.answerability,
        candidates: { text: value.textCandidates, semantic: value.semanticCandidates } });
    }
    report.metrics = {};
    for (const source of ["live", "snapshot"]) {
      const rows = report.queries.filter(row => row.source === source && row.relevant.length);
      report.metrics[source] = { n: rows.length, textHit1: rows.filter(row => row.textHit1).length, textHit5: rows.filter(row => row.textHit5).length,
        semanticHit1: rows.filter(row => row.semanticHit1).length, semanticHit5: rows.filter(row => row.semanticHit5).length,
        eitherChannelHit: rows.filter(row => row.eitherChannelHit).length,
        note: "eitherChannelHit counts the union of two separate candidate lists; it is not a merged Top-5 metric." };
    }
    report.noAnswer = report.queries.filter(row => !row.relevant.length);
    check(JSON.stringify(sourceBefore) === JSON.stringify(dataFiles(join(cwd, ".dsh"))), "all HTTP searches preserve live database files");
    check(JSON.stringify(snapBefore) === JSON.stringify(dataFiles(captured.body.directory)), "all snapshot workers preserve artifact bytes");
    const liveRows = report.queries.filter(row => row.source === "live"), snapRows = report.queries.filter(row => row.source === "snapshot");
    check(liveRows.every((row, i) => JSON.stringify([row.textIds, row.semanticIds]) === JSON.stringify([snapRows[i].textIds, snapRows[i].semanticIds])), "live and pinned snapshot candidates match for fixed data");
    report.completedAt = new Date().toISOString();
  } catch (error) { report.failure = String(error.message); process.exitCode = 1; }
  finally {
    globalThis.fetch = fetchOriginal;
    if (server) await new Promise(done => server.close(done));
    setTestEmbed(null); configureEmbedding({ embeddingEnabled: false, embeddingApiKey: "" }); closeAll();
    report.http = { calls, apiModelRequests, modelReplays, tokens, badVectors };
    writeFileSync(join(output, "query-cache.json"), JSON.stringify({ model, corpusSha256: hash(bytes), queryPrefix: prefix, entries: [...cache] }), "utf8");
    writeFileSync(join(output, "entity-search.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  console.log(JSON.stringify(report.metrics || report.failure));
  console.log(`entity-search acceptance: ${report.checks.filter(check => check.passed).length}/${report.checks.length}; model HTTP ${calls}; replays ${modelReplays}; cost 0`);
}
