import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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
import { estimateTokens } from "./tokens.js";
import { createExtractScheduler } from "./extract-scheduler.js";
import {
  distill,
  loadPendingWindows,
  savePending,
  screenTurns,
  settlePending,
  textFromContent,
} from "./extract.js";
import { readUiSettings, registerMemoryApi } from "./server.js";
import { appendSourceTurn, turnFromEvent } from "./source-events.js";
import { CHANGE_REASONS, noteChanges, readChanges, rowsForExtract } from "./change-log.js";
import { LOCK_TTL_MS, lockPath, withWorkspaceLock } from "./workspace-lock.js";
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
  mapTurnKeyOf,
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
  resolveTurnKeyForLedger,
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
/** How long session start waits for a pending replay before continuing without it. */
const PENDING_REPLAY_WAIT_MS = 8000;
/**
 * The map text stays in the host context until compaction replaces it, so keep
 * it per session and use it for cross-stage de-duplication in later turns.
 */
const mapTextBySession = new Map();
/*
 * B3 (incremental map injection). The version of the map that is currently in
 * the host context, per session. A short map is a snapshot: repeating it every
 * turn pays for the same bytes until compaction throws it away.
 */
const mapStateBySession = new Map();
/**
 * How many user turns may pass without a full map before one is forced.
 *
 * Six is a compromise, not a measurement: the map is the only place the model
 * sees the *shape* of memory (counts + a few names), and a long tool loop with
 * many small diffs can drift away from it. Six turns is short enough to restore
 * the global view within a session and long enough that a normal exchange of
 * three or four turns never pays for a full copy.
 */
export const MAP_FULL_REFRESH_TURNS = 6;
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

/* ---- B5: stuck detection and self-healing ------------------------------- */

/** A run that has not produced a result by now is reported as stuck. */
export const EXTRACT_TIMEOUT_MS = 30_000;

/** The three conditions the work order names. `detail` in the log carries these. */
export const STUCK_KINDS = Object.freeze({
  extractTimeout: "extract-timeout",
  lockStale: "lock-stale",
  replayTimeout: "replay-timeout",
});

const STUCK_VALUES = new Set(Object.values(STUCK_KINDS));

/**
 * Wait for `work`, but stop waiting after `timeoutMs`.
 *
 * The work is *not* cancelled: `distill` writes through the engine and cannot
 * be interrupted safely, so the abandoned promise keeps the workspace lock
 * until it really settles (a second writer would be rejected by the kernel
 * anyway). What the timeout buys is an honest status and a caller that can go
 * back to its event loop instead of hanging forever. A late rejection is
 * absorbed by `settled`, so it cannot surface as an unhandled rejection.
 */
export async function raceWithTimeout(
  work,
  timeoutMs,
  { setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), now = () => Date.now() } = {},
) {
  const startedAt = now();
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimer(() => resolveTimeout({ timedOut: true, elapsedMs: now() - startedAt }), timeoutMs);
    timer?.unref?.();
  });
  const settled = Promise.resolve()
    .then(() => work)
    .then((value) => ({ timedOut: false, value }), (error) => ({ timedOut: false, error }));
  const first = await Promise.race([settled, timeout]);
  clearTimer(timer);
  return first;
}

/**
 * Is the workspace write lock held by something that no longer exists?
 *
 * `acquireWorkspaceLock` already reclaims such a lock; this is the read-only
 * probe that lets the plugin *say* it happened. A live owner is never stale,
 * however old the file is — a 10-minute model call is slow, not dead.
 */
export function staleLockInfo(cwd, { now = Date.now(), ttlMs = LOCK_TTL_MS } = {}) {
  if (!cwd) return null;
  const file = lockPath(cwd);
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return null;
  }
  const ageMs = Math.max(0, now - stat.mtimeMs);
  if (ageMs <= ttlMs) return { stale: false, ageMs, pid: null, alive: null };
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    owner = null;
  }
  const pid = Number(owner?.pid);
  let alive = false;
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      // No permission to inspect a process is not proof that it is dead.
      alive = err?.code === "EPERM";
    }
  }
  return { stale: !alive, ageMs, pid: Number.isSafeInteger(pid) ? pid : null, alive };
}

/** Stuck kinds that the change log says are still open (newest row per kind). */
export function openStuckKinds(entries = []) {
  const seen = new Set();
  const open = [];
  for (const row of entries) {
    const kind = String(row?.detail || "");
    if (!STUCK_VALUES.has(kind) || seen.has(kind)) continue;
    seen.add(kind);
    if (row.reason === CHANGE_REASONS.stuck) open.push(kind);
  }
  return open;
}

/**
 * Per-session stuck ledger.
 *
 * Each kind is recorded at most once per session: a stuck run that repeats every
 * turn must not turn the change log into a wall of identical rows. Recovery is
 * only recorded when this session (or a seeded log row) says the kind was open,
 * so `recovered` can never appear without a matching `stuck`.
 */
export function createStuckMonitor({
  cwd = "",
  sessionId = "",
  status: statusOf = {},
  record = () => {},
  now = () => new Date(),
} = {}) {
  const open = new Map();
  const sid = String(sessionId || "");
  const note = (row) => {
    try {
      record(row);
    } catch {
      // Diagnostics must never break a turn.
    }
  };
  const snapshotOpen = () => [...open.keys()];
  return {
    seed(kinds = []) {
      for (const kind of kinds) {
        if (!STUCK_VALUES.has(kind) || open.has(kind)) continue;
        open.set(kind, now().getTime());
        // `kinds` arrives newest first, so the first one is the most recent
        // condition; keep it rather than letting the oldest win by iteration.
        if (!statusOf.stuck) {
          statusOf.stuck = {
            kind,
            at: now().toISOString(),
            detail: "seeded from change log",
            sessionId: sid,
            open: snapshotOpen(),
          };
        }
      }
      return snapshotOpen();
    },
    mark(kind, detail = "") {
      if (!STUCK_VALUES.has(kind) || open.has(kind)) return false;
      const at = now();
      open.set(kind, at.getTime());
      statusOf.stuck = { kind, at: at.toISOString(), detail: String(detail), sessionId: sid, open: snapshotOpen() };
      note({ reason: CHANGE_REASONS.stuck, opId: `${sid}:stuck:${kind}`, detail: kind });
      return true;
    },
    recover(kind, detail = "") {
      if (!open.has(kind)) return false;
      const since = Number(open.get(kind)) || 0;
      open.delete(kind);
      const at = now();
      statusOf.recovered = {
        kind,
        at: at.toISOString(),
        afterMs: since ? Math.max(0, at.getTime() - since) : null,
        detail: String(detail),
        sessionId: sid,
        open: snapshotOpen(),
      };
      note({ reason: CHANGE_REASONS.recovered, opId: `${sid}:recovered:${kind}`, detail: kind });
      return true;
    },
    isOpen(kind) {
      return open.has(kind);
    },
    snapshot() {
      return { open: snapshotOpen(), last: statusOf.stuck || null };
    },
  };
}

const stuckMonitors = new Map();

function stuckMonitorFor(cwd, sessionId) {
  const key = `${resolve(String(cwd || ""))}\u0000${String(sessionId || "")}`;
  if (!stuckMonitors.has(key)) {
    stuckMonitors.set(
      key,
      createStuckMonitor({
        cwd,
        sessionId,
        status: workspaceStatus(cwd),
        record: (row) => recordAuditRows(cwd, [row]),
      }),
    );
  }
  return stuckMonitors.get(key);
}

function pendingWriteFailed(cwd) {
  workspaceStatus(cwd).lastPendingError = { at: new Date().toISOString() };
}

function pendingTurn(turn) {
  if (turn && !turn.messageId && !Number.isFinite(turn.seq)) turn.pendingEventId = randomUUID();
  return turn;
}

function persistPendingEventually(cwd, payload) {
  let retries = 0;
  const attempt = () => {
    savePending(cwd, payload).catch(() => {
      pendingWriteFailed(cwd);
      // Retry local persistence without making model requests; the warning stays
      // visible because a process exit before retry could still lose this buffer.
      if (retries++ >= 12) return;
      const timer = setTimeout(attempt, 5000);
      timer?.unref?.();
    });
  };
  attempt();
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

/**
 * Persist the audit rows for one extraction. A failure here is reported, never
 * hidden: the facts are already committed, so the log must not pretend to be
 * complete when it is not.
 */
function recordAuditRows(cwd, rows) {
  try {
    const outcome = noteChanges(cwd, rows);
    if (outcome.ok) return;
    workspaceStatus(cwd).lastAuditError = { at: new Date().toISOString(), code: outcome.code || "audit-write-failed" };
  } catch {
    workspaceStatus(cwd).lastAuditError = { at: new Date().toISOString(), code: "audit-write-failed" };
  }
}

function recordChanges(cwd, { db, result, sessionId, turns }) {
  try {
    const rows = rowsForExtract({
      result,
      sessionId,
      turns,
      sourceOf: (id) => db?.get(Number(id))?.payload?.source || null,
    });
    if (!rows.length) return;
    recordAuditRows(cwd, rows);
  } catch {
    workspaceStatus(cwd).lastAuditError = { at: new Date().toISOString(), code: "audit-write-failed" };
  }
}

async function runExtract(ctx, { cwd, turns, sessionId, session, agent, log, options, reason }) {
  if (options.extractEnabled === false || !cwd || !turns?.length) return false;
  /*
   * B1 scores only. Live extraction and pending replay both keep the original
   * window and its chronology; only the existing content gate decides whether
   * extraction needs a model call.
   */
  const screened = screenTurns(turns);
  /*
   * Second audit (2026-11-05): the audit trail only existed as a return value, so
   * nothing could inspect what a zero would have discarded. The bounded status
   * is available through /status, in memory only. `wouldDrop` is hypothetical;
   * this observer never consumes events.
   */
  {
    const status = workspaceStatus(cwd);
    status.lastScreen = {
      at: new Date().toISOString(),
      mode: screened.mode,
      dropped: screened.dropped.length,
      wouldDrop: screened.wouldDrop.length,
      counts: screened.counts,
      audit: (screened.audit || []).slice(0, 3),
    };
  }
  const usableTurns = turns;
  try {
    /*
     * One writer per workspace (F-W05, option A). The lock is taken *before* the
     * database is opened: the engine refuses a second writer outright, so a loser
     * that opens first would crash instead of reporting back. The loser keeps the
     * window pending and records `lock-busy`; it never waits behind a model call.
     */
    const monitor = stuckMonitorFor(cwd, sessionId);
    /*
     * B5: a run that never returns must not hang the event loop, and it must be
     * reported. The lock stays with the abandoned run until it really settles,
     * so the "next round" either succeeds (this window is retried from pending)
     * or reports lock-busy — never a second writer inside the same store.
     */
    const outcome = await raceWithTimeout(
      withWorkspaceLock(cwd, async () => {
        const db = await openWorkspaceDb(cwd);
        const result = await distill({
          db,
          turns: usableTurns,
          sessionId,
          llmCall: makeLlmCall(ctx, session, agent),
          log,
        });
        // Scores never change the window used for extraction or audit identity.
        recordChanges(cwd, { db, result, sessionId, turns: usableTurns });
        return result;
      }),
      EXTRACT_TIMEOUT_MS,
    );
    if (outcome.timedOut) {
      monitor.mark(STUCK_KINDS.extractTimeout, `>${EXTRACT_TIMEOUT_MS}ms`);
      workspaceStatus(cwd).lastExtract = {
        at: new Date().toISOString(),
        reason,
        applied: 0,
        skipped: [],
        skippedCount: 0,
        llmFailed: false,
        skippedBy: "extract-timeout",
        timeoutMs: EXTRACT_TIMEOUT_MS,
        elapsedMs: outcome.elapsedMs,
        gate: null,
      };
      // The window is NOT consumed: the fact may still be in it, and the
      // abandoned run may still commit. Keeping it pending is the honest state.
      log.warn?.(`[dsh-trivium] extraction still running after ${EXTRACT_TIMEOUT_MS}ms; reported as stuck and left pending`);
      return false;
    }
    if (outcome.error) throw outcome.error;
    const guarded = outcome.value;
    if (guarded.locked) {
      workspaceStatus(cwd).lastExtract = {
        at: new Date().toISOString(),
        reason,
        applied: 0,
        skipped: [],
        skippedCount: 0,
        llmFailed: false,
        skippedBy: "lock-busy",
        lock: guarded.reason,
        gate: null,
      };
      recordAuditRows(cwd, [{ reason: CHANGE_REASONS.lockBusy, opId: `${sessionId || ""}:lock:${Date.now()}`, detail: String(guarded.reason || "busy") }]);
      log.warn?.(`[dsh-trivium] another session is writing this workspace; the window stays pending`);
      return false;
    }
    const result = guarded.value;
    if (!result.llmFailed) {
      /*
       * A run that completed proves the store is writable again: whatever was
       * recorded as stuck (a dead lock holder, a run that timed out earlier) has
       * healed. Recovery is only written when the kind is actually open, so the
       * log never shows a recovery without its stuck row.
       */
      monitor.recover(STUCK_KINDS.extractTimeout);
      monitor.recover(STUCK_KINDS.lockStale);
    }
    workspaceStatus(cwd).lastExtract = {
      at: new Date().toISOString(),
      reason,
      applied: result.applied.length,
      // Candidates that were refused on the way in (secret / mojibake / dump).
      // Reported, never silently swallowed: a refusal is a user-visible decision.
      skipped: (result.skipped || []).slice(0, 8),
      skippedCount: (result.skipped || []).length,
      // Facts kept, but with an invented date removed before writing.
      adjusted: (result.adjusted || []).slice(0, 8),
      adjustedCount: (result.adjusted || []).length,
      /*
       * Replacement decisions and the link that retired them. Attempts that were
       * rejected are reported on their own counter: "count = 0" used to mean both
       * "never attempted" and "attempted but unsupported", which is exactly why
       * the missing chain could not be diagnosed from the status document.
       */
      superseded: (result.superseded || []).filter((row) => row.to || row.pending).slice(0, 8),
      supersededCount: (result.superseded || []).filter((row) => row.to || row.pending).length,
      supersedeSkipped: (result.superseded || []).filter((row) => row.skipped).slice(0, 8),
      supersedeSkippedCount: (result.superseded || []).filter((row) => row.skipped).length,
      llmFailed: result.llmFailed,
      // Compatibility field: scoring is observational and always removes zero.
      screenedOut: screened.dropped.length,
      screenedCounts: screened.counts,
      // The model answered "nothing" twice for a window that states a decision.
      emptySuspicious: result.emptySuspicious === true,
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

/**
 * A turn that produced no text at all.
 *
 * Tool-call-only steps are normal and must not be counted: the answer comes in a
 * later step. An empty content list, or a text block that is only whitespace,
 * means the model finished without saying anything.
 */
export function isEmptyAssistantAnswer(event) {
  const data = event?.data || {};
  const msg = data.message || data;
  const content = Array.isArray(msg?.content) ? msg.content : [];
  if (content.some((block) => block && (block.type === "tool_use" || block.type === "tool_call"))) return false;
  const texts = content.filter((block) => block?.type === "text");
  if (!texts.length) return content.length === 0;
  return texts.every((block) => !String(block.text || "").trim());
}

/** Record a blank reply so it can be attributed without a packet capture. */
function noteEmptyAnswer(cwd, sessionId, seq) {
  if (!cwd) return;
  try {
    const status = workspaceStatus(cwd);
    const previous = status.emptyAnswer || {};
    status.emptyAnswer = {
      at: new Date().toISOString(),
      sessionId: String(sessionId || ""),
      seq: seq ?? null,
      count: Number(previous.count || 0) + 1,
    };
  } catch {
    // Diagnostics must never break a turn.
  }
}

function onSessionEvent(session, event) {
  const buf = bufOf(session);
  // Provenance can only report a session as live if this process actually saw
  // it; nothing here is inferred from the stored text.
  noteObservedSession(sessionKey(session) || buf.sessionId);
  switch (event.type) {
    case "user/message": {
      // Buffering is delegated so the same rule applies everywhere: our own
      // injected map (source.kind = plugin:*) is not user wording and is dropped.
      const turn = pendingTurn(turnFromEvent(event));
      if (turn && appendSourceTurn(buf.turns, turn)) buf.dirty = true;
      break;
    }
    case "assistant/message": {
      const turn = pendingTurn(turnFromEvent(event));
      /*
       * An assistant message with no text is a completed turn that says nothing.
       * Reproduced offline with a stub (W11): the host reports turn_end
       * "completed", exits 0, and the reply is simply empty. The plugin cannot
       * retry someone else's model call, but it can make the event attributable
       * instead of leaving "the answer was blank" unexplained in a wire log.
       */
      if (!turn && isEmptyAssistantAnswer(event)) noteEmptyAnswer(buf.cwd, buf.sessionId, event.seq);
      if (turn && appendSourceTurn(buf.turns, turn)) buf.dirty = true;
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
      const turn = pendingTurn(turnFromEvent(event, { name }));
      if (turn && appendSourceTurn(buf.turns, turn)) buf.dirty = true;
      break;
    }
    case "turn/end": {
      if (buf.dirty && buf.cwd && buf.turns.length) {
        persistPendingEventually(buf.cwd, { sessionId: buf.pendingKey ?? buf.sessionId, turns: buf.turns.slice() });
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

/**
 * What changed between the map that is in context and the map the database
 * would produce now.
 *
 * Only three things can happen to a *named* fact: it appears, it disappears
 * (archived / retired / expired), or its label changes. A body edit that leaves
 * the name alone is deliberately not a map event — the correction channel
 * already reports it, and a line saying "something changed" would cost tokens
 * without telling the model what changed.
 */
export function buildMapDiff(previous, report, { maxLines = 6, tokenBudget = 0 } = {}) {
  const prevRows = Array.isArray(previous?.entries) ? previous.entries : [];
  const nextRows = Array.isArray(report?.entries) ? report.entries : [];
  const prevById = new Map(prevRows.map((row) => [Number(row.id), row]));
  const nextById = new Map(nextRows.map((row) => [Number(row.id), row]));
  const added = nextRows.filter((row) => !prevById.has(Number(row.id)));
  const removed = prevRows.filter((row) => !nextById.has(Number(row.id)));
  const changed = nextRows.filter((row) => {
    const before = prevById.get(Number(row.id));
    return before && String(before.label) !== String(row.label);
  });
  const hidden = Number.isFinite(Number(report?.hidden)) ? Number(report.hidden) : 0;
  const head = `dsh-trivium memory map changed: +${added.length} new, -${removed.length} retired, ~${changed.length} relabeled; ${hidden} more entries stay unexpanded (ctx_find to read them).`;
  const body = [
    ...added.slice(0, maxLines).map((row) => `+${row.label}`),
    ...changed.slice(0, maxLines).map((row) => `~${row.label}`),
    ...removed.slice(0, maxLines).map((row) => `-${row.label}`),
  ];
  /*
   * Audit F3 (2026-11-04): `maxLines` was per category, so the diff could reach 18
   * lines / ~794 estimated tokens while the map budget is 400 — the diff never went
   * through the budget at all. Now it does, and the omitted count is stated instead
   * of silently dropping rows.
   */
  const total = added.length + changed.length + removed.length;
  const { text, shown } = clipToBudget(head, body, tokenBudget, total);
  return {
    text,
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    lines: text ? text.split("\n").length : 0,
    // Second audit (2026-11-05): `omitted` used to count only what the budget
    // trimming removed, so the rows dropped by the per-category cap vanished from
    // the number. It is now "all changes minus the rows actually printed".
    omitted: Math.max(0, total - shown),
    tokens: estimateTokens(text),
  };
}

/**
 * Keep `head` plus as many body lines as `tokenBudget` allows.
 *
 * Returns how many rows are printed, so the caller can compute the real omission
 * count. A budget too small for the header yields no text at all: printing the
 * header anyway would exceed the budget by 31 tokens on a 20-token budget, which
 * the audit measured.
 */
function clipToBudget(head, body, tokenBudget, total = body.length) {
  if (!head) return { text: "", shown: 0 };
  if (!tokenBudget || tokenBudget <= 0) return { text: [head, ...body].join("\n"), shown: body.length };
  let kept = body.slice();
  while (kept.length && estimateTokens([head, ...kept].join("\n")) > tokenBudget) kept.pop();
  if (!kept.length && estimateTokens(head) > tokenBudget) return { text: "", shown: 0 };
  /*
   * Fourth audit round: the marker said "6 more changes" while the structured
   * result said `omitted: 40`, because it counted what the *budget* trimmed and
   * ignored what the per-category cap had already dropped. The number a model reads
   * has to be the same number the caller gets.
   */
  const omitted = Math.max(0, total - kept.length);
  if (omitted > 0) {
    const marker = `…${omitted} more changes`;
    const withMarker = [head, ...kept, marker].join("\n");
    if (estimateTokens(withMarker) <= tokenBudget) return { text: withMarker, shown: kept.length };
  }
  return { text: [head, ...kept].join("\n"), shown: kept.length };
}

/**
 * Decide between full, diff and no injection.
 *
 * Pure on purpose: the session state machine is the part that must be
 * predictable, and it can then be verified without a host.
 *
 *   - first injection, or a version we cannot compute -> full (always safe);
 *   - `turnsSince >= fullEvery` -> full, so a long run cannot drift away from
 *     the global picture;
 *   - same version -> nothing at all (the host still holds the previous text);
 *   - otherwise a diff: summary line + at most six changed rows.
 */
export function planMapInjection(previous, report, { turnsSince = 0, fullEvery = MAP_FULL_REFRESH_TURNS, tokenBudget = 0 } = {}) {
  const version = String(report?.version || "");
  const full = {
    mode: "full",
    text: String(report?.text || ""),
    tokens: Number(report?.tokens) || estimateTokens(report?.text || ""),
    version,
  };
  if (!previous || !previous.version) return { ...full, reason: "first" };
  if (!version) return { ...full, reason: "no-version" };
  if (turnsSince >= fullEvery) return { ...full, reason: "refresh" };
  if (version === previous.version) return { mode: "skip", reason: "unchanged", text: "", tokens: 0, version };
  const diff = buildMapDiff(previous, report, { tokenBudget });
  if (!diff.added && !diff.removed && !diff.changed) {
    // The fingerprint moved but nothing the map can name did (a body-only edit).
    return { mode: "skip", reason: "version-only", text: "", tokens: 0, version };
  }
  // `omitted` travels with the plan: the diagnostics card reports it, and a diff
  // that printed nothing is not an injection.
  if (!diff.text) return { mode: "skip", reason: "budget-too-small", text: "", tokens: 0, version, omitted: diff.omitted };
  return {
    mode: "diff",
    reason: "changed",
    text: diff.text,
    tokens: diff.tokens ?? estimateTokens(diff.text),
    version,
    omitted: diff.omitted,
  };
}

function injectMapText(agent, text) {
  agent.inject(
    createUserMessage({
      content: [{ type: "text", text }],
      source: producerSource({
        form: "snapshot",
        sections: [{ name: "dsh-trivium", text }],
      }),
    }),
  );
}

function injectShortMap(agent, db, budget) {
  const map = buildShortMapReport(db, budget);
  injectMapText(agent, map.text);
  const currentStatus = workspaceStatus(cwdOf(agent));
  currentStatus.lastInjectTokens = map.tokens;
  currentStatus.lastInjectAt = new Date().toISOString();
  return map;
}

/**
 * Session-start can lose a race with the first model step if the host does not
 * await the hook. Mark the session synchronously, then inject once.
 */
export async function ensureShortMap(agent, options) {
  const id = sessionKey(agent?.session);
  if (!id || mapInjected.has(id)) return null;
  mapInjected.add(id);
  try {
    const cwd = cwdOf(agent);
    setActiveCwd(cwd);
    const db = await openWorkspaceDb(cwd);
    const map = injectShortMap(agent, db, options.mapTokenBudget || MAP_TOKEN_BUDGET);
    mapTextBySession.set(id, map.text);
    mapStateBySession.set(id, {
      version: map.version || "",
      entries: map.entries || [],
      text: map.text,
      turnKey: "",
      turnsSince: 0,
      // Whether any turn (a real key, or one empty observation) has already
      // moved the counter. `turnKey` alone cannot say that: a host that never
      // exposes a user message keeps writing "" into it (F86-01).
      sawTurnKey: false,
    });
    workspaceStatus(cwd).lastMapInjection = {
      at: new Date().toISOString(),
      mode: "full",
      reason: "session-start",
      tokens: map.tokens,
      turnsSince: 0,
      version: map.version || "",
    };
    return { db, cwd, map };
  } catch (err) {
    mapInjected.delete(id);
    throw err;
  }
}

/**
 * B3: refresh the map once per user turn, and only when it is worth the tokens.
 *
 * Injected through `agent.inject`, the same channel as the session-start map:
 * this is session context, not per-turn recall, so it must not compete with the
 * 300-token pins/recall/corrections allowance or be mistaken for user text.
 */
export function refreshShortMap(agent, db, options, turnKey) {
  const id = sessionKey(agent?.session);
  const previous = id ? mapStateBySession.get(id) : null;
  if (!previous) return null;
  /*
   * Several pre-steps can serve one user turn (a tool loop); only the first one
   * may move the counter, otherwise "six turns" would mean six model steps.
   *
   * An empty key is a continuation, not a new turn. The host hands over the
   * delta on later steps, so those windows contain no user message at all and
   * `mapTurnKeyOf` returns "". The old guard only skipped *equal* keys, so ""
   * never matched and every such pre-step counted as its own turn: `turnsSince`
   * walked 0 -> 3 inside one user turn on a real host (2026-11-06, reproduced
   * twice), which forces a full map every second turn instead of every sixth.
   * The ledger already carries the key forward the same way
   * (`resolveTurnKeyForLedger`), so this keeps both halves on one rule.
   *
   * F86-01 (2026-11-06, external review): `turnKey` cannot be the anchor. A
   * session whose host never exposes a user message keeps writing "" into it, so
   * `previous.turnKey` stays false forever and six consecutive empty pre-steps
   * walked 1 -> 2 -> 3 -> 4 -> 5 -> full/refresh. `sawTurnKey` is the anchor:
   * exactly one observation (a real key, or the first empty one) may move the
   * counter; every later empty observation is a continuation of that turn.
   *
   * A host that *never* exposes a user message therefore stays on its first
   * turn and will not get the six-turn full refresh until a real key arrives.
   * That is the honest limit: without any user message in any window there is
   * nothing to count turns by. It is cheaper than counting pre-steps as turns.
   */
  if (!turnKey) {
    if (previous.sawTurnKey) return null;
  } else if (previous.turnKey === turnKey) {
    return null;
  }
  const turnsSince = Number(previous.turnsSince || 0) + 1;
  const currentStatus = workspaceStatus(cwdOf(agent));
  currentStatus.mapInjections = currentStatus.mapInjections || { full: 0, diff: 0, skip: 0 };
  let report;
  try {
    report = buildShortMapReport(db, options.mapTokenBudget || MAP_TOKEN_BUDGET);
  } catch (err) {
    // A map we cannot build is not a reason to break the turn.
    currentStatus.lastMapInjection = { at: new Date().toISOString(), mode: "error", reason: String(err?.message || err), tokens: 0 };
    return null;
  }
  const plan = planMapInjection(previous, report, { turnsSince, tokenBudget: options.mapTokenBudget || MAP_TOKEN_BUDGET });
  const at = new Date().toISOString();
  if (plan.mode === "skip") {
    previous.turnKey = turnKey;
    previous.sawTurnKey = true;
    previous.turnsSince = turnsSince;
    // Keep the previous version: a version-only change still has to be absorbed,
    // otherwise the next turn would compute the same diff again.
    previous.version = plan.version || previous.version;
    currentStatus.mapInjections.skip += 1;
    currentStatus.lastMapInjection = { at, mode: "skip", reason: plan.reason, tokens: 0, turnsSince, version: plan.version };
    return plan;
  }
  let error = "";
  try {
    injectMapText(agent, plan.text);
  } catch (err) {
    // Reported, and the state still advances: retrying the same diff every
    // pre-step would spam a host that refuses mid-session injection.
    error = String(err?.message || err);
  }
  previous.version = plan.version;
  previous.entries = report.entries || [];
  previous.turnKey = turnKey;
  previous.sawTurnKey = true;
  if (plan.mode === "full") {
    previous.turnsSince = 0;
    previous.text = plan.text;
    mapTextBySession.set(id, plan.text);
  } else {
    previous.turnsSince = turnsSince;
  }
  currentStatus.mapInjections[plan.mode] += 1;
  currentStatus.lastMapInjection = {
    at,
    mode: plan.mode,
    reason: plan.reason,
    tokens: plan.tokens,
    turnsSince: previous.turnsSince,
    version: plan.version,
    ...(error ? { error } : {}),
  };
  if (plan.mode === "full") {
    currentStatus.lastInjectTokens = plan.tokens;
    currentStatus.lastInjectAt = at;
  }
  return plan;
}

function proposedQuery(decision, messages) {
  const proposed = [...(decision?.messages || []), ...(messages || [])];
  const lastUser = [...proposed].reverse().find((m) => m?.source?.kind === "user");
  return lastUser ? textFromContent(lastUser.content).trim() : "";
}

/** Search hits carry a rendered row; selection wants fields. */
function structuredHit(db, hit) {
  // Automatic recall is not a user reference (see lib/usage.js): counting it
  // would let the map rank a fact higher just for having been in the map.
  const row = formatHit(db, hit, { includeWorkspace: false, track: false });
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
    persist: async (buf, error, { snapshot, ok }) => {
      try {
        await settlePending(buf.cwd, buf.pendingKey ?? buf.sessionId, ok ? snapshot : [], buf.turns, error);
      } catch (err) {
        pendingWriteFailed(buf.cwd);
        throw err;
      }
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
      /*
       * B5: a new session is the moment to say what was left broken, and the
       * moment the existing self-healing (reclaim a dead lock, drain pending)
       * actually runs. Seeding from the change log is what lets a *later*
       * process close a row opened by an earlier one.
       */
      const stuckMonitor = stuckMonitorFor(cwd, startId);
      try {
        stuckMonitor.seed(openStuckKinds(readChanges(cwd, { limit: 40 }).entries || []));
      } catch {
        // A missing or broken log must not delay session start.
      }
      const lockState = staleLockInfo(cwd);
      if (lockState?.stale) {
        stuckMonitor.mark(STUCK_KINDS.lockStale, `age=${Math.round(lockState.ageMs / 1000)}s pid=${lockState.pid ?? "unknown"}`);
        log.warn?.(`[dsh-trivium] reclaimed a stale workspace lock (age ${Math.round(lockState.ageMs / 1000)}s, pid ${lockState.pid ?? "unknown"})`);
      }
      let pending = null;
      try {
        pending = loadPendingWindows(cwd)[0] || null;
      } catch {
        pendingWriteFailed(cwd);
        const at = new Date().toISOString();
        workspaceStatus(cwd).recovery = { state: "failed", startedAt: at, updatedAt: at };
        log.warn?.("[dsh-trivium] pending recovery unavailable");
      }
      const claimKey = resolve(cwd);
      if (pending?.turns?.length && optionsOf().extractEnabled !== false && !replayClaims.has(claimKey)) {
        replayClaims.set(claimKey, true);
        const recovery = { state: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        workspaceStatus(cwd).recovery = recovery;
        const setRecovery = (state) => { recovery.state = state; recovery.updatedAt = new Date().toISOString(); };
        try {
          // Drain the queue serially. A dedicated buffer keeps each historical
          // window separate from live events on the session starting recovery.
          const replay = (async () => {
            let current = pending;
            while (current && optionsOf().extractEnabled !== false) {
              const buf = { sessionId: String(current.sessionId || ""), pendingKey: String(current.sessionId || ""), cwd, turns: current.turns.slice(), dirty: true };
              try {
                const ok = await scheduler.schedule(buf, { ...extractionContext(agent.session, agent), sessionId: buf.pendingKey }, "pending-replay");
                if (ok !== true) { setRecovery("failed"); return; }
              } finally { scheduler.dispose(buf); }
              current = loadPendingWindows(cwd)[0] || null;
            }
            setRecovery(current ? "pending" : "succeeded");
            if (!current) {
              // A replay that finished inside its budget is not stuck either.
              stuckMonitor.recover(STUCK_KINDS.replayTimeout);
              stuckMonitor.recover(STUCK_KINDS.lockStale);
            }
          })()
            .catch(() => { pendingWriteFailed(cwd); setRecovery("failed"); })
            .finally(() => replayClaims.delete(claimKey));
          let timer;
          const timedOut = await Promise.race([
            replay.then(() => false),
            new Promise((resolveTimer) => {
              timer = setTimeout(() => resolveTimer(true), PENDING_REPLAY_WAIT_MS);
              timer?.unref?.();
            }),
          ]);
          clearTimeout(timer);
          if (timedOut) {
            // The promise continues to own the workspace claim until it settles.
            // Completion updates the state even after session start proceeds.
            if (recovery.state === "running") setRecovery("running-timed-out");
            log.warn?.(`[dsh-trivium] pending replay still running after ${PENDING_REPLAY_WAIT_MS}ms; starting without it`);
            // Recorded so the UI can show "recovering" instead of "empty" (W5).
            recordAuditRows(cwd, [{ reason: CHANGE_REASONS.replayTimeout, opId: `${startId || ""}:replay-timeout:${Date.now()}`, detail: `>${PENDING_REPLAY_WAIT_MS}ms` }]);
            // B5: the same condition is also a `stuck` row, keyed by kind, so it
            // can be paired with a later `recovered` instead of disappearing
            // into a one-off timeout note.
            stuckMonitor.mark(STUCK_KINDS.replayTimeout, `>${PENDING_REPLAY_WAIT_MS}ms`);
          }
        } catch (err) {
          setRecovery("failed");
          pendingWriteFailed(cwd);
          replayClaims.delete(claimKey);
          log.warn?.(`[dsh-trivium] pending replay skipped: ${err.message}`);
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
          // The host replaced the messages, so the map that was in context is
          // gone too: the next turn must inject a full map, not a diff against
          // a text nobody can see any more.
          mapStateBySession.delete(compactedId);
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
      /*
       * Identity of the upcoming user turn. Computed before the channels-off
       * return because the map refresh is not one of the recall channels: it
       * must still notice that memory changed while recall is switched off.
       */
      /*
   * `mapTurnKeyOf`, not `turnKeyOf`: the identity-based key changes whenever the
   * host re-serializes history, which made one user turn look like four (map went
   * full every few steps, and the per-turn budget was reset each time).
   */
  const chipsOn = chipsEnabledOf(options);
      const mode = recallModeOf(options);
      const sessionId = sessionKey(agent.session);
      /*
       * The key needs the session id, so it is computed after it (audit F4).
       *
       * An empty key means "no user message in this window" (a compaction or an
       * end-of-turn pre-step). Handing "" to the ledger would look like a brand new
       * turn and re-grant the whole budget — the second audit reproduced exactly
       * that (t:1 spent=300 -> "" -> another 138 tokens in the same turn). So the
       * previous key is carried forward: a pre-step without a user message belongs
       * to whatever turn is already open.
       */
      const observedKey = mapTurnKeyOf([...(decision.messages || []), ...(messages || [])], { sessionId });
      const turnKey = resolveTurnKeyForLedger(observedKey, sessionId);
      const db = await openWorkspaceDb(cwd);
      try {
        refreshShortMap(agent, db, options, turnKey);
      } catch (err) {
        log.warn?.(`[dsh-trivium] map refresh skipped: ${err.message}`);
      }
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
        persistPendingEventually(buf.cwd, { sessionId: buf.pendingKey ?? buf.sessionId, turns: buf.turns.slice() });
      }
      buffers.delete(sessionKey(session));
      mapInjected.delete(sessionKey(session));
      mapTextBySession.delete(sessionKey(session));
      mapStateBySession.delete(sessionKey(session));
      const disposedId = sessionKey(session);
      if (disposedId) {
        for (const key of stuckMonitors.keys()) {
          if (key.endsWith(`\u0000${disposedId}`)) stuckMonitors.delete(key);
        }
      }
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
