import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const REGISTRY_URL = "https://registry.npmjs.org/dsh-trivium/latest";
const CACHE_MS = 12 * 60 * 60 * 1000;
const UPDATE_COMMAND = "dsh plugin --profile web add dsh-trivium";

let cache = { at: 0, latest: "" };

export function installedVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8"));
    return String(pkg.version || "").trim();
  } catch {
    return "";
  }
}

export function cmpSemver(a, b) {
  const pa = String(a || "0")
    .split(/[.-]/)
    .map((bit) => Number.parseInt(bit, 10) || 0);
  const pb = String(b || "0")
    .split(/[.-]/)
    .map((bit) => Number.parseInt(bit, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export async function checkNpmUpdate({ force = false } = {}) {
  const installed = installedVersion();
  const now = Date.now();
  if (!force && cache.latest && now - cache.at < CACHE_MS) {
    return pack(installed, cache.latest);
  }
  try {
    const resp = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json" },
    });
    if (!resp.ok) {
      return pack(installed, cache.latest, `registry HTTP ${resp.status}`);
    }
    const json = await resp.json();
    const latest = String(json?.version || "").trim();
    if (latest) cache = { at: now, latest };
    return pack(installed, latest || cache.latest);
  } catch (err) {
    return pack(installed, cache.latest, String(err.message || err));
  }
}

function pack(installed, latest, error = "") {
  const newer = Boolean(installed && latest && cmpSemver(latest, installed) > 0);
  return {
    ok: true,
    name: "dsh-trivium",
    installed,
    latest: latest || "",
    newer,
    command: UPDATE_COMMAND,
    error: error || "",
  };
}
