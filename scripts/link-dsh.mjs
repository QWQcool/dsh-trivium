/**
 * Junction this repo into the local DSH web profile and merge cordis.patch.yml.
 * Does not copy sources into DeepSeek_Harness.
 *
 *   node scripts/link-dsh.mjs
 *
 * Also junctions @deepseek-ai/dsh-tools and dsh-llm into this repo's
 * node_modules so Node's realpath walk (junction → Desktop) still finds
 * the profile fallback peers.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
const PEERS = ["@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-llm"];

function fail(msg) {
  console.error("[dsh-trivium] " + msg);
  process.exit(1);
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove a junction/symlink without following it into the target tree. */
function removeLink(path) {
  try {
    lstatSync(path);
  } catch {
    return;
  }
  if (process.platform === "win32") {
    const r = spawnSync("cmd", ["/c", "rmdir", path], { encoding: "utf8" });
    if (r.status === 0) return;
    try {
      unlinkSync(path);
      return;
    } catch {
      fail(`cannot remove existing link ${path}: ${r.stderr || r.stdout || "rmdir failed"}`);
    }
  }
  unlinkSync(path);
}

function junction(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  if (isLink(to)) {
    try {
      if (readlinkSync(to) === from) return;
    } catch {
      // recreate
    }
    removeLink(to);
  } else if (existsSync(join(to, "package.json"))) {
    return;
  } else if (existsSync(to)) {
    fail(`refusing to replace non-link path ${to}`);
  }
  try {
    symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    if (process.platform === "win32") {
      const r = spawnSync("cmd", ["/c", "mklink", "/J", to, from], { encoding: "utf8" });
      if (r.status !== 0) fail(`mklink failed: ${r.stderr || r.stdout || err.message}`);
    } else {
      fail(`symlink failed: ${err.message}`);
    }
  }
}

function resolvePeer(name) {
  const candidates = [
    join(MODULES, name),
    join(dirname(PROFILE), "node_modules", name),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

mkdirSync(MODULES, { recursive: true });
junction(ROOT, LINK);

for (const name of PEERS) {
  const target = resolvePeer(name);
  if (!target) {
    console.warn(`[dsh-trivium] peer not found in DSH profile, skip junction: ${name}`);
    continue;
  }
  junction(target, join(ROOT, "node_modules", name));
  console.log(`[dsh-trivium] peer   ${name} -> ${target}`);
}

const insertBlock = `    - id: dsh-trivium
      name: dsh-trivium
      config:
        autoRecall: false
        writeApproval: false
        mapTokenBudget: 400
        expandDepth: 1
        topK: 8
`;

let yaml = existsSync(PATCH) ? readFileSync(PATCH, "utf8") : "# profile patch\n";
if (!yaml.includes("id: dsh-trivium")) {
  if (/^-\s*insert:/m.test(yaml) || /\n-\s*insert:/m.test(yaml)) {
    yaml = yaml.replace(
      /(^- insert:\s*\n(?:    - id:.*\n(?:      .*\n)*)*)/m,
      (m) => m + insertBlock,
    );
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
