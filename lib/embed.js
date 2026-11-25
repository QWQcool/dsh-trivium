/** Optional remote (OpenAI-compatible) embeddings. Default off. Failures degrade to zero vectors. */

import { DIM } from "./schema.js";
import { validateDatabaseDimension, zeroVectorFor } from "./database-dimensions.js";

const DEFAULT_MODEL = "text-embedding-3-small";

let config = {
  enabled: false,
  url: "",
  model: DEFAULT_MODEL,
  apiKey: "",
  queryPrefix: "",
  newDatabaseDimensions: DIM,
  requestDimensions: false,
};
let revision = 0;

/** Test hook: (text, { dimensions, query, signal }) => number[] | null. */
let testEmbed = null;

export function configureEmbedding(opts = {}) {
  const url = String(opts.embeddingUrl || process.env.DSH_TRIVIUM_EMBED_URL || "").trim();
  const model = String(opts.embeddingModel || process.env.DSH_TRIVIUM_EMBED_MODEL || DEFAULT_MODEL).trim();
  const apiKey = String(Object.hasOwn(opts, "embeddingApiKey") ? (opts.embeddingApiKey || "") : (
      process.env.DSH_TRIVIUM_EMBED_KEY ||
      process.env.OPENAI_API_KEY ||
      ""
  )).trim();
  const next = {
    enabled: opts.embeddingEnabled === true,
    url,
    model: model || DEFAULT_MODEL,
    apiKey,
    queryPrefix: String(opts.embeddingQueryPrefix || process.env.DSH_TRIVIUM_EMBED_QUERY_PREFIX || "").slice(0, 2048),
    newDatabaseDimensions: Object.hasOwn(opts, "embeddingDimensions") ? opts.embeddingDimensions : DIM,
    requestDimensions: opts.embeddingRequestDimensions === true,
  };
  if (["enabled", "url", "model", "apiKey", "queryPrefix", "requestDimensions"].some(key => next[key] !== config[key])) revision += 1;
  config = next;
}

export function setTestEmbed(fn) {
  if (fn !== testEmbed) revision += 1;
  testEmbed = typeof fn === "function" ? fn : null;
}

export function embeddingRevision() { return revision; }

export function embeddingEnabled() {
  if (testEmbed) return true;
  return config.enabled === true && looksHttpUrl(config.url);
}

export function configuredNewDatabaseDimension() { return validateDatabaseDimension(config.newDatabaseDimensions); }

export function embeddingPublicStatus() {
  let newDimensions = null;
  try { newDimensions = configuredNewDatabaseDimension(); } catch { /* surfaced without exposing arbitrary setting values */ }
  return {
    embeddingEnabled: config.enabled === true,
    embeddingUrl: config.url,
    embeddingModel: config.model || DEFAULT_MODEL,
    embeddingApiKeySet: Boolean(config.apiKey),
    embeddingReady: embeddingEnabled(),
    embeddingQueryPrefix: config.queryPrefix,
    embeddingDimensions: newDimensions,
    embeddingRequestDimensions: config.requestDimensions,
  };
}

export function looksHttpUrl(value) {
  try {
    const u = new URL(String(value || ""));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeVector(vec, dimensions = DIM) {
  if (!Array.isArray(vec) || vec.length !== validateDatabaseDimension(dimensions)
      || !vec.every(n => typeof n === "number" && Number.isFinite(Math.fround(n)))
      || !vec.some(n => Math.fround(n) !== 0)) return null;
  return vec.slice();
}

function rawVectorFromResponse(data) {
  const row = data?.data?.[0] || data?.data || data;
  return row?.embedding || row?.vector || data?.embedding || data?.vector;
}

/** Bounded for JSON-encoded numbers at the database dimension, plus provider metadata. */
export function embeddingResponseByteLimit(dimensions) {
  return Math.max(65536, validateDatabaseDimension(dimensions) * 32 + 4096);
}

/** @returns {Promise<number[]|null>} null means caller should use keyword / zero vector */
export async function embedText(text, {
  query = false, signal, timeoutMs = 15000, dimensions = DIM, maxResponseBytes, onFailure,
} = {}) {
  const width = validateDatabaseDimension(dimensions);
  const body = String(text || "").replace(/\s+/g, " ").trim().slice(0, 8000);
  if (!body || signal?.aborted) return null;
  const settings = config, generation = revision, testProvider = testEmbed;
  const current = () => generation === revision && !signal?.aborted;
  const input = query && settings.queryPrefix ? settings.queryPrefix + body : body;
  const accept = raw => {
    if (!current()) return null;
    if (Array.isArray(raw) && raw.length !== width) onFailure?.({ code: "EMBEDDING_DIMENSION_MISMATCH", expected: width, actual: raw.length });
    return normalizeVector(raw, width);
  };
  if (testProvider) {
    try { return accept(await testProvider(input, { dimensions: width, query, signal })); }
    catch { return null; }
  }
  if (!embeddingEnabled()) return null;
  const byteLimit = Math.min(maxResponseBytes ?? Infinity, embeddingResponseByteLimit(width));
  try {
    const headers = { "content-type": "application/json" };
    if (settings.apiKey) headers.authorization = "Bearer " + settings.apiKey;
    const deadline = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(Math.max(1, Math.min(15000, Math.floor(timeoutMs)))) : undefined;
    const ctrl = signal && deadline ? AbortSignal.any([signal, deadline]) : signal || deadline;
    const resp = await fetch(settings.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: settings.model, input, ...(settings.requestDimensions ? { dimensions: width } : {}) }),
      signal: ctrl,
    });
    if (!resp.ok || !current()) return null;
    let data;
    if (resp.body?.getReader) {
      const reader = resp.body.getReader(), chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > byteLimit || !current()) { await reader.cancel(); return null; }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } else {
      data = await resp.json();
      if (Buffer.byteLength(JSON.stringify(data), "utf8") > byteLimit) return null;
    }
    return accept(rawVectorFromResponse(data));
  } catch {
    return null;
  }
}

export function zeroOr(vec, dimensions = DIM) {
  return normalizeVector(vec, dimensions) || zeroVectorFor(dimensions);
}
