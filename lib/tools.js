import { defineTool } from "@deepseek-ai/dsh-tools";
import { EDGE_LABELS } from "./schema.js";
import { sanitizeForWrite, writeGateMessage } from "./hygiene.js";
import { TOOL_DEFS } from "./tool-defs.js";
import { makeRevisionResolver, refuseModelRevisionLabel } from "./revisions.js";
import { CTX_FIND_OUTPUT_BUDGET, packTextBlocks, projectPayloadForTool } from "./tool-output.js";
import {
  dbPathFor,
  describeDbFailure,
  embedQueryVector,
  findMergeTarget,
  formatHit,
  insertNode,
  listIncomingBusiness,
  mergeInto,
  openWorkspaceDb,
  searchNodes,
  ensureLink,
} from "./store.js";
import { withWorkspaceLock } from "./workspace-lock.js";

const WRITE_TOOLS = new Set(["ctx_remember", "ctx_link"]);

const TEXT_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }],
};

function textTool(definition) {
  const write = WRITE_TOOLS.has(definition.name);
  return defineTool({
    ...definition,
    output: TEXT_OUTPUT,
    isConcurrencySafe: write ? () => false : () => true,
    presentCall: (args) => ({
      card: "generic",
      kind: write ? "edit" : definition.name === "ctx_find" ? "search" : "read",
      title: definition.name,
      rawInput: args,
    }),
  });
}

/** Definition lookup by name; the array order is the registration order. */
function defOf(name) {
  return TOOL_DEFS.find((def) => def.name === name);
}

export function cwdOf(agentOrExec) {
  const agent = agentOrExec?.agent ?? agentOrExec;
  return (
    agent?.session?.header?.cwd ||
    process.env.DSH_CWD ||
    process.cwd()
  );
}

async function dbOf(exec) {
  return openWorkspaceDb(cwdOf(exec));
}

async function guardedWrite(exec, name, fn) {
  const guarded = await withWorkspaceLock(cwdOf(exec), fn);
  if (guarded.locked) return `${name} unavailable: workspace write busy; retry after the other operation finishes.`;
  return guarded.value;
}

function toolFailure(name, err) {
  const lock = describeDbFailure(err);
  return lock ? `${name} unavailable: ${lock.message}` : `${name} failed: ${err.message}`;
}

export function registerTools(ctx, optionsOrFn) {
  const optionsOf = typeof optionsOrFn === "function" ? optionsOrFn : () => optionsOrFn || {};
  const writeApprovalOf = () => optionsOf().writeApproval === true;

  ctx.effect(
    () =>
      ctx.tools.register(
        textTool({
          ...defOf("ctx_find"),
          async execute(args, exec) {
            try {
              const options = optionsOf();
              const db = await dbOf(exec);
              const k = Math.max(1, Math.min(20, args.top_k || options.topK || 8));
              const queryVector = await embedQueryVector(args.query);
              const hits = searchNodes(db, args.query, {
                topK: k,
                expandDepth: options.expandDepth ?? 1,
                queryVector: queryVector || undefined,
                // `include_stale` stays a deadline-only switch: revision history
                // is a separate axis and is never expanded by this flag.
                includeStale: args.include_stale !== false,
              });
              if (!hits.length) return "No memory hits.";
              /*
               * A keyword hit on an old version is answered with the current
               * head: mapped, de-duplicated, and carrying one short pointer so
               * the model knows a newer decision exists. The old body stays
               * readable through ctx_read(id).
               */
              const resolveCurrent = makeRevisionResolver(db);
              const seen = new Set();
              const blocks = [];
              for (const hit of hits) {
                const row = formatHit(db, hit, { includeWorkspace: false });
                const resolved = resolveCurrent(row.id);
                if (!resolved) continue;
                const targetId = Number(resolved.currentId);
                const remapped = targetId !== row.id;
                // A superseded chain whose head is archived or expired is not
                // resurrected as its old version either.
                if (remapped && (resolved.archived || resolved.stale)) continue;
                if (seen.has(targetId)) continue;
                seen.add(targetId);
                /*
                 * Same projection as automatic recall: id, body, deadline and
                 * state come from the node that will be shown. Only the search
                 * score (and the path, for an unmapped hit) belongs to the
                 * candidate. Swapping only the id was REVIEW P1-2.
                 */
                const pointer = remapped ? `\nmatched_history=#${row.id} → current=#${targetId}` : "";
                const path = remapped ? [] : row.path;
                blocks.push(
                  `[${row.score.toFixed(3)}] id=${targetId} type=${resolved.type}${resolved.until ? ` until=${resolved.until}` : ""}${resolved.stale ? " stale" : ""}\n${resolved.l0}${path.length ? `\npath: ${path.slice(0, 2).join(" | ")}` : ""}${pointer}`,
                );
              }
              if (!blocks.length) return "No memory hits.";
              const packed = packTextBlocks(blocks, { budget: CTX_FIND_OUTPUT_BUDGET });
              return packed.text;
            } catch (err) {
              return `ctx_find unavailable: ${err.message}`;
            }
          },
        }),
      ),
    "dsh-trivium.ctx_find",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        textTool({
          ...defOf("ctx_read"),
          async execute(args, exec) {
            try {
              const db = await dbOf(exec);
              const node = db.get(Number(args.id));
              if (!node) return `Not found: ${args.id}`;
              /*
               * Explicit full read: the body is never truncated. Only the
               * payload projection is narrowed, so provenance/revision metadata
               * cannot grow this result. Sources and history are read from the
               * management UI.
               */
              return JSON.stringify(
                {
                  id: node.id,
                  payload: projectPayloadForTool(node.payload),
                  edges: node.edges,
                  incoming: listIncomingBusiness(db, node.id),
                },
              );
            } catch (err) {
              return `ctx_read unavailable: ${err.message}`;
            }
          },
        }),
      ),
    "dsh-trivium.ctx_read",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        textTool({
          ...defOf("ctx_remember"),
          async execute(args, exec) {
            try {
              const gate = sanitizeForWrite(args.text);
              if (!gate.ok) return writeGateMessage(gate.reason);
              if (args.link_to) {
                const refused = refuseModelRevisionLabel(args.link_label || EDGE_LABELS.about);
                if (refused) return refused;
              }
              const type = ["entity", "preference", "decision", "experience"].includes(
                args.type,
              )
                ? args.type
                : "preference";
              return await guardedWrite(exec, "ctx_remember", async () => {
                const db = await dbOf(exec);
                const incoming = {
                  type,
                  name: args.name || undefined,
                  text: args.text,
                  ...(args.until !== undefined ? { until: args.until } : {}),
                  uri: `ctx://${type}/${Date.now()}`,
                  source: {
                    kind: "tool",
                    sessionId: String(exec?.agent?.session?.header?.id || exec?.agent?.id || ""),
                  },
                };
                const existing = findMergeTarget(db, incoming);
                const id =
                  existing != null ? mergeInto(db, existing, incoming) : insertNode(db, incoming);
                if (args.link_to) {
                  const label = args.link_label || EDGE_LABELS.about;
                  ensureLink(db, id, Number(args.link_to), label);
                }
                return `Remembered id=${id} type=${type} db=${dbPathFor(cwdOf(exec))}`;
              });
            } catch (err) {
              return toolFailure("ctx_remember", err);
            }
          },
        }),
      ),
    "dsh-trivium.ctx_remember",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        textTool({
          ...defOf("ctx_link"),
          async execute(args, exec) {
            try {
              const label = args.label || EDGE_LABELS.about;
              // Revision relations are confirmed in the management UI only, so
              // a model cannot invent a supersedes chain here.
              const refused = refuseModelRevisionLabel(label);
              if (refused) return refused;
              return await guardedWrite(exec, "ctx_link", async () => {
                const db = await dbOf(exec);
                ensureLink(db, Number(args.from), Number(args.to), label);
                return `Linked ${args.from} -[${label}]-> ${args.to}`;
              });
            } catch (err) {
              return toolFailure("ctx_link", err);
            }
          },
        }),
      ),
    "dsh-trivium.ctx_link",
  );

  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!writeApprovalOf() || !WRITE_TOOLS.has(exec.name)) return next();
    return {
      kind: "ask",
      reason: `dsh-trivium wants to persist ${exec.name}`,
    };
  });
}
