/** Offline regression runner. A logical case gets its own process and temporary settings. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const childId = process.argv[2] === "--case" ? process.argv[3] : null;
const listOnly = !childId && process.argv.slice(2).includes("--list");
const filter = childId
  ? ""
  : String(process.argv.slice(2).find((x) => x !== "--list") || "")
      .trim()
      .toLowerCase();

async function discover() {
  const jobs = [];
  for (const file of readdirSync(SCRIPTS_DIR)) {
    const numeric = file.match(/^smoke-p(\d+)\.mjs$/);
    if (numeric || file === "p2-cases.mjs") {
      const key = numeric ? Number(numeric[1]) : 2;
      jobs.push({ key, id: `p${key}`, file, suite: false });
    } else if (/^smoke-[a-z][a-z-]*\.mjs$/.test(file)) {
      const module = await import(pathToFileURL(join(SCRIPTS_DIR, file)).href);
      if (!module.cases || typeof module.cases !== "object")
        throw new Error(`${file} must export cases`);
      for (const [id, run] of Object.entries(module.cases)) {
        if (!/^p\d+$/.test(id) || typeof run !== "function")
          throw new Error(`Invalid case ${file}:${id}`);
        jobs.push({ key: Number(id.slice(1)), id, file, suite: true, run });
      }
    }
  }
  const ids = new Set();
  for (const job of jobs) {
    if (ids.has(job.id)) throw new Error(`Duplicate regression ID ${job.id}`);
    ids.add(job.id);
  }
  return jobs.sort((a, b) => a.key - b.key);
}

const all = await discover();
if (childId) {
  const job = all.find((x) => x.id === childId && x.suite);
  if (!job) throw new Error(`Unknown suite case ${childId}`);
  await job.run();
} else {
  const jobs = all.filter(
    (job) =>
      !filter ||
      `${job.id} smoke-${job.id}.mjs ${job.file}`
        .toLowerCase()
        .includes(filter),
  );
  if (!jobs.length)
    throw new Error(`No regression matches ${JSON.stringify(filter)}`);
  if (listOnly) {
    for (const job of jobs) console.log(`${job.id.padEnd(5)} ${job.file}`);
    console.log(
      `${jobs.length} logical cases in ${new Set(jobs.map((x) => x.file)).size} files`,
    );
  } else {
    const require = createRequire(import.meta.url);
    for (const name of ["@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-tools"]) {
      try {
        require.resolve(name);
      } catch {
        throw new Error(
          `Missing development dependency ${name}. Run npm ci before npm test.`,
        );
      }
    }
    const settingsRoot = mkdtempSync(join(tmpdir(), "dsh-trivium-run-"));
    const results = [];
    try {
      console.log(
        `Running ${jobs.length} logical cases in separate processes.`,
      );
      for (const job of jobs) {
        console.log(`\n== ${job.id} (${job.file})`);
        const started = Date.now();
        const args = job.suite
          ? [fileURLToPath(import.meta.url), "--case", job.id]
          : [join(SCRIPTS_DIR, job.file)];
        const result = spawnSync(process.execPath, args, {
          stdio: "inherit",
          env: {
            ...process.env,
            DSH_TRIVIUM_SETTINGS: join(settingsRoot, `${job.id}.json`),
            DSH_HOME: join(settingsRoot, `${job.id}-home`),
          },
        });
        results.push({
          ...job,
          ok: result.status === 0,
          status: result.status,
          ms: Date.now() - started,
        });
      }
    } finally {
      if (dirname(resolve(settingsRoot)) !== resolve(tmpdir()))
        throw new Error("Refusing cleanup outside temp directory");
      rmSync(settingsRoot, { recursive: true, force: true });
    }
    const passed = results.filter((x) => x.ok).length;
    console.log("\n== summary");
    for (const row of results)
      console.log(
        `${row.ok ? "pass" : "FAIL"} ${row.id.padEnd(5)} ${String(row.ms).padStart(6)} ms ${row.file}${row.ok ? "" : ` (exit ${row.status})`}`,
      );
    console.log(`\n${passed}/${results.length} passed`);
    if (passed !== results.length) process.exitCode = 1;
  }
}
