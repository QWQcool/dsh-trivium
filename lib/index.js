import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { cwdOf, registerTools } from "./tools.js";
import {
  buildShortMapReport,
  closeAll,
  formatHit,
  namedRecallHits,
  openWorkspaceDb,
  searchNodes,
  setActiveCwd,
  embedQueryVector,
} from "./store.js";
import { clipToTokenBudget } from "./tokens.js";
import { clip } from "./schema.js";
import {
  clearPending,
  distill,
  loadPending,
  savePending,
  textFromContent,
} from "./extract.js";
import { readUiSettings, registerMemoryApi } from "./server.js";
import { applyRecallMode, chipsEnabledOf, recallModeOf, sessionLayerEnabledOf } from "./settings.js";
import { configureEmbedding } from "./embed.js";
import { recordCheckpoint, ensureTail, syncForkLineage } from "./episode.js";
import { buildPinInject } from "./pins.js";

export const name = "dsh-trivium";
export const inject = ["tools"];

const DEFAULTS = {
  autoRecall: false,
  anchorRecall: false,
  recallMode: "off",
  extractEnabled: true,
  chipsEnabled: false,
  sessionLayerEnabled: false,
  writeApproval: false,
  mapTokenBudget: 400,
  expandDepth: 1,
  topK: 8,
  embeddingEnabled: false,
  embeddingUrl: "",
  embeddingModel: "text-embedding-3-small",
};

const buffers = new Map();
const idleTimers = new Map();
const mapInjected = new Set();
const status = {
  lastInjectTokens: 0,
  lastInjectAt: null,
  lastExtract: null,
};

function liveOptions(config) {
  const merged = { ...DEFAULTS, ...config, ...readUiSettings() };
  applyRecallMode(merged, recallModeOf(merged));
  configureEmbedding(merged);
  return merged;
}

function sessionKey(session) {
  return String(session?.id || session?.header?.id || "");
}

function bufOf(session) {
  const id = sessionKey(session);
  if (!buffers.has(id)) {
    buffers.set(id, {
      sessionId: id,
      cwd: session?.header?.cwd || "",
      turns: [],
      calls: Object.create(null),
      dirty: false,
    });
  }
  const buf = buffers.get(id);
  if (session?.header?.cwd) buf.cwd = session.header.cwd;
  return buf;
}

function clearIdle(id) {
  const timer = idleTimers.get(id);
  if (timer) clearTimeout(timer);
  idleTimers.delete(id);
}

function resolveLlmTarget(session, agent) {
  const header = typeof session?.requestHeader === "function" ? session.requestHeader() : null;
  const cfg = header?.config;
  if (cfg?.provider && cfg?.model) return { provider: cfg.provider, model: cfg.model };
  if (agent?.options?.provider && agent?.options?.model) {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  return null;
}

function makeLlmCall(ctx, session, agent) {
  if (!ctx.llm) return null;
  const target = resolveLlmTarget(session, agent);
  if (!target) return null;
  return async (prompt) => {
    const assembler = new BlockAssembler();
    const options = {
      provider: target.provider,
      model: target.model,
      maxTokens: 400,
      sessionId: session?.id,
      messages: [
        createUserMessage({
          content: [{ type: "text", text: prompt }],
          source: { kind: "plugin", plugin: "dsh-trivium" },
        }),
      ],
    };
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
    const finish = assembler.finish;
    if (finish?.kind === "error" || finish?.kind === "aborted") {
      throw new Error(finish.failure?.message || finish.kind);
    }
    return (assembler.blocks() || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  };
}

async function runExtract(ctx, { cwd, turns, sessionId, session, agent, log, options, reason }) {
  if (options.extractEnabled === false) return;
  if (!cwd || !turns?.length) return;
  try {
    const db = await openWorkspaceDb(cwd);
    const result = await distill({
      db,
      turns,
      sessionId,
          llmCall: makeLlmCall(ctx, session, agent),
      log,
    });
    status.lastExtract = {
      at: new Date().toISOString(),
      reason,
      applied: result.applied.length,
      llmFailed: result.llmFailed,
    };
    if (result.llmFailed) {
      savePending(cwd, { sessionId, turns, error: "llm failed" });
    } else {
      clearPending(cwd);
    }
  } catch (err) {
    log.warn?.(`[dsh-trivium] extract skipped: ${err.message}`);
    try {
      savePending(cwd, { sessionId, turns, error: String(err.message || err) });
    } catch {
      // ignore
    }
  }
}

function onSessionEvent(session, event) {
  const buf = bufOf(session);
  switch (event.type) {
    case "user/message": {
      const msg = event.data;
      if (msg?.source?.kind && msg.source.kind !== "user") break;
      const text = clip(textFromContent(msg?.content), 500);
      if (text) {
        buf.turns.push({ role: "user", text, turn: event.data?.turn });
        buf.dirty = true;
      }
      break;
    }
    case "assistant/message": {
      const msg = event.data?.message || event.data;
      const text = clip(textFromContent(msg?.content), 400);
      if (text) {
        buf.turns.push({ role: "assistant", text, turn: event.data?.turn });
        buf.dirty = true;
      }
      break;
    }
    case "tool/call": {
      buf.calls[event.data.callId] = event.data.name;
      break;
    }
    case "tool/result": {
      const callId = event.data?.message?.source?.callId || event.data?.callId;
      const name = buf.calls[callId] || "tool";
      const msg = event.data?.message || event.data;
      const content0 = Array.isArray(msg?.content) ? msg.content[0] : null;
      const err = event.data?.error || msg?.error;
      const isError =
        Boolean(err) ||
        msg?.isError === true ||
        content0?.isError === true ||
        event.data?.ok === false ||
        msg?.ok === false;
      buf.turns.push({
        role: "tool",
        name,
        ok: !isError,
        text: clip(textFromContent(event.data?.message?.content), 200),
        turn: event.data?.turn,
      });
      buf.dirty = true;
      break;
    }
    case "turn/end": {
      if (buf.dirty && buf.cwd && buf.turns.length) {
        savePending(buf.cwd, { sessionId: buf.sessionId, turns: buf.turns });
      }
      buf.lastTurnEndSeq = event.seq;
      break;
    }
    case "compaction/summary": {
      buf.compactionSummary = {
        id: event.data?.compactionId,
        text: textFromContent(event.data?.summary),
        end: event.data?.shadowedRange?.end,
      };
      break;
    }
    default:
      break;
  }
  if (buf.turns.length > 80) buf.turns = buf.turns.slice(-80);
}

function injectShortMap(agent, db, budget) {
  const map = buildShortMapReport(db, budget);
  status.lastInjectTokens = map.tokens;
  status.lastInjectAt = new Date().toISOString();
  agent.inject(
    createUserMessage({
      content: [{ type: "text", text: map.text }],
      source: {
        kind: "plugin",
        plugin: "dsh-trivium",
        form: "snapshot",
        sections: [{ name: "dsh-trivium", text: map.text }],
      },
    }),
  );
  return map;
}

/**
 * Session-start can lose a race with the first model step if the host does not
 * await the hook. Mark the session synchronously, then inject once.
 */
async function ensureShortMap(agent, options) {
  const id = sessionKey(agent?.session);
  if (!id || mapInjected.has(id)) return null;
  mapInjected.add(id);
  try {
    const cwd = cwdOf(agent);
    setActiveCwd(cwd);
    const db = await openWorkspaceDb(cwd);
    return { db, cwd, map: injectShortMap(agent, db, options.mapTokenBudget || 400) };
  } catch (err) {
    mapInjected.delete(id);
    throw err;
  }
}

export function apply(ctx, config = {}) {
  const log = ctx.logger?.("dsh-trivium") ?? console;
  const optionsOf = () => liveOptions(config);

  let runtime = ctx;
  ctx.inject(["llm"], (llmCtx) => {
    runtime = llmCtx;
  });

  registerTools(ctx, optionsOf);

  ctx.on("agent/session-start", async ({ agent }) => {
    try {
      const ready = await ensureShortMap(agent, optionsOf());
      const cwd = ready?.cwd || cwdOf(agent);
      const db = ready?.db || (await openWorkspaceDb(cwd));
      setActiveCwd(cwd);
      try {
        const session = agent.session;
        const sessionId = sessionKey(session);
        if (sessionId && sessionLayerEnabledOf(optionsOf())) {
          const seedLen = session?.header?.seedLength;
          ensureTail(db, sessionId, {
            atSeq: Number.isFinite(Number(seedLen)) && seedLen > 0 ? seedLen - 1 : 0,
          });
          if (session?.header?.parentSession) {
            syncForkLineage(db, {
              childSessionId: sessionId,
              parentSessionId: session.header.parentSession,
              atSeq: Number.isFinite(Number(seedLen)) && seedLen > 0 ? seedLen - 1 : undefined,
            });
          }
        }
      } catch (err) {
        log.warn?.(`[dsh-trivium] episode tail skipped: ${err.message}`);
      }
      const pending = loadPending(cwd);
      if (pending?.turns?.length && optionsOf().extractEnabled !== false) {
        runExtract(runtime, {
          cwd,
          turns: pending.turns,
          sessionId: pending.sessionId || agent.session?.id,
          session: agent.session,
          agent,
          log,
          options: optionsOf(),
          reason: "pending-replay",
        }).catch((err) => log.warn?.(`[dsh-trivium] pending replay: ${err.message}`));
      }
    } catch (err) {
      log.warn?.(`[dsh-trivium] session-start skipped: ${err.message}`);
    }
  });

  ctx.on("session/event", (session, event) => {
    try {
      onSessionEvent(session, event);
      if (event.type === "compaction/end" && !event.data?.error) {
        clearIdle(sessionKey(session));
        const buf = bufOf(session);
        runExtract(runtime, {
          cwd: buf.cwd || session.header?.cwd,
          turns: buf.turns,
          sessionId: buf.sessionId || session.id,
          session,
          log,
          options: optionsOf(),
          reason: "compaction/end",
        }).catch((err) => log.warn?.(`[dsh-trivium] compaction extract: ${err.message}`));
        const cwd = buf.cwd || session.header?.cwd;
        const sessionId = buf.sessionId || session.id;
        if (cwd && sessionId && sessionLayerEnabledOf(optionsOf())) {
          const summary =
            buf.compactionSummary?.id === event.data?.compactionId && buf.compactionSummary.text
              ? buf.compactionSummary.text
              : "已压缩";
          const atSeq = Number.isFinite(Number(event.seq))
            ? Number(event.seq)
            : Number.isFinite(Number(buf.compactionSummary?.end))
              ? Number(buf.compactionSummary.end)
              : Number(buf.lastTurnEndSeq) || 0;
          openWorkspaceDb(cwd)
            .then((db) => {
              recordCheckpoint(db, {
                sessionId,
                atSeq,
                compactionId: event.data?.compactionId,
                summary,
              });
            })
            .catch((err) => log.warn?.(`[dsh-trivium] episode checkpoint skipped: ${err.message}`));
        }
      }
      if (event.type === "turn/end") {
        const id = sessionKey(session);
        const bufEnd = bufOf(session);
        const lastUser = [...(bufEnd.turns || [])].reverse().find((t) => t.role === "user");
        const preview = String(lastUser?.text || "").trim();
        if (
          bufEnd.cwd &&
          bufEnd.sessionId &&
          preview &&
          !preview.startsWith("/") &&
          sessionLayerEnabledOf(optionsOf())
        ) {
          openWorkspaceDb(bufEnd.cwd)
            .then((db) => {
              ensureTail(db, bufEnd.sessionId, {
                atSeq: Number(event.seq) || bufEnd.lastTurnEndSeq || 0,
                summary: preview.slice(0, 240),
              });
            })
            .catch((err) => log.warn?.(`[dsh-trivium] episode tail preview skipped: ${err.message}`));
        }
        clearIdle(id);
        const timer = setTimeout(() => {
          idleTimers.delete(id);
          const buf = bufOf(session);
          if (!buf.dirty || !buf.turns.length || optionsOf().extractEnabled === false) return;
          runExtract(runtime, {
            cwd: buf.cwd || session.header?.cwd,
            turns: buf.turns,
            sessionId: buf.sessionId || session.id,
            session,
            log,
            options: optionsOf(),
            reason: "idle",
          })
            .then(() => {
              buf.dirty = false;
            })
            .catch((err) => log.warn?.(`[dsh-trivium] idle extract: ${err.message}`));
        }, 12000);
        idleTimers.set(id, timer);
      }
    } catch (err) {
      log.warn?.(`[dsh-trivium] session/event skipped: ${err.message}`);
    }
  });

  ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
    const decision = await next();
    try {
      if (!decision || decision.kind !== "enter") return decision;
      try {
        await ensureShortMap(agent, optionsOf());
      } catch (err) {
        log.warn?.(`[dsh-trivium] pre-step map skipped: ${err.message}`);
      }
      const extra = [];
      const db = await openWorkspaceDb(cwdOf(agent));
      const sessionId = sessionKey(agent.session);
      const options = optionsOf();
      if (chipsEnabledOf(options)) {
        try {
          const pin = buildPinInject(db, sessionId, 300);
          if (pin.text) {
            extra.push(
              createUserMessage({
                content: [{ type: "text", text: pin.text }],
                source: {
                  kind: "plugin",
                  plugin: "dsh-trivium",
                  form: "pins",
                },
              }),
            );
          }
        } catch (err) {
          log.warn?.(`[dsh-trivium] pre-step pins skipped: ${err.message}`);
        }
      }
      const mode = recallModeOf(options);
      if (mode !== "off") {
        const proposed = [...(decision.messages || []), ...(messages || [])];
        const lastUser = [...proposed].reverse().find((m) => m?.source?.kind === "user");
        const query = lastUser ? textFromContent(lastUser.content).trim() : "";
        if (query) {
          let hits;
          if (mode === "anchor") {
            hits = namedRecallHits(db, query, { topK: 8 }).slice(0, 8);
          } else {
            const queryVector = await embedQueryVector(query);
            hits = searchNodes(db, query, {
              topK: 3,
              expandDepth: 1,
              queryVector: queryVector || undefined,
            }).slice(0, 3);
          }
          if (hits.length) {
            const lines = hits.map((hit) => {
              const row = formatHit(db, hit);
              return `- [${row.type}#${row.id}] ${row.l0} (${row.path.join(" | ") || "no path"})`;
            });
            const form = mode === "anchor" ? "anchorRecall" : "autoRecall";
            const text = clipToTokenBudget(
              `dsh-trivium ${form} (L0 only; use ctx_read for full text):\n${lines.join("\n")}`,
              300,
            );
            extra.push(
              createUserMessage({
                content: [{ type: "text", text }],
                source: {
                  kind: "plugin",
                  plugin: "dsh-trivium",
                  form: "recall",
                },
              }),
            );
          }
        }
      }
      if (!extra.length) return decision;
      return {
        kind: "enter",
        messages: [...extra, ...decision.messages],
      };
    } catch (err) {
      log.warn?.(`[dsh-trivium] pre-step recall skipped: ${err.message}`);
      return decision;
    }
  });

  ctx.on("session/disposed", (session) => {
    try {
      clearIdle(sessionKey(session));
      const buf = bufOf(session);
      if (buf.dirty && buf.cwd && buf.turns.length) {
        savePending(buf.cwd, { sessionId: buf.sessionId, turns: buf.turns });
      }
      buffers.delete(sessionKey(session));
      mapInjected.delete(sessionKey(session));
    } catch (err) {
      log.warn?.(`[dsh-trivium] dispose skipped: ${err.message}`);
    }
  });

  ctx.inject(["webServer"], (webCtx) => {
    try {
      registerMemoryApi(webCtx, { liveOptions: optionsOf, status });
    } catch (err) {
      log.warn?.(`[dsh-trivium] settings api skipped: ${err.message}`);
    }
  });

  ctx.effect(() => () => {
    closeAll();
  });
}
