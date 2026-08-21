import { existsSync } from "node:fs";
import {
  archiveNode,
  backfillEmbeddings,
  dbPathFor,
  deleteNode,
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
import { recallModeOf, writeUiSettings } from "./settings.js";
import { discoverWorkbuddyFiles, exportMarkdown, importWorkbuddy } from "./markdown.js";
import { renameEpisode, sessionMapSnapshot } from "./episode.js";
import { applyPinsUpdate, addChipsFromText, batchChipAction, listChips, readSessionPins } from "./pins.js";

export { readUiSettings, writeUiSettings } from "./settings.js";

function isLoopback(req) {
  const ra = req.socket && req.socket.remoteAddress;
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
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
  const cwd = url.searchParams.get("cwd") || getActiveCwd();
  if (!cwd) return { cwd: null, db: null };
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
      try {
        await handle(req, res, { liveOptions, status });
      } catch (err) {
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
    const cwd = url.searchParams.get("cwd") || getActiveCwd();
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
      recallMode: mode,
      autoRecall: mode === "auto",
      anchorRecall: mode === "anchor",
      extractEnabled: opts.extractEnabled !== false,
      writeApproval: !!opts.writeApproval,
      mapTokenBudget: opts.mapTokenBudget || 400,
      workspaces: listOpenWorkspaces(),
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

  if (path === "/api/dsh-trivium/workbuddy" && method === "GET") {
    const cwd = url.searchParams.get("cwd") || getActiveCwd() || "";
    sendJson(res, 200, { ok: true, cwd, files: discoverWorkbuddyFiles(cwd) });
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
    const about = url.searchParams.get("about") || "";
    sendJson(res, 200, {
      ok: true,
      cwd,
      nodes: listNodes(db, {
        type: type || undefined,
        q: q || undefined,
        includeArchived,
        includeStale,
        aboutId: about || undefined,
      }),
    });
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
    sendJson(res, result.ok ? 200 : 400, result);
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
    const payload = updateNode(db, patchMatch[1], body);
    sendJson(res, payload ? 200 : 404, { ok: Boolean(payload), id: Number(patchMatch[1]), payload });
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
    const ok = nodeMatch[2] === "archive" ? archiveNode(db, id) : deleteNode(db, id);
    sendJson(res, ok ? 200 : 404, { ok, id });
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
