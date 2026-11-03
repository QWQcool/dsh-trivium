/**
 * How deep does the router's queue get, and how slow does a write become?
 *
 * `bench-lock-contention --router` answers "do all the writes land" (yes, 30/30
 * against 8/36 for the lock). It does not answer the follow-up: with more than a
 * handful of workers firing at once, how long does the last write wait? That is
 * the number that decides whether the router needs backpressure, and it cannot
 * be read off the lock benchmark because there is no lock to lose.
 *
 * Shape: one router in this process, N child processes that each fire M writes
 * concurrently, per-write latency measured at the caller.
 *
 *   node scripts/bench-router-queue.mjs            # 2/5/10 workers x 50 writes
 *   node scripts/bench-router-queue.mjs 10 100     # workers writes
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLIENT_FLAG = "--client";

async function runClient(cwd, writes, label) {
  const { createRouterClient } = await import("../lib/router.js");
  const client = createRouterClient({ cwd });
  await client.ready;
  const latencies = [];
  let failures = 0;
  await Promise.all(
    Array.from({ length: writes }, (_, i) => {
      const started = process.hrtime.bigint();
      return client.writer
        .insert({ type: "preference", name: `${label}-${i}`, text: `${label} burst ${i}` })
        .then(() => {
          latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
        })
        .catch(() => {
          failures += 1;
        });
    }),
  );
  await client.close();
  process.stdout.write(`${JSON.stringify({ label, latencies, failures })}\n`);
}

function spawnClient(cwd, writes, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, CLIENT_FLAG, cwd, String(writes), label], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DSH_TRIVIUM_SETTINGS: join(cwd, "settings.json") },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`client ${label} exited ${code}: ${err.slice(0, 400)}`));
        return;
      }
      resolve(out.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    });
  });
}

const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};
const round = (value) => Math.round(value * 10) / 10;

const workers = Number(process.argv[2] || 0);
const writes = Number(process.argv[3] || 50);

if (process.argv[2] === CLIENT_FLAG) {
  const [, , , cwd, count, label] = process.argv;
  await runClient(cwd, Number(count), label);
  process.exit(0);
}

const scenarios = workers ? [{ workers, writes }] : [2, 5, 10].map((n) => ({ workers: n, writes }));

const results = [];
for (const scenario of scenarios) {
  const root = mkdtempSync(join(tmpdir(), "trivium-router-queue-"));
  const cwd = join(root, "ws");
  const { startRouter } = await import("../lib/router.js");
  const router = await startRouter({ cwd });
  const started = Date.now();
  try {
    const runs = [];
    for (let i = 0; i < scenario.workers; i += 1) runs.push(spawnClient(cwd, scenario.writes, `w${i}`));
    const rows = (await Promise.all(runs)).flat();
    const wallMs = Date.now() - started;
    const stats = router.stats();
    await router.close();
    const store = await import("../lib/store.js");
    // The router reached the database through the store cache; drop the closed
    // handle before counting, or the count reads an empty ghost.
    store.closeAll();
    const db = await store.openWorkspaceDb(cwd);
    const written = store.findByType(db, "preference").length;
    store.closeAll();
    const latencies = rows.flatMap((row) => row.latencies).sort((a, b) => a - b);
    const failures = rows.reduce((sum, row) => sum + row.failures, 0);
    results.push({
      workers: scenario.workers,
      perWorker: scenario.writes,
      total: scenario.workers * scenario.writes,
      written,
      failures,
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      maxMs: round(latencies[latencies.length - 1] || 0),
      maxQueue: stats.maxQueued,
      wallMs,
      rate: round((written / wallMs) * 1000),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const header = ["workers", "perWorker", "total", "written", "fail", "p50(ms)", "p95(ms)", "p99(ms)", "max(ms)", "maxQueue", "wall(ms)", "writes/s"];
console.log(header.join("\t"));
for (const row of results) {
  console.log(
    [row.workers, row.perWorker, row.total, row.written, row.failures, row.p50, row.p95, row.p99, row.maxMs, row.maxQueue, row.wallMs, row.rate].join("\t"),
  );
}
const worst = results.reduce((acc, row) => (row.p95 > acc.p95 ? row : acc), results[0]);
console.log(`\nworst p95: ${worst.p95} ms at ${worst.workers} workers · deepest queue: ${Math.max(...results.map((row) => row.maxQueue))}`);
