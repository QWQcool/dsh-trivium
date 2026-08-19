import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = "http://127.0.0.1:3090";
const CWD = join(homedir(), "Desktop", "dsh-trivium-verify");
const CWD2 = join(homedir(), "Desktop", "dsh-trivium-verify2");
let failed = 0;
function ok(cond, msg) {
  if (cond) console.log("ok  " + msg);
  else {
    failed++;
    console.error("FAIL " + msg);
  }
  return cond;
}

async function rpc(method, payload = {}) {
  const rpcId = randomUUID();
  const res = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
  });
  const body = await res.json();
  if (!body?.result?.ok) throw new Error(`${method}: ${JSON.stringify(body.result || body).slice(0, 400)}`);
  return body.result.value;
}

async function trivium(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || "GET",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res.json();
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((b) => {
      if (!b) return [];
      if (b.type === "text" && b.text) return [b.text];
      if (b.type === "tool-result") return [contentText(b.content)];
      return [];
    })
    .join("\n");
}

function eventsOf(hist) {
  return (hist.events || []).map((r) => r.event || r);
}

function toolBlob(events) {
  return events
    .filter((e) => e.type === "tool/call" || e.type === "tool/result")
    .map((e) => {
      if (e.type === "tool/call") return `CALL ${e.data.name} ${e.data.arguments}`;
      return `RESULT ${contentText(e.data?.message?.content || e.data?.content)}`;
    })
    .join("\n");
}

async function waitTurn(sessionId, afterSeq, timeoutMs = 120000) {
  const start = Date.now();
  let saw = false;
  let last = [];
  while (Date.now() - start < timeoutMs) {
    const list = await rpc("session.list", {});
    const row = (list.items || []).find((s) => s.sessionId === sessionId);
    last = eventsOf(await rpc("session.history", { sessionId, maxMessages: 80 }));
    if (row?.running) saw = true;
    const newer = last.filter((e) => Number(e.seq || 0) > afterSeq);
    if (row && !row.running && saw && newer.some((e) => e.type === "turn/end" || e.type === "tool/result")) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("timeout waiting for turn; types=" + last.map((e) => e.type).join(","));
}

try {
  const st0 = await trivium("/api/dsh-trivium/status");
  ok(st0.autoRecall === false, "autoRecall off");
  ok((st0.lastInjectTokens || 0) <= 400, `inject tokens ${st0.lastInjectTokens} <= 400`);

  const sReplay = await rpc("session.create", { cwd: CWD });
  let extractOk = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await trivium(`/api/dsh-trivium/status?cwd=${encodeURIComponent(CWD)}`);
    const nodes = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(CWD)}`);
    const pnpm = (nodes.nodes || []).filter((n) => /pnpm/i.test(`${n.text} ${n.name}`));
    let pendingErr = null;
    try {
      pendingErr = JSON.parse(readFileSync(join(CWD, ".dsh", "trivium-pending.json"), "utf8")).error;
    } catch {
      pendingErr = "cleared";
    }
    if (pnpm.length || st.lastExtract) {
      extractOk = true;
      ok(true, `extract replay applied=${JSON.stringify(st.lastExtract)} pnpm=${pnpm.length} pending=${pendingErr}`);
      break;
    }
    if (pendingErr && pendingErr !== "cleared" && pendingErr !== "runtime is not defined" && i === 19) {
      ok(false, `extract still failing: ${pendingErr}`);
    }
  }
  ok(extractOk, "pending replay extracted 记住以后都用 pnpm");

  mkdirSync(CWD2, { recursive: true });
  writeFileSync(join(CWD2, "README.md"), "verify2\n");
  const a = await rpc("session.create", { cwd: CWD2 });
  let hist = eventsOf(await rpc("session.history", { sessionId: a.sessionId, maxMessages: 20 }));
  await rpc("session.prompt", {
    sessionId: a.sessionId,
    mode: "queue",
    content: [
      {
        type: "text",
        text: "只用 ctx_remember 和 ctx_link，不要改文件。ctx_remember entity name=dsh-trivium text=this repository；ctx_remember preference text=本仓库鉴权走 header X；ctx_link preference about entity。贴工具原文。",
      },
    ],
  });
  hist = await waitTurn(a.sessionId, hist.reduce((m, e) => Math.max(m, e.seq || 0), 0));
  const blobA = toolBlob(hist);
  console.log(blobA);
  ok(/Remembered id=/.test(blobA), "remember persisted");
  ok(/Linked /.test(blobA), "linked about");
  const map = hist.find((e) => e.type === "user/message" && e.data?.source?.plugin === "dsh-trivium");
  ok(!!map, "Trajectory user/message source.plugin=dsh-trivium");

  const b = await rpc("session.create", { cwd: CWD2 });
  hist = eventsOf(await rpc("session.history", { sessionId: b.sessionId, maxMessages: 20 }));
  await rpc("session.prompt", {
    sessionId: b.sessionId,
    mode: "queue",
    content: [{ type: "text", text: "只用 ctx_find 查询鉴权，贴工具原文。不要改文件。" }],
  });
  hist = await waitTurn(b.sessionId, hist.reduce((m, e) => Math.max(m, e.seq || 0), 0));
  const blobB = toolBlob(hist);
  console.log(blobB);
  ok(/鉴权|header X/.test(blobB), "session B find hit 鉴权");
  ok(/about->/.test(blobB), "find path contains about-> entity");
  ok(!/autoRecall/.test(blobB), "no autoRecall dump in tool output");
} catch (err) {
  failed++;
  console.error("FAIL exception", err);
}

if (failed) process.exit(1);
console.log("live re-verify passed");
