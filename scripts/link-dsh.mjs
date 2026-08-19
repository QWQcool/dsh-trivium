/**
 * Junction this repo into the local DSH web profile and merge cordis.patch.yml.
 * Does not copy sources into DeepSeek_Harness.
 *
 *   node scripts/link-dsh.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PROFILE = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "profiles", "web");
const MODULES = join(PROFILE, "node_modules");
const LINK = join(MODULES, "dsh-trivium");
const PATCH = join(PROFILE, "cordis.patch.yml");

function fail(msg) {
  console.error("[dsh-trivium] " + msg);
  process.exit(1);
}

mkdirSync(MODULES, { recursive: true });
if (existsSync(LINK)) {
  rmSync(LINK, { recursive: true, force: true });
}

if (process.platform === "win32") {
  const r = spawnSync("cmd", ["/c", "mklink", "/J", LINK, ROOT], { encoding: "utf8" });
  if (r.status !== 0) fail(`mklink failed: ${r.stderr || r.stdout}`);
} else {
  const r = spawnSync("ln", ["-s", ROOT, LINK], { encoding: "utf8" });
  if (r.status !== 0) fail(`ln -s failed: ${r.stderr || r.stdout}`);
}

const insertBlock = `    - id: dsh-trivium
      name: dsh-trivium
      config:
        autoRecall: false
        mapTokenBudget: 400
        expandDepth: 1
        topK: 8
`;

let yaml = existsSync(PATCH) ? readFileSync(PATCH, "utf8") : "# profile patch\n";
if (!yaml.includes("id: dsh-trivium")) {
  if (/^-\s*insert:/m.test(yaml) || /\n-\s*insert:/m.test(yaml)) {
    yaml = yaml.replace(/(^- insert:\s*\n(?:    - id:.*\n(?:      .*\n)*)*)/m, (m) => m + insertBlock);
    if (!yaml.includes("id: dsh-trivium")) {
      yaml += `\n- insert:\n${insertBlock}`;
    }
  } else {
    yaml += `\n- insert:\n${insertBlock}`;
  }
  writeFileSync(PATCH, yaml, "utf8");
}

console.log("[dsh-trivium] linked -> " + LINK);
console.log("[dsh-trivium] patch  -> " + PATCH);
console.log("[dsh-trivium] restart `dsh web` then open a workspace to try ctx_find / ctx_remember.");
