/**
 * Tool output budgets.
 *
 * `ctx_find` used to return whatever the search produced. Model context is the
 * scarce resource, so the default output is now capped and whole records are
 * dropped when they do not fit — never sliced, so an id is never half-written.
 *
 * All numbers are `estimateTokens` results (CJK ≈ 1, ASCII ≈ 1/4) and must be
 * presented as estimates, not model tokens or billing.
 */

import { estimateTokens } from "./tokens.js";

/** Default total for one ctx_find call, truncation notice included. */
export const CTX_FIND_OUTPUT_BUDGET = 1200;

/** Payload keys ctx_read may echo. New provenance/trace fields stay out. */
export const CTX_READ_PAYLOAD_KEYS = Object.freeze([
  "type",
  "name",
  "text",
  "until",
  "untilAt",
  "status",
  "uri",
  "aliases",
  "fail",
  "fix",
  "createdAt",
  "updatedAt",
]);

/**
 * Project a payload for tool output.
 *
 * The node payload also carries provenance, revision chains and other UI-only
 * metadata. Serialising the payload wholesale made ctx_read grow every time a
 * UI feature added a field, so the default projection is an explicit allowlist.
 * `source` keeps only the session id it had before this change.
 */
export function projectPayloadForTool(payload) {
  const out = {};
  for (const key of CTX_READ_PAYLOAD_KEYS) {
    const value = payload?.[key];
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  const sessionId = payload?.source?.sessionId;
  if (sessionId) out.source = { sessionId: String(sessionId) };
  return out;
}

function defaultNotice(omitted) {
  return `… ${omitted} more hit(s) omitted to keep this result within ~${CTX_FIND_OUTPUT_BUDGET} estimated tokens. Narrow the query or raise top_k.`;
}

/**
 * Keep whole blocks while the rendered result, notice included, fits the budget.
 *
 * @returns text, how many blocks were kept, how many were omitted, estimate.
 */
export function packTextBlocks(blocks, { budget = CTX_FIND_OUTPUT_BUDGET, separator = "\n\n", noticeFor = defaultNotice } = {}) {
  const list = (blocks || []).filter((block) => typeof block === "string" && block.length > 0);
  if (!list.length) return { text: "", kept: 0, omitted: 0, tokens: 0, budget, truncated: false };
  const notice = (omitted) => (typeof noticeFor === "function" ? noticeFor(omitted) : defaultNotice(omitted));
  const kept = [];
  for (let i = 0; i < list.length; i += 1) {
    const attempt = [...kept, list[i]];
    const rest = list.length - attempt.length;
    const text = rest > 0 ? [...attempt, notice(rest)].join(separator) : attempt.join(separator);
    if (estimateTokens(text) <= budget) {
      kept.push(list[i]);
      continue;
    }
    const omitted = list.length - i;
    const rendered = [...kept, notice(omitted)].join(separator);
    return {
      text: rendered,
      kept: kept.length,
      omitted,
      tokens: estimateTokens(rendered),
      budget,
      truncated: true,
    };
  }
  const text = kept.join(separator);
  return { text, kept: kept.length, omitted: 0, tokens: estimateTokens(text), budget, truncated: false };
}
