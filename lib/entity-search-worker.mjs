/** One immutable source per worker; embedding is brokered by the host. */
import engine from "triviumdb";
import { join } from "node:path";
import { searchEntity, entitySearchError } from "./entity-search.js";

const controller = new AbortController();
let buffered = "", inputBytes = 0, initial, embeddingReply, started = false, db, timer;
const pending = new Promise(resolve => { initial = resolve; });
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const failInput = () => { controller.abort(); embeddingReply?.reject(entitySearchError(499, "ENTITY_SEARCH_CANCELLED", "Worker input closed.")); initial?.(null); };
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  inputBytes += Buffer.byteLength(chunk);
  buffered += chunk;
  if (inputBytes > 131072 || Buffer.byteLength(buffered) > 65536) { failInput(); return; }
  let at;
  while ((at = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
    let value;
    try { value = JSON.parse(line); } catch { failInput(); return; }
    if (!started) { started = true; initial(value); }
    else if (value.type === "embedding-result" && embeddingReply) { embeddingReply.resolve(value.value); embeddingReply = null; }
    else { failInput(); return; }
  }
});
process.stdin.on("end", failInput);
process.stdin.on("error", failInput);
try {
  const request = await pending;
  if (!request || controller.signal.aborted) throw entitySearchError(499, "ENTITY_SEARCH_CANCELLED", "Worker input unavailable.");
  timer = setTimeout(() => controller.abort(), request.remainingMs);
  const { TriviumDB, ResourceRuntime, verifySnapshot } = engine;
  const runtime = new ResourceRuntime({ memoryLimitMb: 256, maxThreads: 2, maxActiveTasks: 1 });
  const manifest = verifySnapshot(request.directory, runtime);
  if (manifest.generation_id !== request.generationId) throw entitySearchError(409, "ENTITY_SEARCH_SNAPSHOT_CHANGED", "Snapshot generation does not match its publication.");
  db = new TriviumDB(join(request.directory, "database.tdb"), { dim: manifest.dim,
    dtype: manifest.dtype === "half::binary16::f16" ? "f16" : manifest.dtype, accessMode: "immutable",
    autoBuildQuiver: false, maxQueryRows: 1000, rowOverflow: "throw", runtime, memoryLimitMb: 128, payloadCacheMb: 16 });
  const result = await searchEntity(db, request.body, { source: "snapshot", asOf: request.asOf,
    remainingMs: request.remainingMs, signal: controller.signal,
    embedding: (query, context) => new Promise((resolve, reject) => {
      const abort = () => reject(entitySearchError(499, "ENTITY_SEARCH_CANCELLED", "Worker request cancelled."));
      context.signal.addEventListener("abort", abort, { once: true });
      embeddingReply = { resolve: value => { context.signal.removeEventListener("abort", abort); resolve(value); },
        reject: error => { context.signal.removeEventListener("abort", abort); reject(error); } };
      emit({ type: "embedding", query, timeoutMs: context.timeoutMs });
    }) });
  emit({ type: "result", value: { ...result, generationId: manifest.generation_id } });
} catch (error) {
  emit({ type: "result", value: { ok: false, status: error.status || 409,
    code: String(error.code || "ENTITY_SEARCH_SNAPSHOT_FAILED"),
    message: String(error.code || "").startsWith("ENTITY_SEARCH_") ? error.message : "The snapshot could not be verified or read.",
    ...(error.work ? { work: error.work } : {}) } });
} finally {
  clearTimeout(timer); try { db?.close(); } catch {}
  process.stdin.destroy();
}
