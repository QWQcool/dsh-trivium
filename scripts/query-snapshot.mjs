#!/usr/bin/env node
/** Query an explicitly selected independent snapshot without opening its writer. */
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: dsh-trivium-query --snapshot <directory> --tql <query> [--params <JSON object>] [--limit <1-1000>] [--timeout-ms <1-10000>]\nRead-only TQL against an independent snapshot; outputs JSON.");
} else {
  try {
    const flags = new Map();
    const allowed = new Set(["--snapshot", "--tql", "--params", "--limit", "--timeout-ms"]);
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.has(args[i]) || flags.has(args[i]) || args[i + 1] === undefined) throw new Error("Unknown, duplicate or missing CLI argument");
      flags.set(args[i], args[i + 1]);
    }
    if (!flags.has("--snapshot") || !flags.has("--tql")) throw new Error("--snapshot and --tql are required; see --help");
    const { querySnapshotDirectory } = await import("../lib/read-snapshots.js");
    const result = await querySnapshotDirectory(flags.get("--snapshot"), {
      tql: flags.get("--tql"),
      params: JSON.parse(flags.get("--params") || "{}"),
      ...(flags.has("--limit") ? { limit: Number(flags.get("--limit")) } : {}),
      ...(flags.has("--timeout-ms") ? { timeoutMs: Number(flags.get("--timeout-ms")) } : {}),
    });
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, code: err.code || "QUERY_INVALID", message: String(err.message || err) }));
    process.exitCode = 1;
  }
}
