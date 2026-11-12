/** Optional remote (OpenAI-compatible) embeddings. Default off. Failures degrade to zero vectors. */

import { DIM, zeroVector } from "./schema.js";

const DEFAULT_MODEL = "text-embedding-3-small";

let config = {
  enabled: false,
  url: "",
  model: DEFAULT_MODEL,
  apiKey: "",
  queryPrefix: "",
};
let revision = 0;

/** Test hook. `(text) => number[] | null` */
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
  };
  if (JSON.stringify(next) !== JSON.stringify(config)) revision += 1;
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

export function embeddingPublicStatus() {
  return {
    embeddingEnabled: config.enabled === true,
    embeddingUrl: config.url,
    embeddingModel: config.model || DEFAULT_MODEL,
    embeddingApiKeySet: Boolean(config.apiKey),
    embeddingReady: embeddingEnabled(),
    embeddingQueryPrefix: config.queryPrefix,
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

export function normalizeVector(vec) {
  if (!Array.isArray(vec) || vec.length !== DIM
      || !vec.every((n) => typeof n === "number" && Number.isFinite(n))
      || !vec.some((n) => n !== 0)) return null;
  return vec.slice();
}

function vectorFromResponse(data) {
  const row = data?.data?.[0] || data?.data || data;
  const raw = row?.embedding || row?.vector || data?.embedding || data?.vector;
  return normalizeVector(raw);
}

/** @returns {Promise<number[]|null>} null means caller should use keyword / zero vector */
export async function embedText(text, { query = false } = {}) {
  const body = String(text || "").replace(/\s+/g, " ").trim().slice(0, 8000);
  if (!body) return null;
  const input = query && config.queryPrefix ? config.queryPrefix + body : body;
  if (testEmbed) {
    try {
      return normalizeVector(await testEmbed(input));
    } catch {
      return null;
    }
  }
  if (!embeddingEnabled()) return null;
  try {
    const headers = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const ctrl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
    const resp = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.model, input }),
      signal: ctrl,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return vectorFromResponse(data);
  } catch {
    return null;
  }
}

export function zeroOr(vec) {
  return Array.isArray(vec) && vec.length === DIM ? vec : zeroVector();
}
