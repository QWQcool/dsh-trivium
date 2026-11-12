/** Real local embedding retrieval and backfill. Opt-in; never part of offline smoke. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  console.log("  --attribution [--source-workspace .tmp/embedding-run/quality] [--query-cache cache.json --offline] --output .tmp/attribution --budget 0");
  process.exit(0);
}
const url = new URL(option("--url", "http://127.0.0.1:11435/v1/embeddings"));
if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw Error("This experiment accepts loopback HTTP only.");
if (option("--budget", "") !== "0") throw Error("Pass --budget 0; this experiment permits no paid calls.");
const model = option("--model", "gte-local");
const output = resolve(option("--output", ".tmp/local-embedding-run"));
const nodes = Number(option("--nodes", "5000"));
if (!Number.isSafeInteger(nodes) || nodes < 0 || nodes > 5000) throw Error("--nodes must be 0..5000");
if (["results.json", "comparison.json", "attribution.json"].some(name => existsSync(join(output, name)))) throw Error("Choose a fresh output directory.");
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
  if (args.includes("--offline")) throw Error("Offline attribution is missing a cached embedding.");
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
