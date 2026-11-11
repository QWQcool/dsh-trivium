#!/usr/bin/env node
/**
 * Explicit HTTP load experiment; deliberately not discovered by npm test.
 *
 * node scripts/bench-live-tql.mjs [--sizes 585,5000] [--reps 3]
 *      [--query-timeout-ms 50] [--hard-timeout-ms 90000]
 *
 * A watchdog process owns separate host and HTTP-client processes. The host
 * registers the real plugin API, owns one temporary writer, and instruments
 * its Console calls. No model, external service, or real workspace is used.
 * stdout is one JSON report; progress/diagnostics go to stderr.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const role = process.argv.find((arg) => arg.startsWith("--bench-role="))?.split("=")[1];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const round = (value) => Math.round(value * 1000) / 1000;

function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  const percentile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return { count: sorted.length, minMs: round(sorted[0]), p50Ms: round(percentile(0.5)), p95Ms: round(percentile(0.95)), maxMs: round(sorted.at(-1)) };
}

function outcome(sample) {
  if (sample.status >= 200 && sample.status < 300 && sample.body?.ok === true) return "success";
  if (/TIMEOUT|CANCELLED|DEADLINE/.test(sample.body?.code || "")) return "deadline";
  if (/BUDGET|LIMIT|TOO_LARGE|QueueFull/.test(sample.body?.code || "")) return "budget";
  if (sample.status === 429) return "busy";
  return "error";
}

async function host(config) {
  process.env.DSH_TRIVIUM_SETTINGS = join(config.directory, "settings.json");
  process.env.DSH_HOME = join(config.directory, "home");
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ embeddingEnabled: false, gitSidecarEnabled: false }));
  const store = await import("../lib/store.js");
  const { registerMemoryApi } = await import("../lib/server.js");
  const { readUiSettings } = await import("../lib/settings.js");
  const { DIM } = await import("../lib/schema.js");
  const cwd = join(config.directory, "workspace");
  const db = await store.openWorkspaceDb(cwd);
  const hubs = [];
  const facts = [];
  let markerId;
  let businessEdges = 0;
  const seedStart = performance.now();
  store.runDeferredWrites(db, () => {
    for (let i = 0; i < 17; i++) hubs.push(store.insertNode(db, { type: "entity", name: `BenchHub${i}`, text: `Graph audit hub ${i}.` }));
    markerId = store.insertNode(db, { type: "entity", name: "BenchMarker", text: "Bench marker initial state." });
    const vector = new Array(DIM).fill(0); vector[0] = 1;
    for (let i = 0; i < config.nodes - 19; i++) {
      const id = store.insertNode(db, {
        type: "decision", name: `Bench fact ${i}`, text: `Repository rule ${i}: retain a reviewed fallback and record the deployment outcome.`,
        uri: `ctx://live-tql-bench/${i}`,
        ...(i < 64 ? { benchGroup: "bounded-page-sample", benchRank: 64 - i } : {}),
      });
      db.updateVector(id, vector);
      facts.push(id);
      store.ensureLink(db, id, hubs[i % hubs.length], "about");
      businessEdges++;
    }
    // A bounded connected section makes the PageRank case perform real graph
    // work. Its size and edge count are reported instead of implying this is
    // a byte-for-byte reconstruction of the issue author's private graph.
    const connected = Math.min(facts.length, 1500);
    for (let i = 0; i < connected; i++) {
      for (let step = 1; step <= 4; step++) {
        store.ensureLink(db, facts[i], facts[(i + step) % connected], "about");
        businessEdges++;
      }
    }
  });
  store.flushWorkspaceDb(db);
  const seedMs = performance.now() - seedStart;
  const context = new AsyncLocalStorage();
  const native = [];
  const requests = [];
  for (const method of ["consoleRequest", "flush"]) {
    const original = db[method];
    db[method] = function (...args) {
      const started = performance.now();
      let code;
      try { return original.apply(db, args); }
      catch (err) { code = err.code || err.name; throw err; }
      finally { native.push({ requestId: context.getStore()?.id || null, method, elapsedMs: round(performance.now() - started), ...(code ? { code } : {}) }); }
    };
  }
  let handler;
  registerMemoryApi({ webServer: { register(entry) { handler = entry.handler; return () => {}; } } }, { liveOptions: readUiSettings, status: {} });
  const server = http.createServer((req, res) => {
    const id = String(req.headers["x-bench-id"] || "unlabelled");
    const started = performance.now();
    res.once("finish", () => requests.push({ requestId: id, method: req.method, status: res.statusCode, elapsedMs: round(performance.now() - started) }));
    context.run({ id }, () => Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "BENCH_HANDLER_FAILED", message: err.message }));
    }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  let previous = performance.now();
  const loopLag = [];
  const pulse = setInterval(() => { const now = performance.now(); loopLag.push(Math.max(0, now - previous - 10)); previous = now; }, 10);
  pulse.unref();
  process.send({ type: "ready", base: `http://127.0.0.1:${server.address().port}/api/dsh-trivium`, cwd, markerId, dim: DIM,
    fixture: { nodes: db.nodeCount(), hubs: hubs.length, businessEdges, boundedPageWorkingSet: Math.min(64, facts.length), seedMs: round(seedMs) } });
  process.on("message", async (message) => {
    if (message.type === "metrics") process.send({ type: "metrics", native, requests, loopLag: stats(loopLag), finalNodeCount: db.nodeCount() });
    if (message.type === "stop") {
      clearInterval(pulse);
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      store.closeAll();
      process.disconnect();
    }
  });
}

async function client(config) {
  const samples = [];
  const checks = [];
  let sequence = 0;
  const check = (ok, label, details) => checks.push({ ok: Boolean(ok), label, ...(details ? { details } : {}) });
  async function request(path, body, category, label) {
    const id = `${config.nodes}-${++sequence}-${label}`;
    const started = performance.now();
    let sample;
    try {
      const response = await fetch(`${config.base}${path}?cwd=${encodeURIComponent(config.cwd)}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-bench-id": id, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      sample = { requestId: id, category, label, status: response.status, elapsedMs: round(performance.now() - started), body: data };
    } catch (err) {
      sample = { requestId: id, category, label, status: 0, elapsedMs: round(performance.now() - started), body: { ok: false, code: err.name, message: err.message } };
    }
    sample.outcome = outcome(sample);
    samples.push(sample);
    return sample;
  }
  const parameters = { name: "BenchMarker" };
  const markerRead = { tql: "MATCH (n) WHERE n.name == $name RETURN n.text AS text", params: parameters, limit: 5, timeoutMs: config.queryTimeoutMs };
  async function successfulQuery(body, label) {
    let result;
    for (let attempt = 0; attempt < 8; attempt++) {
      result = await request("/query", body, "query", label + (attempt ? `-retry${attempt}` : ""));
      if (result.outcome !== "busy") return result;
      await delay(20);
    }
    return result;
  }
  async function writeAndConfirm(label, category = "write") {
    const text = `Bench marker confirmed revision ${label}.`;
    let result;
    for (let attempt = 0; attempt < 8; attempt++) {
      result = await request(`/nodes/${config.markerId}`, { text }, category, label + (attempt ? `-retry${attempt}` : ""));
      if (result.status !== 409 && result.status !== 429) break;
      await delay(20);
    }
    check(result.outcome === "success" && result.body.payload?.text === text, `${label}: HTTP write acknowledged its exact payload`, { status: result.status, code: result.body.code });
    return text;
  }
  async function phase(label, body, requireSuccess) {
    const query = request("/query", body, "query", label);
    // These requests originate in another process while the host may be inside
    // a synchronous native call. Their RTT includes waiting for that call.
    await delay(1);
    const pings = [0, 5, 10].map(async (ms, index) => { await delay(ms); return request("/status", undefined, "ping", `${label}-ping${index}`); });
    const writing = writeAndConfirm(`${label}-write`);
    const [result, pingResults, text] = await Promise.all([query, Promise.all(pings), writing]);
    check(pingResults.every((row) => row.outcome === "success"), `${label}: concurrent status pings complete`);
    if (requireSuccess) check(result.outcome === "success", `${label}: query succeeds`, { status: result.status, code: result.body.code });
    else check(["success", "budget", "deadline"].includes(result.outcome), `${label}: query completes or is explicitly bounded`, { status: result.status, code: result.body.code });
    const visible = await successfulQuery(markerRead, `${label}-visibility`);
    check(visible.outcome === "success" && visible.body.rows?.some((row) => row.text === text), `${label}: a read after the confirmed write sees its current value`, { status: visible.status, code: visible.body.code });
    return result;
  }
  await request("/status", undefined, "warmup", "connection-warmup");
  const shortJoin = { tql: "MATCH (n)-[:about]->(hub) WHERE hub.name == $name RETURN n.id AS id, n.name AS name, hub.name AS hub LIMIT 20", params: { name: "BenchHub0" }, limit: 20, timeoutMs: config.queryTimeoutMs };
  const page = (offset) => ({ tql: `MATCH (n) WHERE n.type == $type RETURN n.id AS id, n.name AS name ORDER BY id ASC LIMIT 20 OFFSET ${offset}`, params: { type: "decision" }, limit: 20, timeoutMs: config.queryTimeoutMs });
  const boundedPage = (offset) => ({
    tql: `MATCH (n) WHERE n.benchGroup == $group RETURN n.id AS id, n.benchRank AS rank ORDER BY rank ASC LIMIT 20 OFFSET ${offset}`,
    params: { group: "bounded-page-sample" }, limit: 20, timeoutMs: config.queryTimeoutMs,
  });
  for (let rep = 0; rep < config.reps; rep++) {
    // Baseline has the same confirmed write plus status-ping traffic, without
    // any concurrent TQL. Retain its latencies separately; do not label all
    // observed ping/loop delay in query phases as incremental TQL overhead.
    const baselinePings = [0, 5, 10].map(async (ms, index) => { await delay(ms); return request("/status", undefined, "baselinePing", `baseline-${rep}-ping${index}`); });
    const baselineWrite = writeAndConfirm(`baseline-${rep}-write`, "baselineWrite");
    const [pingResults] = await Promise.all([Promise.all(baselinePings), baselineWrite]);
    check(pingResults.every((row) => row.outcome === "success"), `baseline-${rep}: write-only concurrent status pings complete`);
    const joined = await phase(`join-${rep}`, shortJoin, true);
    check(joined.body.rows?.length === 20 && joined.body.rows.every((row) => row.hub === "BenchHub0"), `join-${rep}: parameters select the expected hub`);
    const first = await successfulQuery(page(0), `page0-${rep}`);
    const second = await phase(`page20-${rep}`, page(20), config.nodes <= 1000);
    const ids = new Set(first.body.rows?.map((row) => row.id));
    if (first.outcome === "success" && second.outcome === "success") {
      check(first.body.rows?.length === 20 && second.body.rows?.length === 20
        && second.body.rows.every((row) => !ids.has(row.id)), `page-${rep}: ordered pages have 20 distinct rows each`);
    } else {
      check(config.nodes > 1000 && [first, second].every((row) => ["budget", "deadline"].includes(row.outcome)),
        `page-${rep}: large full-input pagination is explicitly rejected, not counted as successful pagination`,
        { first: first.outcome, second: second.outcome });
    }
    const boundedFirst = await phase(`bounded-page0-${rep}`, boundedPage(0), true);
    const boundedSecond = await phase(`bounded-page20-${rep}`, boundedPage(20), true);
    check(boundedFirst.body.rows?.length === 20 && boundedFirst.body.rows.every((row, index) => row.rank === index + 1)
      && boundedSecond.body.rows?.length === 20 && boundedSecond.body.rows.every((row, index) => row.rank === index + 21),
      `bounded-page-${rep}: parameter-filtered working set sorts into the exact expected two pages`);
  }
  const vector = new Array(config.dim).fill(0); vector[0] = 1;
  const heavy = `SEARCH VECTOR ${JSON.stringify(vector)} TOP ${Math.min(config.nodes, 1000)} AS seed WITH seed pagerank seed AS scored WITH scored RETURN graph_score(scored) AS score ORDER BY score DESC LIMIT 10`;
  await phase("pagerank", { tql: heavy, params: {}, limit: 10, timeoutMs: config.queryTimeoutMs }, false);
  for (let attempt = 0; attempt < 3; attempt++) {
    const cancelled = await phase(`deadline-${attempt}`, { tql: heavy, params: {}, limit: 10, timeoutMs: 1 }, false);
    if (cancelled.outcome === "deadline") break;
  }
  const restored = await writeAndConfirm("after-timeout-probes");
  const visible = await successfulQuery(markerRead, "after-timeout-probes-read");
  check(visible.outcome === "success" && visible.body.rows?.some((row) => row.text === restored), "write and read remain usable after the deadline probes");
  process.send({ type: "results", checks, samples });
  process.disconnect();
}

function start(roleName, config) {
  const child = spawn(process.execPath, [SELF, `--bench-role=${roleName}`], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, DSH_LIVE_TQL_BENCH_CONFIG: JSON.stringify(config) },
  });
  const messages = [];
  const waits = [];
  let stderr = "";
  let exited = false;
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16384); });
  child.on("message", (message) => {
    const index = waits.findIndex((entry) => entry.type === message.type);
    if (index >= 0) waits.splice(index, 1)[0].done(message);
    else messages.push(message);
  });
  const onFailure = (message) => { for (const waiter of waits.splice(0)) waiter.reject(new Error(message)); };
  child.on("error", (err) => onFailure(err.message));
  const exit = new Promise((done) => child.once("exit", (code, signal) => {
    exited = true; onFailure(`${roleName} exited (${code ?? signal}): ${stderr}`); done({ code, signal });
  }));
  return {
    child, exit,
    wait(type) {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      if (exited) return Promise.reject(new Error(`${roleName} already exited: ${stderr}`));
      return new Promise((done, reject) => waits.push({ type, done, reject }));
    },
    diagnostics: () => stderr,
    async stop() {
      if (!exited) {
        if (roleName === "host" && child.connected) child.send({ type: "stop" });
        else child.kill("SIGKILL");
        const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
        try { await exit; } finally { clearTimeout(kill); }
      }
    },
  };
}

async function main() {
  const flags = new Map();
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: node scripts/bench-live-tql.mjs [--sizes 585,5000] [--reps 3] [--query-timeout-ms 50] [--hard-timeout-ms 90000]\nReal temporary-writer HTTP load experiment; outputs JSON. Not part of npm test.");
    return;
  }
  const allowed = new Set(["--sizes", "--reps", "--query-timeout-ms", "--hard-timeout-ms"]);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || flags.has(args[i]) || args[i + 1] === undefined) throw new Error("Unknown, duplicate or missing argument; see --help");
    flags.set(args[i], args[i + 1]);
  }
  const sizes = String(flags.get("--sizes") || "585,5000").split(",").map(Number);
  const reps = Number(flags.get("--reps") || 3);
  const queryTimeoutMs = Number(flags.get("--query-timeout-ms") || 50);
  const hardTimeoutMs = Number(flags.get("--hard-timeout-ms") || 90000);
  if (!sizes.length || sizes.some((n) => !Number.isSafeInteger(n) || n < 50 || n > 20000)
      || !Number.isSafeInteger(reps) || reps < 1 || reps > 10
      || !Number.isSafeInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 50
      || !Number.isSafeInteger(hardTimeoutMs) || hardTimeoutMs < 1000 || hardTimeoutMs > 300000) throw new Error("Invalid benchmark range; see --help");
  const root = mkdtempSync(join(tmpdir(), "dsh-live-tql-load-"));
  const results = [];
  const generatedAt = new Date().toISOString();
  try {
    for (const nodes of sizes) {
      process.stderr.write(`Measuring real HTTP live TQL with ${nodes} nodes...\n`);
      const { mkdirSync } = await import("node:fs");
      const directory = join(root, `nodes-${nodes}`); mkdirSync(directory);
      let serving;
      let sending;
      let watchdog;
      try {
        const work = async () => {
          serving = start("host", { directory, nodes });
          const ready = await serving.wait("ready");
          sending = start("client", { ...ready, nodes, reps, queryTimeoutMs });
          const measured = await sending.wait("results");
          serving.child.send({ type: "metrics" });
          const metrics = await serving.wait("metrics");
          const samples = measured.samples.map(({ body, ...sample }) => ({ ...sample, ...(body.code ? { code: body.code } : {}),
            rowCount: body.rows?.length, truncated: body.truncated, ...(sample.outcome === "error" ? { message: body.message } : {}) }));
          const native = metrics.native.filter((entry) => entry.method === "consoleRequest");
          const writes = metrics.native.filter((entry) => entry.method === "flush");
          const checks = [...measured.checks, { ok: metrics.finalNodeCount === nodes, label: "HTTP reads and marker updates preserve the fixture's node count" }];
          return {
            ok: checks.every((entry) => entry.ok), fixture: ready.fixture, checks, samples,
            outcomes: Object.fromEntries(["success", "budget", "deadline", "busy", "error"].map((key) => [key, samples.filter((entry) => entry.category === "query" && entry.outcome === key).length])),
            deadlineObserved: samples.some((entry) => entry.category === "query" && entry.outcome === "deadline"),
            pagination: { successfulRequests: samples.filter((entry) => entry.category === "query" && /^page(?:0|20)-\d+(?:-retry\d+)?$/.test(entry.label) && entry.outcome === "success").length,
              rejectedRequests: samples.filter((entry) => entry.category === "query" && /^page(?:0|20)-\d+(?:-retry\d+)?$/.test(entry.label) && ["budget", "deadline"].includes(entry.outcome)).length },
            boundedPagination: { successfulRequests: samples.filter((entry) => entry.category === "query" && /^bounded-page(?:0|20)-\d+$/.test(entry.label) && entry.outcome === "success").length,
              rejectedRequests: samples.filter((entry) => entry.category === "query" && /^bounded-page(?:0|20)-\d+$/.test(entry.label) && ["budget", "deadline"].includes(entry.outcome)).length },
            client: { query: stats(samples.filter((entry) => entry.category === "query").map((entry) => entry.elapsedMs)), ping: stats(samples.filter((entry) => entry.category === "ping").map((entry) => entry.elapsedMs)), write: stats(samples.filter((entry) => entry.category === "write").map((entry) => entry.elapsedMs)),
              baselinePing: stats(samples.filter((entry) => entry.category === "baselinePing").map((entry) => entry.elapsedMs)), baselineWrite: stats(samples.filter((entry) => entry.category === "baselineWrite").map((entry) => entry.elapsedMs)) },
            host: { queryNative: stats(native.map((entry) => entry.elapsedMs)), writeFlush: stats(writes.map((entry) => entry.elapsedMs)), eventLoopLag: metrics.loopLag, nativeCalls: metrics.native, requests: metrics.requests },
          };
        };
        const expired = new Promise((_, reject) => { watchdog = setTimeout(() => {
          serving?.child.kill("SIGKILL"); sending?.child.kill("SIGKILL");
          reject(new Error(`External watchdog exceeded ${hardTimeoutMs} ms`));
        }, hardTimeoutMs); });
        results.push(await Promise.race([work(), expired]));
      } catch (err) {
        results.push({ ok: false, fixture: { nodes }, error: err.message, hostStderr: serving?.diagnostics(), clientStderr: sending?.diagnostics() });
      } finally {
        clearTimeout(watchdog);
        await Promise.all([serving?.stop(), sending?.stop()]);
      }
    }
  } finally {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
  }
  const report = {
    protocol: "dsh-live-tql-http-v1", generatedAt, node: process.version,
    settings: { sizes, reps, queryTimeoutMs, externalHardTimeoutMs: hardTimeoutMs },
    methodology: ["Real registerMemoryApi; one writer in a dedicated host process and an independent HTTP client process.", "Native timing wraps the existing writer's consoleRequest; write timing separately records flush.", "Concurrent ping uses the real GET /status endpoint; concurrent writes use POST /nodes/:id and require exact acknowledged payload visibility.", "Baseline phases send only the same HTTP writes and status pings, without concurrent TQL. Baseline latencies are reported separately; the experiment does not claim a statistically controlled incremental-overhead estimate.", "Event-loop lag includes synchronous queries and confirmed write flushes; it is not attributed exclusively to TQL.", "Deadlines are observed, not assumed: a 1ms probe may finish before cancellation; outcomes retain success, budget rejection and deadline cancellation separately.", "Small-fixture full-input pagination must succeed. Large full-input pagination may explicitly exceed native work budgets; rejected requests are counted separately and never described as successful pagination.", "Both fixture sizes must successfully sort/page a parameter-filtered 64-node working set, with exact expected ranks 1..20 and 21..40 verified independently of the returned ordering."],
    ok: results.every((result) => result.ok), deadlineObserved: results.some((result) => result.deadlineObserved), results,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

try {
  if (role === "host") await host(JSON.parse(process.env.DSH_LIVE_TQL_BENCH_CONFIG));
  else if (role === "client") await client(JSON.parse(process.env.DSH_LIVE_TQL_BENCH_CONFIG));
  else await main();
} catch (err) {
  if (role) console.error(err.stack || err.message);
  else console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
