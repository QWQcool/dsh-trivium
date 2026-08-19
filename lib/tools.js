import { defineTool } from "@deepseek-ai/dsh-tools";
import { EDGE_LABELS, looksSecret, weightOf } from "./schema.js";
import {
  dbPathFor,
  findMergeTarget,
  formatHit,
  insertNode,
  mergeInto,
  openWorkspaceDb,
  searchNodes,
} from "./store.js";

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

export function registerTools(ctx, options) {
  const topK = options.topK ?? 8;
  const expandDepth = options.expandDepth ?? 1;
  const writeApproval = options.writeApproval === true;

  ctx.effect(
    () =>
      ctx.tools.register(
        textTool({
          name: "ctx_find",
          description:
            "Search local Trivium graph memory. Returns L0 summaries plus edge paths. Call ctx_read for full text. Do not paste find results verbatim into later thinking.",
          parameters: {
            query: { type: "string", required: true, description: "Search query." },
            top_k: { type: "integer", description: "Max hits, 1-20." },
          },
          async execute(args, exec) {
            try {
              const db = await dbOf(exec);
              const k = Math.max(1, Math.min(20, args.top_k || topK));
              const hits = searchNodes(db, args.query, { topK: k, expandDepth });
              if (!hits.length) return "No memory hits.";
              const grouped = [];
              let lastType = "";
              for (const hit of hits) {
                const row = formatHit(db, hit);
                if (row.type !== lastType) {
                  grouped.push(`## ${row.type}`);
                  lastType = row.type;
                }
                grouped.push(
                  `[${row.score.toFixed(3)}] id=${row.id} type=${row.type}${row.until ? ` until=${row.until}` : ""}${row.stale ? " stale" : ""}\n${row.l0}\npath: ${row.path.join(" | ") || "(none)"}`,
                );
              }
              return grouped.join("\n\n");
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
          name: "ctx_read",
          description: "Read one memory node by numeric id returned from ctx_find.",
          parameters: {
            id: { type: "integer", required: true, description: "Node id." },
          },
          async execute(args, exec) {
            try {
              const db = await dbOf(exec);
              const node = db.get(Number(args.id));
              if (!node) return `Not found: ${args.id}`;
              return JSON.stringify(
                {
                  id: node.id,
                  payload: node.payload,
                  edges: node.edges,
                },
                null,
                2,
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
            link_to: { type: "integer", description: "Optional existing node id to link." },
            link_label: { type: "string", description: "Edge label when link_to is set." },
          },
          async execute(args, exec) {
            try {
              if (looksSecret(args.text)) return "Refused: looks like a secret.";
              const type = ["entity", "preference", "decision", "experience"].includes(
                args.type,
              )
                ? args.type
                : "preference";
              const db = await dbOf(exec);
              const incoming = {
                type,
                name: args.name || undefined,
                text: args.text,
                uri: `ctx://${type}/${Date.now()}`,
                source: { sessionId: String(exec?.agent?.session?.header?.id || exec?.agent?.id || "") },
              };
              const existing = findMergeTarget(db, incoming);
              const id =
                existing != null ? mergeInto(db, existing, incoming) : insertNode(db, incoming);
              if (args.link_to) {
                const label = args.link_label || EDGE_LABELS.about;
                db.link(id, Number(args.link_to), label, weightOf(label));
                db.flush();
              }
              return `Remembered id=${id} type=${type} db=${dbPathFor(cwdOf(exec))}`;
            } catch (err) {
              return `ctx_remember failed: ${err.message}`;
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
          name: "ctx_link",
          description: "Create a directed edge between two memory node ids.",
          parameters: {
            from: { type: "integer", required: true, description: "Source node id." },
            to: { type: "integer", required: true, description: "Target node id." },
            label: { type: "string", description: "Edge label, default about." },
          },
          async execute(args, exec) {
            try {
              const db = await dbOf(exec);
              const label = args.label || EDGE_LABELS.about;
              db.link(Number(args.from), Number(args.to), label, weightOf(label));
              db.flush();
              return `Linked ${args.from} -[${label}]-> ${args.to}`;
            } catch (err) {
              return `ctx_link failed: ${err.message}`;
            }
          },
        }),
      ),
    "dsh-trivium.ctx_link",
  );

  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!writeApproval || !WRITE_TOOLS.has(exec.name)) return next();
    return {
      kind: "ask",
      reason: `dsh-trivium wants to persist ${exec.name}`,
    };
  });
}
