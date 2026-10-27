import { createRequire } from "node:module";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { detectHostFormatV4, producerSourceFor } from "./host-format.js";
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
import { pinCandidates } from "./pins.js";
import { startTrace } from "./recall-trace.js";
import { makeRevisionResolver } from "./revisions.js";
import { noteObservedSession } from "./provenance.js";
import {
  MAP_TOKEN_BUDGET,
  renderContextRecords,
  selectContextRecords,
  TURN_ADDITIONAL_BUDGET,
  turnKeyOf,
} from "./context-budget.js";
import {
  beginTurn,
  clearAfterCompaction,
  clearSession,
  commit,
  deliveredOf,
  mapTextOf,
  noteMap,
  pendingCorrections,
  reserve,
  rollback,
} from "./turn-ledger.js";
import { syncSidecarOnOpen } from "./sidecar.js";

export const name = "dsh-trivium";
export const inject = ["tools"];

/*
 * Session format v4 (DSH 0.2.0+) replaced the shared `kind: "plugin"` source
 * with producer-owned kinds: a third-party producer is `plugin:<name>` and the
 * `plugin` field is dropped. Writing the old shape into a v4 log fails the
 * whole turn with "format v4 message requires a producer-owned source kind".
 * 0.1.x only knows the old shape, so pick by host version.
 */
function readHostLlmVersion() {
  try {
    return String(createRequire(import.meta.url)("@deepseek-ai/dsh-llm/package.json").version || "");
  } catch {
    return "";
  }
}

export const HOST_FORMAT_V4 = detectHostFormatV4(readHostLlmVersion());

export function producerSource(extra) {
  return producerSourceFor(HOST_FORMAT_V4, extra);
}

const DEFAULTS = {
  autoRecall: false,
  anchorRecall: false,
  recallMode: "off",
  extractEnabled: true,
  chipsEnabled: false,
  sessionLayerEnabled: false,
  gitSidecarEnabled: false,
  pluginLocale: "host",
  configPanelOpen: false,
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
/**
 * The map text stays in the host context until compaction replaces it, so keep
 * it per session and use it for cross-stage de-duplication in later turns.
 */
const mapTextBySession = new Map();
const status = {
  lastInjectTokens: 0,
  lastInjectAt: null,
  lastExtract: null,
  lastContextPlan: null,
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

/**
 * Fork-inherited prefix length. DSH 0.1.5 moved this off the header
 * (`header.seedLength` is now rejected as an invalid field) onto the live
 * session as `inheritedEventCount`; keep the header read as a fallback for
 * older hosts.
 */
function sessionSeedLength(session) {
  const live = session?.inheritedEventCount;
  if (Number.isFinite(Number(live))) return Number(live);
  const legacy = session?.header?.seedLength;
  return Number.isFinite(Number(legacy)) ? Number(legacy) : 0;
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
          source: producerSource(),
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
      await savePending(cwd, { sessionId, turns, error: "llm failed" });
    } else {
      clearPending(cwd);
    }
  } catch (err) {
    log.warn?.(`[dsh-trivium] extract skipped: ${err.message}`);
    try {
      await savePending(cwd, { sessionId, turns, error: String(err.message || err) });
    } catch {
      // ignore
    }
  }
}

function onSessionEvent(session, event) {
  const buf = bufOf(session);
  // Provenance can only report a session as live if this process actually saw
  // it; nothing here is inferred from the stored text.
  noteObservedSession(sessionKey(session) || buf.sessionId);
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
      delete buf.calls[callId];
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
        savePending(buf.cwd, { sessionId: buf.sessionId, turns: buf.turns }).catch(() => {});
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
      source: producerSource({
        form: "snapshot",
        sections: [{ name: "dsh-trivium", text: map.text }],
      }),
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
    const map = injectShortMap(agent, db, options.mapTokenBudget || MAP_TOKEN_BUDGET);
    mapTextBySession.set(id, map.text);
    return { db, cwd, map };
  } catch (err) {
    mapInjected.delete(id);
    throw err;
  }
}

function proposedQuery(decision, messages) {
  const proposed = [...(decision?.messages || []), ...(messages || [])];
  const lastUser = [...proposed].reverse().find((m) => m?.source?.kind === "user");
  return lastUser ? textFromContent(lastUser.content).trim() : "";
}

/** Search hits carry a rendered row; selection wants fields. */
function structuredHit(db, hit) {
  const row = formatHit(db, hit);
  return {
    id: row.id,
    type: row.type,
    l0: row.l0,
    until: row.until,
    stale: row.stale,
    path: row.path,
  };
}

async function recallCandidates(db, mode, query, onStage) {
  if (!query) return { hits: [], semantic: "not_run" };
  if (mode === "anchor") {
    return {
      hits: namedRecallHits(db, query, { topK: 8, onStage })
        .slice(0, 8)
        .map((hit) => structuredHit(db, hit)),
      // Anchor mode never consults the semantic channel.
      semantic: "not_run",
    };
  }
  const queryVector = await embedQueryVector(query);
  const hits = searchNodes(db, query, {
    topK: 3,
    expandDepth: 1,
    includeStale: false,
    queryVector: queryVector || undefined,
    onStage,
  })
    .slice(0, 3)
    .map((hit) => structuredHit(db, hit));
  return { hits, semantic: queryVector ? "ran" : "not_run" };
}

/** Trace-friendly node summaries for a list of ids. */
function stageNodes(db, ids) {
  return (ids || []).map((raw) => {
    const id = Number(raw);
    const payload = db.get(id)?.payload || {};
    return { id, type: payload.type || "unknown", l0: String(payload.text || payload.name || "").slice(0, 80) };
  });
}

/** Map a selection drop reason onto a trace filter reason. */
const FILTER_BY_DROP = {
  "over-budget": "budget",
  "duplicate-node": "duplicate",
  "duplicate-in-turn": "duplicate",
  "already-in-map": "duplicate",
  stale: "stale",
  archived: "archived",
  dirty: "hygiene",
  "no-current": "revision",
  empty: "hygiene",
};

function planSummary(plan) {
  return {
    budget: plan.budget,
    tokens: plan.tokens,
    estimatedTokens: plan.estimatedTokens,
    at: plan.at,
    records: plan.records.map((r) => ({
      id: r.id,
      channel: r.channel,
      channels: r.channels,
      type: r.type,
      tokens: r.tokens || 0,
      historical: r.historical === true,
      matchedHistory: r.matchedHistory || null,
    })),
    dropped: plan.dropped,
    deferred: plan.deferred,
  };
}

export function apply(ctx, config = {}) {
  const log = ctx.logger?.("dsh-trivium") ?? console;
  const optionsOf = () => liveOptions(config);

  let runtime = ctx;
  ctx.inject(["llm"], (llmCtx) => {
    runtime = llmCtx;
  });

  registerTools(ctx, optionsOf);

  /*
   * DSH 0.1.6 replaced the serial `agent/session-start` event with
   * `agent/created` (payload `{ agent, source, signal? }`). 0.1.5 and older
   * only emit session-start, and a host never emits both, but the started set
   * keeps the four one-shot steps below from running twice if that changes.
   */
  const started = new Set();
  const onAgentStart = async ({ agent }) => {
    const startId = sessionKey(agent?.session);
    if (startId) {
      if (started.has(startId)) return;
      started.add(startId);
    }
    try {
      const ready = await ensureShortMap(agent, optionsOf());
      const cwd = ready?.cwd || cwdOf(agent);
      const db = ready?.db || (await openWorkspaceDb(cwd));
      setActiveCwd(cwd);
      try {
        await syncSidecarOnOpen(cwd, db);
      } catch (err) {
        log.warn?.(`[dsh-trivium] sidecar sync skipped: ${err.message}`);
      }
      try {
        const session = agent.session;
        const sessionId = sessionKey(session);
        if (sessionId && sessionLayerEnabledOf(optionsOf())) {
          const seedLen = sessionSeedLength(session);
          ensureTail(db, sessionId, {
            atSeq: seedLen > 0 ? seedLen - 1 : 0,
          });
          if (session?.header?.parentSession) {
            syncForkLineage(db, {
              childSessionId: sessionId,
              parentSessionId: session.header.parentSession,
              atSeq: seedLen > 0 ? seedLen - 1 : undefined,
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
  };

  ctx.on("agent/created", onAgentStart);
  ctx.on("agent/session-start", onAgentStart);

  ctx.on("session/event", (session, event) => {
    try {
      onSessionEvent(session, event);
      if (event.type === "compaction/end" && !event.data?.error) {
        clearIdle(sessionKey(session));
        const buf = bufOf(session);
        /*
         * The host replaced the old messages with a summary, so the map and the
         * per-turn ledger describe content that is no longer there. Clear both
         * and let the next pre-step rebuild what is still needed.
         */
        const compactedId = sessionKey(session) || buf.sessionId;
        if (compactedId) {
          clearAfterCompaction(compactedId);
          mapInjected.delete(compactedId);
          mapTextBySession.delete(compactedId);
        }
        runExtract(runtime, {
          cwd: buf.cwd || session.header?.cwd,
          turns: buf.turns,
          sessionId: buf.sessionId || session.id,
          session,
          log,
          options: optionsOf(),
          reason: "compaction/end",
        })
          .then(() => {
            buf.dirty = false;
            buf.turns = [];
          })
          .catch((err) => log.warn?.(`[dsh-trivium] compaction extract: ${err.message}`));
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
              buf.turns = [];
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
      const options = optionsOf();
      try {
        await ensureShortMap(agent, options);
      } catch (err) {
        log.warn?.(`[dsh-trivium] pre-step map skipped: ${err.message}`);
      }
      const chipsOn = chipsEnabledOf(options);
      const mode = recallModeOf(options);
      // Default stays quiet: both channels off means no pin/recall planning at all.
      if (!chipsOn && mode === "off") return decision;

      const sessionId = sessionKey(agent.session);
      const turnKey = turnKeyOf([...(decision.messages || []), ...(messages || [])]);
      beginTurn(sessionId, turnKey);
      // 300 is the cumulative allowance for one user turn, not per pre-step:
      // a tool loop that re-enters must not start a fresh 300 each time.
      const remaining = remainingOf(sessionId, turnKey, TURN_ADDITIONAL_BUDGET);
      if (remaining <= 0) return decision;

      const db = await openWorkspaceDb(cwdOf(agent));
      const cwd = cwdOf(agent);
      const pins = chipsOn ? pinCandidates(db, sessionId, { resolveRevision: makeRevisionResolver(db) }) : [];
      const query = mode === "off" ? "" : proposedQuery(decision, messages);
      const trace =
        mode === "off"
          ? null
          : startTrace({ cwd, sessionId, query, mode, semantic: "not_run", source: "pre-step" });
      const recall = mode === "off" ? { hits: [], semantic: "not_run" } : await recallCandidates(db, mode, query, (stage, ids) => trace?.stage(stage, stageNodes(db, ids)));
      const form = mode === "anchor" ? "anchorRecall" : "autoRecall";
      const plan = selectContextRecords({
        pins,
        recall: recall.hits,
        corrections: pendingCorrections(sessionId),
        budget: remaining,
        form,
        delivered: deliveredOf(sessionId, turnKey),
        mapText: mapTextOf(sessionId, turnKey) || mapTextBySession.get(sessionId) || "",
        resolveCurrent: makeRevisionResolver(db),
      });
      if (trace) {
        // Only nodes that were actually candidates get a filter reason; a node
        // that never entered the pipeline is not "filtered by a rule".
        for (const [dropReason, filterReason] of Object.entries(FILTER_BY_DROP)) {
          const ids = plan.dropped.filter((d) => d.reason === dropReason).map((d) => d.id);
          if (ids.length) trace.filter(filterReason, stageNodes(db, ids));
        }
        trace.selected({
          ids: plan.records.map((r) => r.id),
          budget: plan.budget,
          tokens: plan.tokens,
          deferred: plan.deferred,
        });
        status.lastTrace = trace.finish({ semantic: recall.semantic });
      }
      status.lastContextPlan = planSummary(plan);
      if (!plan.records.length) return decision;

      const rendered = renderContextRecords(plan, { form });
      // Reserve first, assemble second, commit last: anything that throws while
      // building the messages rolls the reservation back, so the next pre-step
      // retries the same content instead of believing it was delivered.
      const reservation = reserve(sessionId, turnKey, plan.records);
      try {
        const extra = [];
        if (rendered.pins.text) {
          extra.push(
            createUserMessage({
              content: [{ type: "text", text: rendered.pins.text }],
              // No `form`: "pins" was never in DSH's ContextForm union, so the
              // client already rendered it as undeclared (opaque) context.
              // Omitting the field is the documented default for that.
              source: producerSource(),
            }),
          );
        }
        if (rendered.recall.text) {
          extra.push(
            createUserMessage({
              content: [{ type: "text", text: rendered.recall.text }],
              source: producerSource({ form: "recall" }),
            }),
          );
        }
        const nextDecision = { kind: "enter", messages: [...extra, ...decision.messages] };
        commit(reservation);
        return nextDecision;
      } catch (err) {
        rollback(reservation);
        throw err;
      }
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
        savePending(buf.cwd, { sessionId: buf.sessionId, turns: buf.turns }).catch(() => {});
      }
      buffers.delete(sessionKey(session));
      mapInjected.delete(sessionKey(session));
      mapTextBySession.delete(sessionKey(session));
      // A fork is a different session id, so it starts with an empty ledger and
      // no inherited pins — nothing from the parent can leak through here.
      clearSession(sessionKey(session));
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
