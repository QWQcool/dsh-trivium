import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { cwdOf, registerTools } from "./tools.js";
import { buildShortMap, closeAll, openWorkspaceDb } from "./store.js";

export const name = "dsh-trivium";
export const inject = ["tools"];

const DEFAULTS = {
  autoRecall: false,
  writeApproval: false,
  mapTokenBudget: 400,
  expandDepth: 1,
  topK: 8,
};

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...config };
  const log = ctx.logger?.("dsh-trivium") ?? console;

  registerTools(ctx, options);

  ctx.on("agent/session-start", async ({ agent }) => {
    try {
      const cwd = cwdOf(agent);
      const db = await openWorkspaceDb(cwd);
      const chars = Math.max(200, (options.mapTokenBudget || 400) * 4);
      const text = buildShortMap(db, chars);
      agent.inject(
        createUserMessage({
          content: [{ type: "text", text }],
          source: {
            kind: "plugin",
            plugin: "dsh-trivium",
            form: "snapshot",
            sections: [{ name: "dsh-trivium", text }],
          },
        }),
      );
    } catch (err) {
      log.warn?.(`[dsh-trivium] session-start skipped: ${err.message}`);
    }
  });

  ctx.effect(() => () => {
    closeAll();
  });
}
