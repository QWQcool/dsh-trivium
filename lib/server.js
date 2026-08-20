import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  archiveNode,
  dbPathFor,
  deleteNode,
  getActiveCwd,
  listNodes,
  listOpenWorkspaces,
  nodeCountOf,
  openWorkspaceDb,
} from "./store.js";

const SETTINGS_FILE = join(homedir(), ".dsh", "trivium.json");

export function readUiSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function writeUiSettings(patch) {
  mkdirSync(join(homedir(), ".dsh"), { recursive: true });
  const next = { ...readUiSettings(), ...patch };
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function isLoopback(req) {
  const ra = req.socket && req.socket.remoteAddress;
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
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
    sendJson(res, 200, {
      ok: true,
      cwd: cwd || "",
      dbPath,
      dbExists: dbPath ? existsSync(dbPath) : false,
      nodeCount,
      lastInjectTokens: status.lastInjectTokens || 0,
      lastInjectAt: status.lastInjectAt || null,
      lastExtract: status.lastExtract || null,
      autoRecall: !!opts.autoRecall,
      extractEnabled: opts.extractEnabled !== false,
      writeApproval: !!opts.writeApproval,
      mapTokenBudget: opts.mapTokenBudget || 400,
      workspaces: listOpenWorkspaces(),
    });
    return;
  }

  if (path === "/api/dsh-trivium/settings" && method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const patch = {};
    if (typeof body.autoRecall === "boolean") patch.autoRecall = body.autoRecall;
    if (typeof body.extractEnabled === "boolean") patch.extractEnabled = body.extractEnabled;
    const saved = writeUiSettings(patch);
    sendJson(res, 200, { ok: true, ...liveOptions(), ...saved });
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

  sendJson(res, 404, { ok: false, message: "not found" });
}
