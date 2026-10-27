/**
 * The four tool definitions, kept as plain data with no @deepseek-ai imports.
 *
 * Two reasons this is a separate module:
 * - the offline suite can serialise the exact registered projection and compare
 *   it against docs/next-memory/TOOL_SCHEMA_BASELINE.json, and
 * - the contract is "no new tools, no new model-facing parameters", which is
 *   easier to audit when the surface is one frozen array.
 *
 * Source/history/supersede details are read through the management UI, never
 * through new tool parameters.
 */

import { estimateTokens } from "./tokens.js";

export const TOOL_DEFS = Object.freeze([
  {
    name: "ctx_find",
    description:
      "Search local Trivium graph memory by keywords, meaning (when embeddings are enabled), and entity relationships. Relevant expired decisions remain searchable, marked stale and ranked lower; treat them as historical, not current instructions. Set include_stale=false for current facts only. Returns L0 summaries and edge paths. Call ctx_read for full text.",
    parameters: {
      query: { type: "string", required: true, description: "Search query." },
      top_k: { type: "integer", description: "Max hits, 1-20." },
      include_stale: {
        type: "boolean",
        description: "Include relevant expired memories (default true). Expired hits are marked stale.",
      },
    },
  },
  {
    name: "ctx_read",
    description:
      "Read one memory node by numeric id returned from ctx_find. Includes incoming about/decided/broke/fixed edges.",
    parameters: {
      id: { type: "integer", required: true, description: "Node id." },
    },
  },
  {
    name: "ctx_remember",
    description:
      "Store a durable fact as an entity, preference, decision, or experience. Do not store secrets or one-off task instructions.",
    parameters: {
      text: { type: "string", required: true, description: "Fact to store." },
      type: {
        type: "string",
        description: "entity | preference | decision | experience",
      },
      name: { type: "string", description: "Short name for entities." },
      until: {
        type: "string",
        description:
          "Optional explicit expiry, only when the user states this fact expires: YYYY-MM-DD, weekday (Friday / 周五), or 下周. A date mentioned in the fact is not an expiry.",
      },
      link_to: { type: "integer", description: "Optional existing node id to link." },
      link_label: { type: "string", description: "Edge label when link_to is set." },
    },
  },
  {
    name: "ctx_link",
    description: "Create a directed edge between two memory node ids.",
    parameters: {
      from: { type: "integer", required: true, description: "Source node id." },
      to: { type: "integer", required: true, description: "Target node id." },
      label: { type: "string", description: "Edge label, default about." },
    },
  },
]);

/**
 * Canonical name/description/parameters projection, in declaration order.
 *
 * This is the same shape as TOOL_SCHEMA_BASELINE.json: parameters is an object
 * schema, and `required` collapses the per-parameter `required: true` flags.
 * It is a relative size check, not the host wire format.
 */
export function schemaProjection(defs = TOOL_DEFS) {
  return defs.map((def) => {
    const properties = {};
    const required = [];
    for (const [key, spec] of Object.entries(def.parameters || {})) {
      properties[key] = { type: spec.type, description: spec.description };
      if (spec.required === true) required.push(key);
    }
    const parameters = { type: "object", properties };
    if (required.length) parameters.required = required;
    return { name: def.name, description: def.description, parameters };
  });
}

/** Estimated tokens for the whole projection, using the plugin's own heuristic. */
export function estimatedSchemaTokens(defs = TOOL_DEFS) {
  return estimateTokens(JSON.stringify(schemaProjection(defs)));
}
