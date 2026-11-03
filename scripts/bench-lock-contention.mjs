/**
 * How often does a second writer lose the workspace lock?
 *
 * Stage 1 of the Super-agent fit has one open question: when several work items
 * extract into the same library at the same time, is "one writer per workspace"
 * (today: a lock, the loser leaves the window pending) good enough, or does the
 * design need a single router that writes for everyone?
 *
 * The answer depends on numbers we did not have:
 *
 *   - with a short run (a stub model that answers quickly), how many attempts
 *     actually collide;
 *   - with a long run (a real model call, ~1.5 s), how many collide;
 *   - and whether a lost attempt loses data or just defers it.
 *
 * This benchmark spawns real child processes against one temporary workspace and
 * reports the three counters. It never touches the host, ~/.dsh or any existing
 * library.
 *
 *   node scripts/bench-lock-contention.mjs              # 3 workers x 8 rounds
 *   node scripts/bench-lock-contention.mjs 5 10 300     # workers rounds workMs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKER_FLAG = "--worker";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Child: one writer, `rounds` attempts, each holding the lock for `workMs`.
 *
 * Attempts are spaced by `gapMs`, which is the parameter that matters: in the
 * real pipeline a loser does not spin — its window stays pending and the retry
 * happens on the next event (a user turn, seconds or minutes later). A tight
 * retry loop would measure starvation instead of contention.
 */
async function runWorker(cwd, rounds, workMs, label, gapMs) {
  const store = await import("../lib/store.js");
  const { withWorkspaceLock } = await import("../lib/workspace-lock.js");
  /*
   * Break the lockstep. Three processes started together and given the same
   * fixed gap attempt at the same instants forever, which reports 2/3 busy no
   * matter how short the work is. Real sessions drift, so the worker starts at a
   * random phase and adds jitter per round; the busy rate then tracks overlap
   * (work / gap) instead of the spawn order.
   */
  await sleep(Math.random() * gapMs);
  for (let round = 0; round < rounds; round += 1) {
    const started = Date.now();
    let row;
    try {
      const outcome = await withWorkspaceLock(cwd, async () => {
        const db = await store.openWorkspaceDb(cwd);
        // A real extraction writes a fact and then waits on the model; the insert
        // happens first so a lost lock cannot be confused with a lost write.
        const id = store.insertNode(db, {
          type: "preference",
          name: `${label}-${round}`,
          text: `${label} round ${round} wrote this fact`,
        });
        await sleep(workMs);
        return id;
      });
      row = {
        label,
        round,
        ok: !outcome.locked,
        reason: outcome.locked ? outcome.reason || "busy" : null,
        id: outcome.value,
        ms: Date.now() - started,
      };
    } catch (err) {
      // A process that keeps the database open holds it for its whole lifetime;
      // this is what a second DSH instance sees today.
      row = { label, round, ok: false, reason: "db-locked", error: String(err?.message || err).slice(0, 120), ms: Date.now() - started };
    }
    // The run is over: release the handle, exactly as an extraction that closes
    // after its write would. Without this the file lock is moot — the engine's
    // own handle is the real gate.
    store.closeAll();
    process.stdout.write(`${JSON.stringify(row)}\n`);
    await sleep(gapMs * (0.6 + Math.random() * 0.8));
  }
  store.closeAll();
}

function spawnWorker(cwd, rounds, workMs, label, gapMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [import.meta.filename, WORKER_FLAG, cwd, String(rounds), String(workMs), label, String(gapMs)], {
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
        reject(new Error(`worker ${label} exited ${code}: ${err.slice(0, 400)}`));
        return;
      }
      resolve(out.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    });
  });
}

async function scenario({ workers, rounds, workMs, gapMs }) {
  const root = mkdtempSync(join(tmpdir(), "trivium-lock-bench-"));
  const cwd = join(root, "ws");
  const started = Date.now();
  let rows;
  try {
    const runs = [];
    for (let i = 0; i < workers; i += 1) runs.push(spawnWorker(cwd, rounds, workMs, `w${i}`, gapMs));
    rows = (await Promise.all(runs)).flat();
    const store = await import("../lib/store.js");
    const db = await store.openWorkspaceDb(cwd);
    // Only the facts this benchmark wrote: the store also holds a workspace root.
    const written = store.findByType(db, "preference").length;
    store.closeAll();
    const ok = rows.filter((row) => row.ok).length;
    const busy = rows.filter((row) => !row.ok).length;
    return {
      workers,
      rounds,
      workMs,
      gapMs,
      attempts: rows.length,
      ok,
      busy,
      busyPct: Math.round((busy / rows.length) * 1000) / 10,
      written,
      lostWrites: ok - written,
      wallMs: Date.now() - started,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === WORKER_FLAG) {
  const [, , , cwd, rounds, workMs, label, gapMs] = process.argv;
  await runWorker(cwd, Number(rounds), Number(workMs), label, Number(gapMs));
  process.exit(0);
}

const workers = Number(process.argv[2] || 3);
const rounds = Number(process.argv[3] || 10);
const workMsArg = process.argv[4];
const gapMsArg = Number(process.argv[5] || 800);

const scenarios = workMsArg
  ? [{ workers, rounds, workMs: Number(workMsArg), gapMs: gapMsArg }]
  : [
      { workers, rounds, workMs: 50, gapMs: gapMsArg, label: "fast extraction (stub model)" },
      { workers, rounds, workMs: 400, gapMs: gapMsArg, label: "medium extraction" },
      { workers, rounds, workMs: 1500, gapMs: gapMsArg, label: "slow extraction (real model call)" },
    ];

const results = [];
for (const [index, scenarioConfig] of scenarios.entries()) {
  const label = scenarioConfig.label || `${scenarioConfig.workMs} ms`;
  process.stderr.write(`scenario ${index + 1}/${scenarios.length}: ${label} ... `);
  const result = await scenario(scenarioConfig);
  results.push({ ...result, label });
  process.stderr.write(`busy ${result.busy}/${result.attempts}\n`);
}

const header = ["scenario", "workers", "gap(ms)", "work(ms)", "attempts", "wrote", "busy", "busy%", "nodes", "lost", "wall(ms)"];
console.log(header.join("\t"));
for (const row of results) {
  console.log(
    [row.label, row.workers, row.gapMs, row.workMs, row.attempts, row.ok, row.busy, `${row.busyPct}%`, row.written, row.lostWrites, row.wallMs].join("\t"),
  );
}
const worst = Math.max(...results.map((row) => row.busyPct));
const lost = results.reduce((sum, row) => sum + row.lostWrites, 0);
console.log(
  `\nworst busy rate: ${worst}% · lost writes: ${lost} · every losing attempt leaves its window pending, so the fact is retried on the next event`,
);
