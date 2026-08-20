/** Optional remote (OpenAI-compatible) embeddings. Default off. Failures degrade to zero vectors. */

import { DIM, zeroVector } from "./schema.js";

const DEFAULT_MODEL = "text-embedding-3-small";

let config = {
  enabled: false,
  url: "",
  model: DEFAULT_MODEL,
  apiKey: "",
};

/** Test hook. `(text) => number[] | null` */
let testEmbed = null;

export function configureEmbedding(opts = {}) {
  const url = String(opts.embeddingUrl || process.env.DSH_TRIVIUM_EMBED_URL || "").trim();
  const model = String(opts.embeddingModel || process.env.DSH_TRIVIUM_EMBED_MODEL || DEFAULT_MODEL).trim();
  const apiKey = String(
    opts.embeddingApiKey ||
      process.env.DSH_TRIVIUM_EMBED_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.OPENAI_API_KEY ||
      "",
  ).trim();
  config = {
    enabled: opts.embeddingEnabled === true,
    url,
    model: model || DEFAULT_MODEL,
    apiKey,
  };
}

export function setTestEmbed(fn) {
  testEmbed = typeof fn === "function" ? fn : null;
}

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
  if (!Array.isArray(vec) || !vec.length) return null;
  const out = [];
  for (let i = 0; i < DIM; i += 1) {
    const n = Number(vec[i]);
    out.push(Number.isFinite(n) ? n : 0);
  }
  return out;
}

function vectorFromResponse(data) {
  const row = data?.data?.[0] || data?.data || data;
  const raw = row?.embedding || row?.vector || data?.embedding || data?.vector;
  return normalizeVector(raw);
}

/** @returns {Promise<number[]|null>} null means caller should use keyword / zero vector */
export async function embedText(text) {
  const input = String(text || "").replace(/\s+/g, " ").trim().slice(0, 8000);
  if (!input) return null;
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

export function dshApiCredentials() {
  const apiKey = String(
    process.env.DEEPSEEK_API_KEY ||
      process.env.DSH_TRIVIUM_EMBED_KEY ||
      process.env.OPENAI_API_KEY ||
      "",
  ).trim();
  const base = String(
    process.env.DEEPSEEK_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      "https://api.deepseek.com",
  )
    .trim()
    .replace(/\/$/, "");
  return { apiKey, base };
}

export function embeddingsUrlsFromBase(base) {
  const root = String(base || "").replace(/\/$/, "");
  if (!root) return [];
  const urls = [];
  const add = (u) => {
    if (looksHttpUrl(u) && !urls.includes(u)) urls.push(u);
  };
  if (/\/embeddings$/i.test(root)) add(root);
  add(`${root}/embeddings`);
  add(`${root}/v1/embeddings`);
  if (/\/v1$/i.test(root)) add(`${root}/embeddings`);
  else add(`${root.replace(/\/v1$/i, "")}/embeddings`);
  return urls;
}

async function fetchEmbeddingVector({ url, apiKey, model, text }) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const ctrl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: text }),
    signal: ctrl,
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const raw = data?.data?.[0]?.embedding || data?.data?.[0]?.vector || data?.embedding;
  if (!Array.isArray(raw) || !raw.length) return null;
  return raw;
}

/**
 * Fill URL/key from DSH's DeepSeek env and probe whether that host actually
 * serves embeddings. Official api.deepseek.com is chat-only today.
 */
export async function detectDshEmbedding() {
  const { apiKey, base } = dshApiCredentials();
  if (!apiKey) {
    return {
      ok: false,
      foundKey: false,
      probed: false,
      message: "没找到 DSH 正在用的 DeepSeek 密钥。请确认已经设置 DEEPSEEK_API_KEY，或在下面手动填写。",
    };
  }
  const urls = embeddingsUrlsFromBase(base);
  const models = ["text-embedding-3-small", "text-embedding-v3", "embedding"];
  for (const url of urls) {
    for (const model of models) {
      try {
        const raw = await fetchEmbeddingVector({ url, apiKey, model, text: "trivium" });
        if (!raw) continue;
        const dim = raw.length;
        return {
          ok: true,
          foundKey: true,
          probed: true,
          embeddingEnabled: true,
          embeddingUrl: url,
          embeddingModel: model,
          embeddingDim: dim,
          dimOk: dim === DIM,
          message:
            dim === DIM
              ? "已用 DSH 的 DeepSeek 配置接通向量接口。"
              : `接通了向量接口，但返回 ${dim} 维，本库按 ${DIM} 维存储，效果可能变差。`,
        };
      } catch {
        // try next pair
      }
    }
  }
  return {
    ok: false,
    foundKey: true,
    probed: false,
    embeddingEnabled: false,
    embeddingUrl: urls[0] || `${base}/embeddings`,
    embeddingModel: DEFAULT_MODEL,
    message:
      "找到了 DSH 的 DeepSeek 密钥，但这个地址没有向量服务。官方 DeepSeek 目前只提供对话，不能生成记忆用的向量。密钥已填好；若你用的是带向量功能的中转，改一下地址后再打开。",
  };
}
