import { createRequire } from "node:module";
import { resolve } from "node:path";
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
  successorOf,
} from "./store.js";
import { clip } from "./schema.js";
import { createExtractScheduler } from "./extract-scheduler.js";
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
  pendingCorrections,
  remainingOf,
  reserve,
  rollback,
  setSessionWorkspace,
  refreshExpiredFacts,
  setCorrectionBlockedReason,
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
const mapInjected = new Set();
/**
 * The map text stays in the host context until compaction replaces it, so keep
 * it per session and use it for cross-stage de-duplication in later turns.
 */
const mapTextBySession = new Map();
const status = {
  byWorkspace: new Map(),
  lastInjectTokens: 0,
  lastInjectAt: null,
  lastExtract: null,
  lastContextPlan: null,
  /*
   * Invocation probe for the pre-step hook: it separates "the host never called
   * us" from "we threw before planning", which is otherwise invisible — the
   * per-step warning only reaches the host log.
   */
  preStep: { count: 0, at: null, stage: "", error: "" },
};

function workspaceStatus(cwd) {
  const key = resolve(cwd);
  if (!status.byWorkspace.has(key)) {
    status.byWorkspace.set(key, {
      lastInjectTokens: 0, lastInjectAt: null, lastExtract: null,
      lastContextPlan: null, lastTrace: null,
      preStep: { count: 0, at: null, stage: "", error: "" },
    });
  }
  return status.byWorkspace.get(key);
}

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

function resolveLlmTarget(session, agent) {
  const header = typeof session?.requestHeader === "function" ? session.requestHeader() : null;
  const cfg = header?.config;
  if (cfg?.provider && cfg?.model) return { provider: cfg.provider, model: cfg.model };
  if (agent?.options?.provider && agent?.options?.model) {
    return { provider: agent.options.provider, model: agent.options.model };
  }
  return null;
}

export function makeLlmCall(ctx, session, agent) {
  if (!ctx.llm) return null;
  const target = resolveLlmTarget(session, agent);
  if (!target) return null;
  return async (prompt) => {
    /*
     * Extraction is a JSON errand, not a reasoning task. Left at the default
     * effort the model burned the whole budget thinking (A-3: 12 of 18 calls
     * ended stop_reason=max_tokens). Ask for "off" first because it is both
     * cheaper and complete; fall back once for hosts whose catalog does not
     * advertise that effort, so an unknown effort can never disable extraction.
     */
    const build = (withEffort) => ({
      provider: target.provider,
      model: target.model,
      maxTokens: 900,
      ...(withEffort ? { reasoningEffort: "off" } : {}),
      sessionId: session?.id,
      messages: [
        createUserMessage({
          content: [{ type: "text", text: prompt }],
          source: producerSource(),
        }),
      ],
    });
    const consume = async (withEffort) => {
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream(build(withEffort))) assembler.push(chunk);
      return assembler;
    };
    let assembler;
    try {
      assembler = await consume(true);
    } catch (err) {
      const code = err?.code || err?.failure?.code || "";
      if (!/UNSUPPORTED_REASONING_EFFORT/.test(String(code))) throw err;
      assembler = await consume(false);
    }
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
  if (options.extractEnabled === false || !cwd || !turns?.length) return false;
  try {
    const db = await openWorkspaceDb(cwd);
    const result = await distill({
      db,
      turns,
      sessionId,
      llmCall: makeLlmCall(ctx, session, agent),
      log,
    });
    workspaceStatus(cwd).lastExtract = {
      at: new Date().toISOString(),
      reason,
      applied: result.applied.length,
      // Candidates that were refused on the way in (secret / mojibake / dump).
      // Reported, never silently swallowed: a refusal is a user-visible decision.
      skipped: (result.skipped || []).slice(0, 8),
      skippedCount: (result.skipped || []).length,
      llmFailed: result.llmFailed,
      // Why no model call was made for this window (content gate, D2 §5.1).
      gate: result.gate || null,
    };
    const secretSkips = (result.skipped || []).filter((row) => row.reason === "secret");
    if (secretSkips.length) {
      log.warn?.(`[dsh-trivium] ${secretSkips.length} candidate(s) refused as secret-looking: ${secretSkips.map((row) => row.preview).join(" | ")}`);
    }
    return !result.llmFailed;
  } catch (err) {
    log.warn?.(`[dsh-trivium] extract skipped: ${err.message}`);
    return false;
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
  agent.inject(
    createUserMessage({
      content: [{ type: "text", text: map.text }],
      source: producerSource({
        form: "snapshot",
        sections: [{ name: "dsh-trivium", text: map.text }],
      }),
    }),
  );
  const currentStatus = workspaceStatus(cwdOf(agent));
  currentStatus.lastInjectTokens = map.tokens;
  currentStatus.lastInjectAt = new Date().toISOString();
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
  const row = formatHit(db, hit, { includeWorkspace: false });
  return {
    id: row.id,
    type: row.type,
    l0: row.l0,
    bodyKey: row.bodyKey,
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
  /*
   * 8, not 3 (2026-10-29, C4 S07). The old topK=3 was an undocumented second
   * limiter sitting in front of the 300-token turn budget: six facts matching
   * the same query were cut to three while the block used only 89 tokens. The
   * budget is the real constraint, and it already drops whole records with
   * `over-budget`; capping candidates here only loses facts the budget would
   * have paid for. Anchor mode has always used 8 — this makes the two modes
   * agree instead of hiding a channel-specific cap.
   */
  const hits = searchNodes(db, query, {
    topK: 8,
    expandDepth: 1,
    includeStale: false,
    queryVector: queryVector || undefined,
    onStage,
  })
    .slice(0, 8)
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

  const replayClaims = new Map();
  const scheduler = createExtractScheduler({
    enabled: () => optionsOf().extractEnabled !== false,
    run: (turns, context, reason) => runExtract(runtime, { ...context, turns, options: optionsOf(), reason, log }),
    persist: async (buf, error) => {
      // Do not erase another session's pending file after an in-flight request.
      const pending = loadPending(buf.cwd);
      if (pending && pending.sessionId !== buf.sessionId) return;
      if (buf.turns.length) await savePending(buf.cwd, { sessionId: buf.sessionId, turns: buf.turns, ...(error ? { error } : {}) });
      else clearPending(buf.cwd);
    },
    onError: (err) => log.warn?.(`[dsh-trivium] extract: ${err.message}`),
  });
  const extractionContext = (session, agent) => ({ cwd: session?.header?.cwd, sessionId: sessionKey(session), session, agent });

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
      /*
       * Pending replay must land BEFORE the short map is built.
       *
       * A-6 evidence: in 3 of 15 correction runs the new session received a map
       * that said `decisions=0` although the workspace database had the fact by
       * the end of that same run. The replay was fired without awaiting, so the
       * map could be assembled from a database the previous session had not
       * finished writing yet. Replay first, then map: a session that inherits
       * pending work must see the result of doing it.
       */
      const cwd = cwdOf(agent);
      const db = await openWorkspaceDb(cwd);
      setActiveCwd(cwd);
      const pending = loadPending(cwd);
      if (pending?.turns?.length && optionsOf().extractEnabled !== false && !replayClaims.has(cwd)) {
        replayClaims.set(cwd, true);
        const buf = bufOf(agent.session);
        // A live buffer already owns its pending snapshot; do not prepend it twice.
        if (JSON.stringify(buf.turns.slice(0, pending.turns.length)) !== JSON.stringify(pending.turns)) buf.turns = [...pending.turns, ...buf.turns];
        buf.dirty = true;
        try {
          await savePending(cwd, { sessionId: buf.sessionId, turns: buf.turns });
          await Promise.resolve(scheduler.schedule(buf, extractionContext(agent.session, agent), "pending-replay"));
        } catch (err) {
          log.warn?.(`[dsh-trivium] pending replay skipped: ${err.message}`);
        } finally {
          replayClaims.delete(cwd);
        }
      }
      const ready = await ensureShortMap(agent, optionsOf());
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
        scheduler.schedule(buf, extractionContext(session), "compaction/end");
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
        scheduler.schedule(bufOf(session), extractionContext(session));
      }
    } catch (err) {
      log.warn?.(`[dsh-trivium] session/event skipped: ${err.message}`);
    }
  });

  ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
    const decision = await next();
    const cwd = cwdOf(agent);
    const currentStatus = workspaceStatus(cwd);
    currentStatus.preStep.count += 1;
    currentStatus.preStep.at = new Date().toISOString();
    currentStatus.preStep.stage = "decision";
    currentStatus.preStep.error = "";
    try {
      if (!decision || decision.kind !== "enter") {
        currentStatus.preStep.stage = "not-enter";
        return decision;
      }
      const options = optionsOf();
      try {
        await ensureShortMap(agent, options);
      } catch (err) {
        log.warn?.(`[dsh-trivium] pre-step map skipped: ${err.message}`);
      }
      const chipsOn = chipsEnabledOf(options);
      const mode = recallModeOf(options);
      const sessionId = sessionKey(agent.session);
      const db = await openWorkspaceDb(cwd);
      setSessionWorkspace(sessionId, cwd);
      // A clock transition has no store write hook. Superseded nodes are
      // already explained by their replacement notice, not an old expiry.
      refreshExpiredFacts(sessionId, (id) => successorOf(db, id) == null ? db.get(id)?.payload : null);
      setCorrectionBlockedReason(sessionId, !chipsOn && mode === "off" ? "channels-off" : null);
      // Default stays quiet: both channels off means no pin/recall planning at all.
      if (!chipsOn && mode === "off") {
        currentStatus.preStep.stage = "channels-off";
        return decision;
      }

      const turnKey = turnKeyOf([...(decision.messages || []), ...(messages || [])]);
      beginTurn(sessionId, turnKey);
      // 300 is the cumulative allowance for one user turn, not per pre-step:
      // a tool loop that re-enters must not start a fresh 300 each time.
      if (remainingOf(sessionId, turnKey, TURN_ADDITIONAL_BUDGET) <= 0) {
        setCorrectionBlockedReason(sessionId, "budget");
        return decision;
      }
      const pins = chipsOn ? pinCandidates(db, sessionId, { resolveRevision: makeRevisionResolver(db) }) : [];
      const query = mode === "off" ? "" : proposedQuery(decision, messages);
      const trace =
        mode === "off"
          ? null
          : startTrace({ cwd, sessionId, query, mode, semantic: "not_run", source: "pre-step" });
      const recall = mode === "off" ? { hits: [], semantic: "not_run" } : await recallCandidates(db, mode, query, (stage, ids) => trace?.stage(stage, stageNodes(db, ids)));
      const form = mode === "anchor" ? "anchorRecall" : "autoRecall";
      /*
       * Re-read the ledger after the awaits above. Two pre-steps can overlap
       * (the second one starts while the first is still searching), and reading
       * `remaining` only before the awaits would let both spend the same
       * allowance. Selection and reserve below are synchronous, so this value
       * cannot change between planning and booking.
       */
      const remaining = remainingOf(sessionId, turnKey, TURN_ADDITIONAL_BUDGET);
      if (remaining <= 0) {
        setCorrectionBlockedReason(sessionId, "budget");
        return decision;
      }
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
      setCorrectionBlockedReason(sessionId, plan.deferred.some((row) => row.channel === "correction") ? "budget" : null);
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
        currentStatus.lastTrace = trace.finish({ semantic: recall.semantic });
      }
      currentStatus.lastContextPlan = planSummary(plan);
      currentStatus.preStep.stage = "planned";
      if (!plan.records.length) return decision;

      const rendered = renderContextRecords(plan, { form });
      // Reserve first, assemble second, commit last: anything that throws while
      // building the messages rolls the reservation back, so the next pre-step
      // retries the same content instead of believing it was delivered.
      const reservation = reserve(sessionId, turnKey, plan.records, { totalTokens: rendered.total });
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
        if (rendered.corrections.text) {
          // Its own message: a correction is a state notice, not recall, and it
          // must never carry the old or new full body.
          extra.push(
            createUserMessage({
              content: [{ type: "text", text: rendered.corrections.text }],
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
      currentStatus.preStep.stage = "error";
      currentStatus.preStep.error = String(err?.message || err);
      log.warn?.(`[dsh-trivium] pre-step recall skipped: ${err.message}`);
      return decision;
    }
  });

  ctx.on("session/disposed", (session) => {
    try {
      if (buffers.has(sessionKey(session))) scheduler.dispose(buffers.get(sessionKey(session)));
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
    scheduler.disposeAll();
    closeAll();
  });
}
