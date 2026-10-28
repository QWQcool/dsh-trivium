import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  generateSidecarFromDb,
  archiveNode,
  backfillEmbeddings,
  dbPathFor,
  deleteGitSidecars,
  deleteNode,
  describeDbFailure,
  exportGraph,
  getActiveCwd,
  importGraph,
  listNodes,
  listOpenWorkspaces,
  mergeNodes,
  nodeCountOf,
  openWorkspaceDb,
  updateNode,
} from "./store.js";
import { embeddingPublicStatus } from "./embed.js";
import { chipsEnabledOf, configPanelOpenOf, gitSidecarEnabledOf, listedWorkspaces, pluginLocaleOf, recallModeOf, sessionLayerEnabledOf, writeUiSettings } from "./settings.js";
import { TURN_ADDITIONAL_BUDGET } from "./context-budget.js";
import { discoverWorkbuddyFiles, discoverExternalFiles, exportMarkdown, importWorkbuddy, importExternal } from "./markdown.js";
import { checkNpmUpdate, installedVersion } from "./update.js";
import { writeGateMessage } from "./hygiene.js";
import { backfillSessionMap, cutSessionMap, renameEpisode, sessionMapSnapshot } from "./episode.js";
import { applyPinsUpdate, addChipsFromText, batchChipAction, listChips, readSessionPins } from "./pins.js";
import {
  historyOf,
  nodeDetail,
  REVISION_CODES,
  revisionMessage,
  revokeSupersession,
  supersede,
  withWorkspaceQueue,
} from "./revisions.js";
import { provenanceOf } from "./provenance.js";
import { getTrace, listTraces, listTracesForCwd } from "./recall-trace.js";
import { recallPreview } from "./recall-preview.js";
import { sidecarHealth } from "./sidecar.js";

export { readUiSettings, writeUiSettings } from "./settings.js";

function isLoopback(req) {
  const ra = req.socket && req.socket.remoteAddress;
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

function isAllowedOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const h = u.hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

function isKnownCwd(cwd) {
  if (!cwd) return false;
  const r = resolve(cwd);
  if (listOpenWorkspaces().some((c) => resolve(c.cwd) === r)) return true;
  if (listedWorkspaces().some((c) => resolve(c) === r)) return true;
  return false;
}

function sendText(res, status, body, contentType) {
  const data = Buffer.from(String(body || ""), "utf8");
  res.writeHead(status, {
    "content-type": contentType || "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(data.length),
  });
  res.end(data);
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": String(data.length),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function dbForRequest(url) {
  const paramCwd = url.searchParams.get("cwd");
  const cwd = paramCwd || getActiveCwd();
  if (!cwd) return { cwd: null, db: null };
  if (paramCwd && !isKnownCwd(cwd)) return { cwd: null, db: null };
  return { cwd, db: await openWorkspaceDb(cwd) };
}

export function registerMemoryApi(ctx, { liveOptions, status }) {
  const dispose = ctx.webServer.register({
    kind: "prefix",
    path: "/api/dsh-trivium",
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const m = req.method || "GET";
      if (m !== "GET" && m !== "HEAD" && !isAllowedOrigin(req)) {
        res.writeHead(403);
        res.end("forbidden origin");
        return;
      }
      try {
        await handle(req, res, { liveOptions, status });
      } catch (err) {
        const lock = describeDbFailure(err);
        if (lock) {
          sendJson(res, lock.status, {
            ok: false,
            code: lock.code,
            message: lock.message,
            detail: lock.detail,
          });
          return;
        }
        sendJson(res, 500, { ok: false, message: String(err.message || err) });
      }
    },
  });
  return dispose;
}

async function handle(req, res, { liveOptions, status }) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = req.method || "GET";

  if (path === "/api/dsh-trivium/status" && method === "GET") {
    const opts = liveOptions();
    const paramCwd = url.searchParams.get("cwd");
    const cwd = paramCwd ? (isKnownCwd(paramCwd) ? paramCwd : "") : getActiveCwd();
    let nodeCount = 0;
    let dbPath = cwd ? dbPathFor(cwd) : "";
    if (cwd) {
      const db = await openWorkspaceDb(cwd);
      nodeCount = nodeCountOf(db);
      dbPath = dbPathFor(cwd);
    }
    const mode = recallModeOf(opts);
    sendJson(res, 200, {
      ok: true,
      cwd: cwd || "",
      dbPath,
      dbExists: dbPath ? existsSync(dbPath) : false,
      nodeCount,
      lastInjectTokens: status.lastInjectTokens || 0,
      lastInjectAt: status.lastInjectAt || null,
      lastExtract: status.lastExtract || null,
      // Estimates, not model tokens: the UI must label them as such.
      mapTokenBudget: opts.mapTokenBudget || 400,
      turnTokenBudget: TURN_ADDITIONAL_BUDGET,
      lastContextPlan: status.lastContextPlan
        ? {
            at: status.lastContextPlan.at,
            tokens: status.lastContextPlan.tokens,
            budget: status.lastContextPlan.budget,
            records: status.lastContextPlan.records,
            deferred: status.lastContextPlan.deferred,
          }
        : null,
      preStep: status.preStep || null,
      lastTrace: status.lastTrace
        ? { traceId: status.lastTrace.traceId, at: status.lastTrace.at, tokens: status.lastTrace.tokens }
        : null,
      version: installedVersion(),
      recallMode: mode,
      autoRecall: mode === "auto",
      anchorRecall: mode === "anchor",
      extractEnabled: opts.extractEnabled !== false,
      chipsEnabled: chipsEnabledOf(opts),
      sessionLayerEnabled: opts.sessionLayerEnabled === true,
      gitSidecarEnabled: gitSidecarEnabledOf(opts),
      pluginLocale: pluginLocaleOf(opts),
      configPanelOpen: configPanelOpenOf(opts),
      writeApproval: !!opts.writeApproval,
      workspaces: listOpenWorkspaces(),
      // The graph is authoritative; the JSONL file is derived. Report its state
      // instead of pretending the two files are one atomic unit.
      derived: { sidecar: sidecarHealth() },
      ...embeddingPublicStatus(),
    });
    return;
  }

  if (path === "/api/dsh-trivium/settings" && method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const saved = writeUiSettings(body);
    const opts = liveOptions();
    sendJson(res, 200, {
      ok: true,
      ...opts,
      recallMode: recallModeOf(opts),
      ...embeddingPublicStatus(),
      embeddingApiKey: undefined,
    });
    return;
  }

  if (path === "/api/dsh-trivium/sidecar/generate" && method === "POST") {
    if (!gitSidecarEnabledOf(liveOptions())) {
      sendJson(res, 400, { ok: false, message: "git sidecar off" });
      return;
    }
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    sendJson(res, 200, generateSidecarFromDb(cwd, db));
    return;
  }

  if (path === "/api/dsh-trivium/sidecar/delete" && method === "POST") {
    if (gitSidecarEnabledOf(liveOptions())) {
      sendJson(res, 400, { ok: false, message: "turn sidecar off first" });
      return;
    }
    sendJson(res, 200, deleteGitSidecars());
    return;
  }

  if (path === "/api/dsh-trivium/export" && method === "GET") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    sendJson(res, 200, { ok: true, cwd, graph: exportGraph(db, cwd) });
    return;
  }

  if (path === "/api/dsh-trivium/export.md" && method === "GET") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    sendText(res, 200, exportMarkdown(db, { cwd }), "text/markdown; charset=utf-8");
    return;
  }

  if (path === "/api/dsh-trivium/update" && method === "GET") {
    const force = url.searchParams.get("force") === "1";
    sendJson(res, 200, await checkNpmUpdate({ force }));
    return;
  }

  if (path === "/api/dsh-trivium/workbuddy" && method === "GET") {
    const cwd = url.searchParams.get("cwd") || getActiveCwd() || "";
    sendJson(res, 200, { ok: true, cwd, files: discoverWorkbuddyFiles(cwd) });
    return;
  }

  if (path === "/api/dsh-trivium/external" && method === "GET") {
    const cwd = url.searchParams.get("cwd") || getActiveCwd() || "";
    sendJson(res, 200, { ok: true, cwd, files: discoverExternalFiles(cwd) });
    return;
  }

  if (path === "/api/dsh-trivium/import-workbuddy" && method === "POST") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "还没有打开工作区" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : undefined;
    const result = importWorkbuddy(db, { cwd, ids });
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (path === "/api/dsh-trivium/import-external" && method === "POST") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "还没有打开工作区" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : undefined;
    const result = importExternal(db, { cwd, ids });
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (path === "/api/dsh-trivium/import" && method === "POST") {
    const { db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "还没有打开工作区" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = importGraph(db, body.graph || body);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (path === "/api/dsh-trivium/embed-backfill" && method === "POST") {
    const { db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    liveOptions();
    const result = await backfillEmbeddings(db);
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }

  if (path === "/api/dsh-trivium/nodes" && method === "GET") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 200, { ok: true, cwd: "", nodes: [] });
      return;
    }
    const type = url.searchParams.get("type") || "";
    const q = url.searchParams.get("q") || "";
    const includeArchived = url.searchParams.get("archived") === "1";
    const includeStale = url.searchParams.get("stale") === "1";
    // "Show expired" and "show replaced" are separate switches.
    const includeSuperseded = url.searchParams.get("superseded") === "1";
    const about = url.searchParams.get("about") || "";
    sendJson(res, 200, {
      ok: true,
      cwd,
      nodes: listNodes(db, {
        type: type || undefined,
        q: q || undefined,
        includeArchived,
        includeStale,
        includeSuperseded,
        aboutId: about || undefined,
      }),
    });
    return;
  }

  /*
   * Detail / provenance / history are read-on-demand surfaces. The detail
   * response is a header only; full quotes and full history bodies stay behind
   * their own endpoints so the list cannot accidentally pull all of it.
   */
  const detailMatch = path.match(/^\/api\/dsh-trivium\/nodes\/(\d+)\/detail$/);
  if (detailMatch && method === "GET") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const detail = nodeDetail(db, detailMatch[1]);
    sendJson(res, detail ? 200 : 404, detail || { ok: false, message: "not found" });
    return;
  }

  const provenanceMatch = path.match(/^\/api\/dsh-trivium\/nodes\/(\d+)\/provenance$/);
  if (provenanceMatch && method === "GET") {
    const { db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const prov = provenanceOf(db, provenanceMatch[1]);
    sendJson(res, prov ? 200 : 404, prov || { ok: false, message: "not found" });
    return;
  }

  const historyMatch = path.match(/^\/api\/dsh-trivium\/nodes\/(\d+)\/history$/);
  if (historyMatch && method === "GET") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const result = historyOf(db, historyMatch[1], {
      limit: url.searchParams.get("limit") || 20,
      cursor: url.searchParams.get("cursor") || "",
    });
    if (!result.ok) {
      sendJson(res, 409, { ok: false, reason: result.reason, message: "version chain unresolved", ...result });
      return;
    }
    sendJson(res, 200, { ok: true, cwd, ...result });
    return;
  }

  if (path === "/api/dsh-trivium/recall-traces" && method === "GET") {
    const cwd = url.searchParams.get("cwd") || getActiveCwd() || "";
    if (url.searchParams.get("cwd") && !isKnownCwd(cwd)) {
      sendJson(res, 400, { ok: false, message: "unknown workspace" });
      return;
    }
    const sessionId = url.searchParams.get("session") || "";
    const limit = url.searchParams.get("limit") || undefined;
    sendJson(res, 200, {
      ok: true,
      cwd,
      sessionId,
      // No session filter means "every session of this workspace", which is
      // still one workspace boundary. A session filter narrows it further.
      traces: sessionId
        ? listTraces({ cwd, sessionId, limit })
        : listTracesForCwd({ cwd, limit }),
    });
    return;
  }

  const traceMatch = path.match(/^\/api\/dsh-trivium\/recall-traces\/([A-Za-z0-9-]+)$/);
  if (traceMatch && method === "GET") {
    const cwd = url.searchParams.get("cwd") || getActiveCwd() || "";
    const found = getTrace(traceMatch[1], { cwd, sessionId: url.searchParams.get("session") || "" });
    if (!found.ok) {
      // 410 for an expired id, 404 for another workspace/session: the caller
      // learns nothing about traces that are not theirs.
      sendJson(res, found.status, { ok: false, message: found.message });
      return;
    }
    sendJson(res, 200, { ok: true, cwd, trace: found.trace });
    return;
  }

  if (path === "/api/dsh-trivium/recall-preview" && method === "POST") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const sessionId = body.sessionId || url.searchParams.get("sessionId") || "";
    const opts = liveOptions();
    const result = recallPreview(db, {
      cwd,
      sessionId,
      query: body.query,
      mode: body.mode || recallModeOf(opts),
    });
    sendJson(res, result.ok ? 200 : result.status || 400, { ...result, cwd, sessionId });
    return;
  }

  const mergeMatch = path.match(/^\/api\/dsh-trivium\/nodes\/(\d+)\/merge$/);
  if (mergeMatch && method === "POST") {
    const { db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = mergeNodes(db, mergeMatch[1], body.dropId);
    sendJson(res, result.status || (result.ok ? 200 : 400), result);
    return;
  }

  /*
   * Revision writes. Every one of them is validated server-side inside the
   * workspace queue: the client's hidden buttons and the prototype's demo
   * state are not trusted, and the second window always loses on a stale ETag.
   */
  const supersedeMatch = path.match(/^\/api\/dsh-trivium\/nodes\/(\d+)\/supersede$/);
  if (supersedeMatch && method === "POST") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = await withWorkspaceQueue(cwd, () =>
      supersede(db, {
        oldId: supersedeMatch[1],
        successorId: body.successorId,
        reason: body.reason,
        expectedEtags: body.expectedEtags,
        operationId: body.operationId,
      }),
    );
    sendJson(res, result.ok ? 200 : result.status || 400, {
      ...result,
      cwd,
      detail: result.ok ? null : revisionMessage(result.code),
    });
    return;
  }

  const revokeMatch = path.match(/^\/api\/dsh-trivium\/nodes\/(\d+)\/supersession\/revoke$/);
  if (revokeMatch && method === "POST") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = await withWorkspaceQueue(cwd, () =>
      revokeSupersession(db, {
        oldId: revokeMatch[1],
        successorId: body.successorId,
        expectedEtags: body.expectedEtags,
        operationId: body.operationId,
      }),
    );
    sendJson(res, result.ok ? 200 : result.status || 400, {
      ...result,
      cwd,
      detail: result.ok ? null : revisionMessage(result.code),
    });
    return;
  }

  const patchMatch = path.match(/^\/api\/dsh-trivium\/nodes\/(\d+)$/);
  if (patchMatch && method === "POST") {
    const { db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      const payload = updateNode(db, patchMatch[1], body);
      sendJson(res, payload ? 200 : 404, { ok: Boolean(payload), id: Number(patchMatch[1]), payload });
    } catch (err) {
      if (err?.code === "DIRTY") {
        sendJson(res, 400, { ok: false, message: writeGateMessage(err.message) });
        return;
      }
      throw err;
    }
    return;
  }

  const nodeMatch = path.match(/^\/api\/dsh-trivium\/nodes\/(\d+)\/(archive|delete)$/);
  if (nodeMatch && method === "POST") {
    const { db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const id = Number(nodeMatch[1]);
    try {
      const ok = nodeMatch[2] === "archive" ? archiveNode(db, id) : deleteNode(db, id);
      sendJson(res, ok ? 200 : 404, { ok, id });
    } catch (err) {
      // A node inside a revision chain needs its relation handled first.
      if (err?.code === "REVISION_LINKED") {
        sendJson(res, 409, { ok: false, id, code: err.code, message: revisionMessage(REVISION_CODES.revisionLinked) });
        return;
      }
      throw err;
    }
    return;
  }

  if (path === "/api/dsh-trivium/map" && method === "GET") {
    const { cwd, db } = await dbForRequest(url);
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!db) {
      sendJson(res, 200, { ok: true, cwd: cwd || "", sessionId, nodes: [], edges: [] });
      return;
    }
    const snap = sessionMapSnapshot(db, sessionId);
    sendJson(res, 200, { ok: true, cwd, ...snap });
    return;
  }

  if (path === "/api/dsh-trivium/map/backfill" && method === "POST") {
    if (!sessionLayerEnabledOf(liveOptions())) {
      sendJson(res, 400, { ok: false, message: "session layer off" });
      return;
    }
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const sessionId = body.sessionId || url.searchParams.get("sessionId") || "";
    const result = backfillSessionMap(db, {
      sessionId,
      compactations: body.compactations,
      forks: body.forks,
    });
    sendJson(res, 200, { ok: true, cwd, sessionId, ...result });
    return;
  }

  if (path === "/api/dsh-trivium/map/cut" && method === "POST") {
    if (!sessionLayerEnabledOf(liveOptions())) {
      sendJson(res, 400, { ok: false, message: "session layer off" });
      return;
    }
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const sessionId = body.sessionId || url.searchParams.get("sessionId") || "";
    const result = cutSessionMap(db, {
      sessionId,
      atSeq: body.atSeq,
      summary: body.summary,
    });
    sendJson(res, result.ok ? 200 : 400, { cwd, sessionId, ...result });
    return;
  }

  if (path === "/api/dsh-trivium/chips" && method === "GET") {
    const { cwd, db } = await dbForRequest(url);
    const q = url.searchParams.get("q") || "";
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!db) {
      sendJson(res, 200, { ok: true, cwd: cwd || "", sessionId, q, chips: [] });
      return;
    }
    sendJson(res, 200, { ok: true, cwd, sessionId, q, chips: listChips(db, { q, sessionId }) });
    return;
  }

  if (path === "/api/dsh-trivium/chips" && method === "POST") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const sessionId = body.sessionId || url.searchParams.get("sessionId") || "";
    const result = addChipsFromText(db, body.text, { sessionId, pin: body.pin !== false });
    const pin = readSessionPins(db, sessionId);
    sendJson(res, result.ok ? 200 : 400, {
      ...result,
      cwd,
      sessionId,
      chips: listChips(db, { sessionId }),
      pinIds: pin.ids,
      clipped: pin.clipped,
    });
    return;
  }

  if (path === "/api/dsh-trivium/chips/batch" && method === "POST") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const sessionId = body.sessionId || url.searchParams.get("sessionId") || "";
    const result = batchChipAction(db, {
      action: body.action,
      ids: body.ids,
      sessionId,
    });
    const pin = readSessionPins(db, sessionId);
    sendJson(res, result.ok ? 200 : 400, {
      ...result,
      cwd,
      sessionId,
      chips: listChips(db, { sessionId }),
      pinIds: pin.ids,
      clipped: pin.clipped,
    });
    return;
  }

  if (path === "/api/dsh-trivium/pins" && method === "GET") {
    const { cwd, db } = await dbForRequest(url);
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!db) {
      sendJson(res, 200, { ok: true, cwd: cwd || "", sessionId, ids: [], clipped: false, tokens: 0 });
      return;
    }
    const pin = readSessionPins(db, sessionId);
    sendJson(res, 200, { ok: true, cwd, sessionId, ids: pin.ids, clipped: pin.clipped, tokens: pin.tokens });
    return;
  }

  if (path === "/api/dsh-trivium/pins" && method === "POST") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const sessionId = body.sessionId || url.searchParams.get("sessionId") || "";
    const pin = applyPinsUpdate(db, { ...body, sessionId });
    sendJson(res, 200, { ok: true, cwd, sessionId, ids: pin.ids, clipped: pin.clipped, tokens: pin.tokens });
    return;
  }

  const episodeMatch = path.match(/^\/api\/dsh-trivium\/episodes\/(\d+)$/);
  if (episodeMatch && method === "POST") {
    const { cwd, db } = await dbForRequest(url);
    if (!db) {
      sendJson(res, 400, { ok: false, message: "no workspace" });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = renameEpisode(db, episodeMatch[1], body.name);
    sendJson(res, result.ok ? 200 : result.status || 400, {
      ok: result.ok,
      cwd,
      id: Number(episodeMatch[1]),
      name: result.name || "",
      summary: result.summary || "",
      message: result.message,
    });
    return;
  }

  sendJson(res, 404, { ok: false, message: "not found" });
}

export { handle as handleMemoryApi };
