// Only this negotiated option is retried. Never put provider text in diagnostics.
const UNSUPPORTED = "UNSUPPORTED_REASONING_EFFORT";
const unsupportedOff = /^provider "[^"\r\n]{1,120}" model "[^"\r\n]{1,200}" does not support reasoning effort "off"[.!]?$/i;
const cancelled = /^(?:ABORT(?:ED|_ERR)|ERR_CANCELED|CANCELLED|CANCELED|REQUEST_ABORTED|PROVIDER_ABORTED)$/;
const deadline = /^(?:TIMEOUT|TIMEOUT_ERROR|ETIMEDOUT|DEADLINE_EXCEEDED|REQUEST_TIMEOUT|PROVIDER_TIMEOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/;
const rate = /^(?:RATE_LIMIT(?:ED|_EXCEEDED)?|PROVIDER_RATE_LIMIT(?:ED)?|TOO_MANY_REQUESTS|ACCOUNT_QUOTA_EXCEEDED|QUOTA_EXCEEDED)$/;
const transport = /^(?:NETWORK(?:_ERROR|_FAILURE)?|PROVIDER_NETWORK_ERROR|CONNECTION_ERROR|TRANSPORT(?:_ERROR)?|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|ERR_NETWORK|UND_ERR_[A-Z_]+)$/;

function failureObjects(error) {
  const seen = new Set();
  const pending = [error];
  while (pending.length && seen.size < 8) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    pending.push(item.failure, item.cause, item.error);
  }
  return [...seen];
}

function codeOf(failure) {
  return typeof failure.code === "string" ? failure.code.toUpperCase() : "";
}

function statusOf(failure) {
  const result = failure.status ?? failure.statusCode ?? failure.response?.status;
  return typeof result === "number" || (typeof result === "string" && /^\d{3}$/.test(result))
    ? Number(result) : 0;
}

export function describeExtractProviderFailure(error) {
  const details = failureObjects(error);
  if (details.some(e => e.name === "AbortError" || e.extractFinish === "aborted" || cancelled.test(codeOf(e)) || statusOf(e) === 499)) {
    return { code: "EXTRACT_CANCELLED", message: "The extraction request was cancelled." };
  }
  if (details.some(e => e.name === "TimeoutError" || deadline.test(codeOf(e)) || [408, 504].includes(statusOf(e)))) {
    return { code: "EXTRACT_TIMEOUT", message: "The extraction request timed out." };
  }
  if (details.some(e => rate.test(codeOf(e)) || statusOf(e) === 429 || Number.isFinite(e.providerRetryAfterMs))) {
    return { code: "EXTRACT_RATE_LIMITED", message: "The extraction provider rate-limited the request." };
  }
  if (details.some(e => transport.test(codeOf(e)) || e.name === "NetworkError"
    || (typeof e.message === "string" && /^(?:fetch failed|network error|failed to fetch)$/i.test(e.message)))) {
    return { code: "EXTRACT_NETWORK_ERROR", message: "Could not reach the extraction provider." };
  }
  const incompatibleEffort = details.some(e => [e.reasoningEffort, e.effort, e.details?.reasoningEffort, e.details?.effort]
    .some(value => typeof value === "string" && value !== "off"));
  const hardStatus = details.some(e => [401, 403, 404].includes(statusOf(e)) || statusOf(e) >= 500);
  if (!incompatibleEffort && !hardStatus && details.some(e => codeOf(e) === UNSUPPORTED
    || (typeof e.message === "string" && unsupportedOff.test(e.message.trim())))) {
    return { code: UNSUPPORTED, message: 'The extraction provider does not support reasoning effort "off".' };
  }
  if (details.some(e => codeOf(e) === "EXTRACT_EMPTY_RESPONSE")) {
    return { code: "EXTRACT_EMPTY_RESPONSE", message: "The extraction provider returned no text." };
  }
  return { code: "EXTRACT_PROVIDER_ERROR", message: "The extraction provider failed." };
}

export function hasExtractionStreamContent(chunk) {
  switch (chunk?.type) {
    case "text-delta":
    case "reasoning-delta":
      return typeof chunk.text === "string" && chunk.text.length > 0;
    case "tool-call-delta":
      return true;
    case "block-start":
      return !["text", "reasoning"].includes(chunk.blockType);
    case "block-end":
      return !!chunk.block && (!["text", "reasoning"].includes(chunk.block.type)
        || (typeof chunk.block.text === "string" && chunk.block.text.length > 0));
    default:
      return false;
  }
}
