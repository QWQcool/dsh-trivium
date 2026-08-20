/**
 * Third knife: episode.name rename does not touch summary;
 * GET /map returns name; POST /episodes/:id ignores text/summary;
 * non-episode id rejected. Temp dirs only — does not open a live .tdb.
 */
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCheckpoint, renameEpisode, sessionMapSnapshot } from "../lib/episode.js";
import { handleMemoryApi } from "../lib/server.js";
import { SETTINGS_FILE } from "../lib/settings.js";
import { closeAll, insertNode, listNodes, openWorkspaceDb } from "../lib/store.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p9-"));
let failed = 0;
const prevSettings = existsSync(SETTINGS_FILE) ? readFileSync(SETTINGS_FILE, "utf8") : null;
let server;

function assert(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return;
  }
  failed += 1;
  console.error("FAIL " + msg);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      handleMemoryApi(req, res, { liveOptions: () => ({}), status: {} }).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ ok: false, message: String(err.message || err) }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
}

function request(method, path, body) {
  const { port } = server.address();
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: payload
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = { raw: text };
          }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

try {
  const db = await openWorkspaceDb(cwd);
  const sessionId = "sess-p9";
  const summary = "本段：鉴权改为 header X，并修了登录超时。";
  const ep = recordCheckpoint(db, {
    sessionId,
    atSeq: 40,
    compactionId: "cmp-p9",
    summary,
  });
  assert(Number.isFinite(ep), "checkpoint episode inserted");

  const before = db.get(ep)?.payload || {};
  assert(before.summary === summary, "checkpoint summary is DSH text");
  assert(before.text === summary, "checkpoint text mirrors summary");

  const snap0 = sessionMapSnapshot(db, sessionId);
  const mapped = snap0.nodes.find((n) => n.id === ep);
  assert(mapped && typeof mapped.name === "string", "GET-style snapshot includes name");
  assert(mapped.summary === summary, "snapshot summary unchanged before rename");

  const renamed = renameEpisode(db, ep, "登录超时");
  assert(renamed.ok === true && renamed.name === "登录超时", "renameEpisode writes name");
  const after = db.get(ep)?.payload || {};
  assert(after.name === "登录超时", "payload.name is the hand title");
  assert(after.summary === summary, "rename does not change summary");
  assert(after.text === summary, "rename does not change text");

  const again = recordCheckpoint(db, {
    sessionId,
    atSeq: 40,
    compactionId: "cmp-p9",
    summary,
  });
  assert(again === ep, "same uri reuses checkpoint");
  const kept = db.get(ep)?.payload || {};
  assert(kept.name === "登录超时", "compaction upsert keeps the hand name");
  assert(kept.summary === summary, "compaction upsert keeps summary");

  const listed = listNodes(db);
  assert(!listed.some((n) => n.type === "episode"), "settings list still hides episodes");

  const pref = insertNode(db, { type: "preference", name: "keep-me", text: "do not overwrite" });
  const rejected = renameEpisode(db, pref, "hack");
  assert(rejected.ok === false, "renameEpisode rejects non-episode id");
  assert(db.get(pref)?.payload?.text === "do not overwrite", "rejected rename does not touch preference");

  server = await startServer();
  const qs = "?cwd=" + encodeURIComponent(cwd) + "&sessionId=" + encodeURIComponent(sessionId);

  const mapResp = await request("GET", "/api/dsh-trivium/map" + qs);
  assert(mapResp.status === 200 && mapResp.data.ok === true, "GET /map 200");
  const mapNode = (mapResp.data.nodes || []).find((n) => n.id === ep);
  assert(mapNode && mapNode.name === "登录超时", "GET /map returns name");
  assert(mapNode.summary === summary, "GET /map summary still DSH text");

  const hack = await request("POST", "/api/dsh-trivium/episodes/" + ep + "?cwd=" + encodeURIComponent(cwd), {
    name: "鉴权改 header",
    text: "HACK-TEXT",
    summary: "HACK-SUMMARY",
  });
  assert(hack.status === 200 && hack.data.ok === true, "POST /episodes/:id 200");
  assert(hack.data.name === "鉴权改 header", "POST returns the new name");
  const afterHack = db.get(ep)?.payload || {};
  assert(afterHack.name === "鉴权改 header", "POST persists name");
  assert(afterHack.summary === summary, "POST with text/summary in body does not overwrite summary");
  assert(afterHack.text === summary, "POST with text in body does not overwrite text");

  const bad = await request("POST", "/api/dsh-trivium/episodes/" + pref + "?cwd=" + encodeURIComponent(cwd), {
    name: "nope",
    text: "HACK-PREF",
  });
  assert(bad.status === 400 && bad.data.ok === false, "POST non-episode id is rejected");
  assert(db.get(pref)?.payload?.text === "do not overwrite", "rejected POST does not overwrite preference text");
} catch (err) {
  failed += 1;
  console.error("FAIL exception " + (err && err.stack ? err.stack : err));
} finally {
  await new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
  closeAll();
  try {
    if (prevSettings == null) {
      try {
        rmSync(SETTINGS_FILE, { force: true });
      } catch {
        // ignore
      }
    } else {
      writeFileSync(SETTINGS_FILE, prevSettings, "utf8");
    }
  } catch {
    // ignore
  }
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("smoke-p9 ok");
