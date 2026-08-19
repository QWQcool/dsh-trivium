/**
 * Live P1 acceptance against the local DSH web (port from argv, default 3090).
 * Drives session.create / session.prompt over loopback RPC. Does not open the
 * workspace .tdb from this process (TriviumDB is single-process).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.DSH_PORT || 3090);
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = join(homedir(), "Desktop", "dsh-trivium-verify");
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return true;
  }
  failed += 1;
  console.error("FAIL " + msg);
  return false;
}

async function rpc(method, payload = {}) {
  const rpcId = randomUUID();
  const res = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method,
      payload,
    }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method} HTTP ${res.status} non-json: ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 400)}`);
  if (!body?.result?.ok) {
    throw new Error(`${method} rpc error: ${JSON.stringify(body.result || body).slice(0, 500)}`);
  }
  return body.result.value;
}

async function trivium(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(`${path} ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function flattenHistory(entries) {
  return (entries || []).map((row) => row.event || row);
}

function eventText(event) {
  const data = event?.data;
  if (!data) return "";
  if (typeof data.content === "string") return data.content;
  const content = data.content || data.message?.content;
  if (!Array.isArray(content)) return JSON.stringify(data).slice(0, 500);
  return content
    .map((b) => b.text || b.content || "")
    .filter(Boolean)
    .join("\n");
}

async function waitIdle(sessionId, label, { afterSeq = 0, timeoutMs = 180000 } = {}) {
  const start = Date.now();
  let last = [];
  let sawRunning = false;
  while (Date.now() - start < timeoutMs) {
    const list = await rpc("session.list", {});
    const row = (list.items || []).find((s) => s.sessionId === sessionId);
    const hist = await rpc("session.history", { sessionId, maxMessages: 80 });
    last = flattenHistory(hist.events);
    if (row?.running) sawRunning = true;
    const newer = last.filter((e) => Number(e.seq || 0) > afterSeq);
    const done =
      row &&
      !row.running &&
      (newer.some((e) => e.type === "turn/end") ||
        (sawRunning && newer.some((e) => e.type === "assistant/message" || e.type === "tool/result")));
    if (done) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.error(`[timeout] ${label} last types: ${last.map((e) => `${e.seq}:${e.type}`).join(",")}`);
  return last;
}

function maxSeq(events) {
  return events.reduce((m, e) => Math.max(m, Number(e.seq || 0)), 0);
}

function dumpTools(events) {
  const bits = [];
  for (const e of events) {
    if (e.type === "tool/call") bits.push(`CALL ${e.data?.name} ${String(e.data?.arguments || "").slice(0, 180)}`);
    if (e.type === "tool/result") bits.push(`RESULT ${eventText(e).slice(0, 400)}`);
  }
  return bits.join("\n");
}

mkdirSync(CWD, { recursive: true });
writeFileSync(join(CWD, "README.md"), "# dsh-trivium live verify workspace\n", "utf8");

try {
  const status0 = await trivium("/api/dsh-trivium/status");
  ok(status0.autoRecall === false, `autoRecall default off (got ${status0.autoRecall})`);
  ok(status0.extractEnabled !== false, "extractEnabled on");
  ok((status0.mapTokenBudget || 400) <= 400, "mapTokenBudget <= 400");
  ok((status0.lastInjectTokens || 0) <= 400, `lastInjectTokens ${status0.lastInjectTokens} <= 400`);

  const created = await rpc("session.create", { cwd: CWD });
  const sessionA = created.sessionId;
  ok(!!sessionA, `session A created ${sessionA}`);

  let histA = flattenHistory((await rpc("session.history", { sessionId: sessionA, maxMessages: 80 })).events);
  const mapHit = histA.find((e) => {
    if (e.type !== "user/message") return false;
    const src = e.data?.source;
    const text = eventText(e);
    return src?.plugin === "dsh-trivium" || text.includes("dsh-trivium memory map");
  });
  ok(!!mapHit, "session-start short map injected (Trajectory source dsh-trivium)");
  if (mapHit) {
    const text = eventText(mapHit);
    ok(!/autoRecall/i.test(text), "short map is not a full memory dump");
    console.log("    map:", text.replace(/\s+/g, " ").slice(0, 180));
  }

  const seqA0 = maxSeq(histA);
  await rpc("session.prompt", {
    sessionId: sessionA,
    mode: "queue",
    content: [
      {
        type: "text",
        text: [
          "只用 ctx_remember / ctx_link / ctx_find / ctx_read。不要读文件、不要改文件、不要用 bash。",
          "1) ctx_remember type=entity name=dsh-trivium text=this repository",
          "2) ctx_remember type=preference text=本仓库鉴权走 header X",
          "3) ctx_link the preference about the entity",
          "把每个工具返回原文贴出来。",
        ].join("\n"),
      },
    ],
  });
  histA = await waitIdle(sessionA, "session A remember+link", { afterSeq: seqA0 });
  const toolsA = dumpTools(histA);
  console.log(toolsA || "(no tool events)");
  ok(/ctx_remember/.test(toolsA), "session A called ctx_remember");
  ok(/Remembered id=/.test(toolsA), "ctx_remember persisted");
  ok(/ctx_link/.test(toolsA) || /Linked /.test(toolsA), "session A linked nodes");

  const nodesAfterA = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(CWD)}`);
  const prefs = (nodesAfterA.nodes || []).filter((n) => n.type === "preference" && /鉴权|header X/.test(n.text));
  const ents = (nodesAfterA.nodes || []).filter((n) => n.type === "entity" && /dsh-trivium/i.test(n.name || n.text));
  ok(prefs.length > 0, "Settings list shows preference 鉴权");
  ok(ents.length > 0, "Settings list shows entity dsh-trivium");

  const createdB = await rpc("session.create", { cwd: CWD });
  const sessionB = createdB.sessionId;
  ok(sessionA !== sessionB, "session B is a new session");
  let histB = flattenHistory((await rpc("session.history", { sessionId: sessionB, maxMessages: 80 })).events);
  ok(
    histB.some((e) => e.type === "user/message" && (e.data?.source?.plugin === "dsh-trivium" || eventText(e).includes("memory map"))),
    "session B also got dsh-trivium short map",
  );
  ok(
    !histB.some((e) => eventText(e).includes("autoRecall") && eventText(e).includes("L0 only")),
    "default pre-step did not inject autoRecall dump",
  );

  const seqB0 = maxSeq(histB);
  await rpc("session.prompt", {
    sessionId: sessionB,
    mode: "queue",
    content: [
      {
        type: "text",
        text: "只用 ctx_find。不要改文件。查询「鉴权」，把工具返回原文贴出（必须含 id、type、path）。",
      },
    ],
  });
  histB = await waitIdle(sessionB, "session B ctx_find", { afterSeq: seqB0 });
  const toolsB = dumpTools(histB);
  console.log(toolsB || "(no tool events)");
  ok(/ctx_find/.test(toolsB), "session B called ctx_find");
  ok(/鉴权|header X/.test(toolsB), "ctx_find(鉴权) hit preference text");
  ok(/about->/.test(toolsB) || /dsh-trivium/.test(toolsB), "find path mentions entity / about edge");

  const status1 = await trivium(`/api/dsh-trivium/status?cwd=${encodeURIComponent(CWD)}`);
  ok(status1.nodeCount >= 3, `nodeCount ${status1.nodeCount} >= 3`);
  ok(status1.lastInjectTokens <= 400, `session-start tokens ${status1.lastInjectTokens} <= 400`);
  ok(String(status1.dbPath).includes("trivium.tdb"), `dbPath ${status1.dbPath}`);

  const prefId = prefs[0]?.id;
  ok(prefId != null, "have preference id to archive");
  const createdC = await rpc("session.create", { cwd: CWD });
  const sessionC = createdC.sessionId;
  let histC0 = flattenHistory((await rpc("session.history", { sessionId: sessionC, maxMessages: 40 })).events);
  if (prefId != null) {
    await trivium(`/api/dsh-trivium/nodes/${prefId}/archive?cwd=${encodeURIComponent(CWD)}`, { method: "POST" });
  }
  const seqC0 = maxSeq(histC0);
  await rpc("session.prompt", {
    sessionId: sessionC,
    mode: "queue",
    content: [{ type: "text", text: "只用 ctx_find 查询「鉴权」，把工具返回原文贴出。不要改文件。" }],
  });
  const histC = await waitIdle(sessionC, "session C find after archive", { afterSeq: seqC0 });
  const toolsC = dumpTools(histC);
  console.log(toolsC || "(no tool events)");
  const archivedGone =
    /No memory hits/i.test(toolsC) ||
    (!new RegExp(`id=${prefId}\\b`).test(toolsC) && !/header X/.test(toolsC));
  ok(archivedGone, "archived preference no longer returned by find");

  const seqC1 = maxSeq(histC);
  await rpc("session.prompt", {
    sessionId: sessionC,
    mode: "queue",
    content: [
      {
        type: "text",
        text: "不要调用任何工具。用户说：记住以后都用 pnpm。只回复「收到」。",
      },
    ],
  });
  await waitIdle(sessionC, "session C extract cue", { afterSeq: seqC1 });
  const createdD = await rpc("session.create", { cwd: CWD });
  await new Promise((r) => setTimeout(r, 2500));
  const statusD = await trivium(`/api/dsh-trivium/status?cwd=${encodeURIComponent(CWD)}`);
  const nodesD = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(CWD)}`);
  const pnpm = (nodesD.nodes || []).filter((n) => /pnpm/i.test(n.text || n.name || ""));
  ok(
    pnpm.length > 0 || statusD.lastExtract,
    `extract replay left a pnpm node or lastExtract (${JSON.stringify(statusD.lastExtract)})`,
  );

  const oneshot = (nodesD.nodes || []).filter((n) => n.type === "preference" && /把这.*文件/.test(n.text));
  ok(oneshot.length === 0, "no oneshot file-edit preference in list");
} catch (err) {
  failed += 1;
  console.error("FAIL exception", err);
}

if (failed) {
  console.error(`live verify failed (${failed})`);
  process.exit(1);
}
console.log("live P1 verify passed");
