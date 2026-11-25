/** Killable snapshot execution. Provider credentials stay in the host process. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { getReadSnapshot } from "./read-snapshots.js";
import { validateDatabaseDimension } from "./database-dimensions.js";
import { embeddingRevision, normalizeVector } from "./embed.js";
import { entityQueryEmbedding, entitySearchError, validateEntitySearch, ENTITY_SEARCH_LIMITS } from "./entity-search.js";

const WORKER = fileURLToPath(new URL("./entity-search-worker.mjs", import.meta.url));
let active = 0;

export async function searchEntitySnapshot(cwd, snapshotId, body, options = {}) {
  const query = validateEntitySearch(body);
  const snapshot = getReadSnapshot(cwd, snapshotId);
  let dimensions;
  try { dimensions = validateDatabaseDimension(snapshot.dim); }
  catch { throw entitySearchError(409, "ENTITY_SEARCH_SNAPSHOT_CHANGED", "Snapshot publication has invalid dimensions."); }
  const revision = embeddingRevision();
  const ensureCurrent = () => {
    if (options.isCurrent && !options.isCurrent()) throw entitySearchError(409, "ENTITY_SEARCH_SOURCE_CHANGED", "The selected database instance changed; retry explicitly.");
    if (query.semantic && embeddingRevision() !== revision) throw entitySearchError(409, "ENTITY_SEARCH_EMBEDDING_CHANGED", "Embedding configuration changed; retry explicitly.");
  };
  if (active >= 2) throw entitySearchError(429, "ENTITY_SEARCH_BUSY", "Snapshot entity search workers are busy.");
  const started = performance.now();
  const remainingMs = Math.min(ENTITY_SEARCH_LIMITS.totalMs, options.remainingMs ?? ENTITY_SEARCH_LIMITS.totalMs);
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)$|^DSH_TRIVIUM_EMBED_|^OPENAI_|^DEEPSEEK_/i.test(name)));
      const child = spawn(process.execPath, ["--max-old-space-size=256", WORKER], { windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
      const providerController = new AbortController();
      let buffer = "", bytes = 0, stderr = 0, result, failure, embeddingUsed = false, closed = false;
      const stop = error => { failure ||= error; providerController.abort(); child.kill("SIGKILL"); };
      const abort = () => stop(entitySearchError(499, "ENTITY_SEARCH_CANCELLED", "Snapshot entity search cancelled."));
      const timer = setTimeout(() => stop(entitySearchError(408, "ENTITY_SEARCH_TIMEOUT", "Snapshot entity search exceeded its wall-clock deadline.")), remainingMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      const message = value => {
        if (value.type === "result" && !result) { result = value.value; return; }
        if (value.type !== "embedding" || !query.semantic || embeddingUsed || result || value.query !== query.query
            || value.dimensions !== dimensions || value.generationId !== snapshot.generationId) {
          stop(entitySearchError(500, "ENTITY_SEARCH_WORKER_FAILED", "Invalid snapshot worker protocol.")); return;
        }
        embeddingUsed = true;
        const timeoutMs = Math.floor(Math.min(value.timeoutMs, remainingMs - (performance.now() - started) - 300));
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { stop(entitySearchError(408, "ENTITY_SEARCH_TIMEOUT", "No time remains for snapshot embedding.")); return; }
        Promise.resolve().then(() => {
          ensureCurrent();
          if (providerController.signal.aborted) throw entitySearchError(499, "ENTITY_SEARCH_CANCELLED", "Snapshot embedding cancelled.");
          return (options.embedding || entityQueryEmbedding)(value.query, { signal: providerController.signal, timeoutMs, dimensions, expectedRevision: revision });
        }).then(reply => {
          if (closed || failure || result) return;
          ensureCurrent();
          // Keep the worker input bounded: only explicit status and a N-wide finite vector can cross the pipe.
          const vector = reply?.status === "ran" ? normalizeVector(reply.vector, dimensions) : null;
          const value = vector ? { status: "ran", vector, calls: 1 }
            : reply?.status === "ran" ? { status: "failed", reason: "invalid_query_vector", calls: 1 }
            : { status: reply?.status, reason: typeof reply?.reason === "string" ? reply.reason.slice(0, 100) : undefined,
              calls: reply?.calls === 0 ? 0 : 1 };
          child.stdin.write(JSON.stringify({ type: "embedding-result", value }) + "\n");
        })
          .catch(error => { if (!closed && !result) stop(error); });
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        bytes += Buffer.byteLength(chunk); buffer += chunk;
        if (bytes > ENTITY_SEARCH_LIMITS.responseBytes + 8192) { stop(entitySearchError(413, "ENTITY_SEARCH_RESPONSE_TOO_LARGE", "Snapshot worker response exceeded its byte budget.")); return; }
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          try { message(JSON.parse(line)); } catch { stop(entitySearchError(500, "ENTITY_SEARCH_WORKER_FAILED", "Invalid snapshot worker response.")); }
        }
      });
      child.stderr.on("data", chunk => { stderr += chunk.length; if (stderr > 65536) stop(entitySearchError(500, "ENTITY_SEARCH_WORKER_FAILED", "Snapshot worker diagnostic budget exceeded.")); });
      child.stdin.on("error", () => {});
      child.on("error", () => { failure ||= entitySearchError(500, "ENTITY_SEARCH_WORKER_FAILED", "Snapshot worker failed to start."); });
      child.on("close", code => {
        closed = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); providerController.abort();
        if (failure) return reject(failure);
        if (code !== 0 || !result) return reject(entitySearchError(500, "ENTITY_SEARCH_WORKER_FAILED", "Snapshot worker did not complete."));
        if (!result.ok) return reject(Object.assign(entitySearchError(result.status || 500, result.code || "ENTITY_SEARCH_FAILED", result.message || "Snapshot entity search failed."),
          result.work ? { work: result.work } : {}, result.choices ? { choices: result.choices, choiceCount: result.choiceCount } : {}));
        if (result.generationId !== snapshot.generationId || result.source !== "snapshot") return reject(entitySearchError(409, "ENTITY_SEARCH_SNAPSHOT_CHANGED", "Snapshot result belongs to another generation."));
        try { ensureCurrent(); } catch (err) { return reject(err); }
        if (performance.now() - started >= remainingMs) return reject(entitySearchError(408, "ENTITY_SEARCH_TIMEOUT", "Snapshot result arrived after its deadline."));
        resolve({ ...result, snapshotId: snapshot.snapshotId, createdAt: snapshot.createdAt });
      });
      child.stdin.write(JSON.stringify({ directory: snapshot.directory, generationId: snapshot.generationId,
        dimensions, body: query, asOf: snapshot.createdAt, remainingMs }) + "\n");
    });
  } finally { active--; }
}
