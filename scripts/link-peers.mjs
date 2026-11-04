/**
 * Restore the DSH peer packages that `npm install` keeps pruning.
 *
 * `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools` are peers, and the public
 * registry only carries 0.0.1-rc.1 (which the peer range rejects). They exist in
 * the host profile, so the only reliable local source is a link to that copy —
 * and every `npm install` deletes it, which turns the suite into 17 ×
 * ERR_MODULE_NOT_FOUND with no obvious cause.
 *
 * Run by `run-all.mjs` before the scripts, so the suite repairs itself instead of
 * depending on whoever remembered to re-link.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PEERS = ["dsh-llm", "dsh-tools"];

/** Where the host keeps its copy of the DSH packages. */
export function profileScope() {
  return join(homedir(), ".dsh", "profiles", "node_modules", "@deepseek-ai");
}

/**
 * Make `node_modules/@deepseek-ai/<peer>` resolve again.
 *
 * Returns what it did per package (`linked` / `present` / `missing`), so a caller
 * can report rather than fail silently. A missing profile copy is not an error
 * here: a CI box that installed the peers from its own registry has them already.
 */
export function ensurePeers({ root = process.cwd(), scope = profileScope(), log = () => {} } = {}) {
  const out = {};
  const targetDir = join(root, "node_modules", "@deepseek-ai");
  for (const name of PEERS) {
    const dest = join(targetDir, name);
    const source = join(scope, name);
    if (existsSync(dest)) {
      out[name] = "present";
      continue;
    }
    if (!existsSync(source)) {
      out[name] = "missing";
      continue;
    }
    mkdirSync(targetDir, { recursive: true });
    try {
      symlinkSync(source, dest, process.platform === "win32" ? "junction" : "dir");
      out[name] = "linked";
      log(`linked ${name} -> ${source}`);
    } catch (err) {
      // A stale link (deleted target) can be replaced once; anything else is real.
      try {
        if (lstatSync(dest).isSymbolicLink()) {
          rmSync(dest, { force: true });
          symlinkSync(source, dest, process.platform === "win32" ? "junction" : "dir");
          out[name] = "relinked";
          continue;
        }
      } catch { /* fall through */ }
      out[name] = `failed: ${String(err?.message || err).slice(0, 120)}`;
    }
  }
  void readlinkSync;
  void resolve;
  return out;
}

if (import.meta.filename === process.argv[1]) {
  const result = ensurePeers({ log: (line) => console.log(line) });
  console.log(JSON.stringify(result));
  if (Object.values(result).some((value) => String(value).startsWith("failed"))) process.exitCode = 1;
}
