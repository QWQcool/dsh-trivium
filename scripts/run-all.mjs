/**
 * Run every offline smoke script sequentially and aggregate the result.
 *
 *   npm test                # everything
 *   npm test -- p8          # only scripts whose file name contains "p8"
 *   npm test -- smoke-p1    # same idea
 *
 * Two things this centralizes that hand-running does not:
 *
 * 1. Discovery. Scripts are found by pattern, so a new scripts/smoke-pN.mjs is
 *    picked up automatically. Enumerating them by hand already failed once
 *    (smoke-p9 existed but was never registered in package.json).
 * 2. Settings isolation. Every child gets its own DSH_TRIVIUM_SETTINGS temp
 *    file, so no script can touch the live ~/.dsh/trivium.json. Only smoke-p8 /
 *    p11 / p12 set that variable themselves today; the rest relied on a tmpdir
 *    guard inside rememberWorkspace()/writeSidecarHash(), which writePins()
 *    does not have.
 *
 * No DSH host is needed: these scripts only import from lib/ and never
 * lib/index.js, so they do not depend on the peer junctions link-dsh creates.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const filter = String(process.argv[2] || "").trim().toLowerCase();

/** smoke-pN.mjs sort by N; p2-cases.mjs sits where a smoke-p2 would. */
function discover() {
  const rows = [];
  for (const name of readdirSync(SCRIPTS_DIR)) {
    const smoke = name.match(/^smoke-p(\d+)\.mjs$/);
    if (smoke) {
      rows.push({ key: Number(smoke[1]), name });
      continue;
    }
    if (name === "p2-cases.mjs") rows.push({ key: 2, name });
  }
  return rows
    .filter((row) => !filter || row.name.toLowerCase().includes(filter))
    .sort((a, b) => a.key - b.key || a.name.localeCompare(b.name));
}

const jobs = discover();
if (!jobs.length) {
  console.error(filter ? `No script matches "${filter}".` : "No smoke scripts found.");
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "dsh-trivium-run-"));
const results = [];
let failed = 0;

console.log(`Running ${jobs.length} script(s) sequentially. Settings are isolated to ${home}\n`);

for (const job of jobs) {
  const started = Date.now();
  console.log(`\n${"=".repeat(60)}\n== ${job.name}\n${"=".repeat(60)}`);
  const run = spawnSync(process.execPath, [join(SCRIPTS_DIR, job.name)], {
    stdio: "inherit",
    env: {
      ...process.env,
      // Per-script file so one script cannot seed another's state.
      DSH_TRIVIUM_SETTINGS: join(home, `${job.name}.json`),
    },
  });
  const ms = Date.now() - started;
  const ok = run.status === 0;
  if (!ok) failed += 1;
  results.push({ name: job.name, ok, ms, status: run.status });
}

rmSync(home, { recursive: true, force: true });

console.log(`\n${"=".repeat(60)}\n== summary\n${"=".repeat(60)}`);
for (const row of results) {
  const mark = row.ok ? "pass" : "FAIL";
  console.log(`${mark}  ${row.name.padEnd(22)} ${String(row.ms).padStart(6)} ms${row.ok ? "" : `  (exit ${row.status})`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);

if (failed) {
  console.error(`${failed} script(s) failed.`);
  process.exit(1);
}
console.log("All smoke scripts passed.");
