/**
 * Live P2: feed extractable facts through DSH, wait for pending replay,
 * then check Settings nodes + a few ctx_find calls. Do not open .tdb here.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.DSH_PORT || 3090);
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = join(homedir(), "Desktop", "dsh-trivium-p2c");
let failed = 0;

function ok(cond, msg) {
  if (cond) console.log("ok  " + msg);
  else {
    failed += 1;
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
  if (!body?.result?.ok) {
    throw new Error(`${method}: ${JSON.stringify(body.result || body).slice(0, 400)}`);
  }
  return body.result.value;
}

async function trivium(path) {
  const res = await fetch(`${BASE}${path}`);
  return res.json();
}

function eventsOf(hist) {
  return (hist.events || []).map((r) => r.event || r);
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

function toolBlob(events) {
  return events
    .filter((e) => e.type === "tool/call" || e.type === "tool/result")
    .map((e) => {
      if (e.type === "tool/call") return `CALL ${e.data.name} ${e.data.arguments}`;
      return `RESULT ${contentText(e.data?.message?.content || e.data?.content)}`;
    })
    .join("\n");
}

async function waitTurn(sessionId, afterSeq, timeoutMs = 180000) {
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

const FACTS = [
  "记住，本仓库鉴权走 header X。TriviumDB 是内核。",
  "以后都用 pnpm，不要用 npm。",
  "别再把 README 改成英文。",
  "从现在起回复用中文。",
  "Remember to run tests before commit.",
  "AuthGateway 接登录。AuthGateway 不要暴露端口。",
  "dsh-trivium 是插件。我们继续用 dsh-trivium。",
  "DeepSeek_Harness 是宿主。DeepSeek_Harness 钉死 rc.6。",
  "日志相关键是 X-Request-Id。网关也回传 X-Request-Id。",
  "先别动 AuthGateway，下周再改。",
  "采用方案 A 做登录。",
  "就用这个 TriviumDB 单文件，不要另起服务。",
  "postpone the migration until Friday.",
  "哈哈今天天气真好。",
  "把这个文件改了就行。",
  "记住 api_key=sk-abc123token。",
  "查询「鉴权」是什么意思？",
  "嗯好的。",
].join("\n");

function blobOf(nodes) {
  return (nodes || []).map((n) => `[${n.type}] ${n.name} ${n.text} until=${n.until || ""}`).join("\n");
}

try {
  mkdirSync(CWD, { recursive: true });
  writeFileSync(join(CWD, "README.md"), "p2 live workspace\n");

  const st0 = await trivium("/api/dsh-trivium/status");
  ok(st0.autoRecall === false, "autoRecall off");
  ok(st0.extractEnabled !== false, "extract enabled");

  const a = await rpc("session.create", { cwd: CWD });
  let hist = eventsOf(await rpc("session.history", { sessionId: a.sessionId, maxMessages: 20 }));
  await rpc("session.prompt", {
    sessionId: a.sessionId,
    mode: "queue",
    content: [
      {
        type: "text",
        text: "记住，本仓库鉴权走 header X。TriviumDB 是内核。\n不要改文件，不要调用任何工具，只回复「记下了」。",
      },
    ],
  });
  hist = await waitTurn(a.sessionId, hist.reduce((m, e) => Math.max(m, e.seq || 0), 0));
  ok(hist.some((e) => e.type === "turn/end"), "session A cue turn ended");
  await rpc("session.prompt", {
    sessionId: a.sessionId,
    mode: "queue",
    content: [
      {
        type: "text",
        text: `${FACTS}\n\n不要改文件，不要调用任何工具，只回复「记下了」。`,
      },
    ],
  });
  hist = await waitTurn(a.sessionId, hist.reduce((m, e) => Math.max(m, e.seq || 0), 0));
  ok(hist.some((e) => e.type === "turn/end"), "session A packed turn ended");

  const b = await rpc("session.create", { cwd: CWD });
  let extract = null;
  let nodes = [];
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await trivium(`/api/dsh-trivium/status?cwd=${encodeURIComponent(CWD)}`);
    const listed = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(CWD)}`);
    nodes = listed.nodes || [];
    extract = st.lastExtract;
    if (extract?.applied?.length || nodes.some((n) => n.type === "preference")) break;
  }
  console.log("lastExtract", JSON.stringify(extract));
  console.log(blobOf(nodes));
  ok(nodes.some((n) => n.type === "preference"), "extract produced preferences");

  const cases = [
    { id: "P1", type: "preference", text: /header X/ },
    { id: "P2", type: "preference", text: /pnpm/ },
    { id: "P3", type: "preference", text: /README|英文/ },
    { id: "P4", type: "preference", text: /中文/ },
    { id: "P5", type: "preference", text: /tests/i },
    { id: "E1", type: "entity", text: /TriviumDB/ },
    { id: "E2", type: "entity", text: /AuthGateway/ },
    { id: "E3", type: "entity", text: /dsh-trivium/ },
    { id: "E4", type: "entity", text: /DeepSeek_Harness/ },
    { id: "E5", type: "entity", text: /X-Request-Id/ },
    { id: "D1", type: "decision", text: /AuthGateway|下周/ },
    { id: "D2", type: "decision", text: /方案 A/ },
    { id: "D3", type: "decision", text: /单文件/ },
    { id: "D4", type: "decision", text: /Friday|migration/i },
  ];
  for (const c of cases) {
    const hit = nodes.find((n) => n.type === c.type && c.text.test(`${n.name} ${n.text}`));
    ok(!!hit, `${c.id} live node ${c.type} ${c.text}`);
  }
  const d1 = nodes.find((n) => n.type === "decision" && /下周/.test(`${n.name} ${n.text}`));
  ok(!d1 || d1.until === "下周", `D1 until=下周 (got ${d1?.until || "missing"})`);
  ok(!nodes.some((n) => n.type === "entity" && n.name === "鉴权"), "N4 no entity 鉴权");
  ok(!nodes.some((n) => n.type === "entity" && n.name === "README"), "no singleton README entity");
  ok(!nodes.some((n) => n.type === "preference" && /天气/.test(`${n.name} ${n.text}`)), "N1 no weather pref");
  ok(!nodes.some((n) => n.type === "preference" && /把这个文件/.test(n.text)), "N2 no oneshot pref");
  ok(!nodes.some((n) => /sk-abc123/.test(`${n.name} ${n.text}`)), "N3 secret not stored");
  ok(!nodes.some((n) => n.type === "preference" && /^嗯好的/.test(n.text.trim())), "N5 no chitchat pref");

  const stMap = await trivium(`/api/dsh-trivium/status?cwd=${encodeURIComponent(CWD)}`);
  ok((stMap.lastInjectTokens || 0) <= 400, `short map ${stMap.lastInjectTokens} <= 400`);

  hist = eventsOf(await rpc("session.history", { sessionId: b.sessionId, maxMessages: 20 }));
  await rpc("session.prompt", {
    sessionId: b.sessionId,
    mode: "queue",
    content: [{ type: "text", text: "只用 ctx_find 查询鉴权，贴工具原文。不要改文件。" }],
  });
  hist = await waitTurn(b.sessionId, hist.reduce((m, e) => Math.max(m, e.seq || 0), 0));
  const blobB = toolBlob(hist);
  console.log(blobB);
  ok(/鉴权|header X/.test(blobB), "session B ctx_find 鉴权 hit");
  ok(/about->/.test(blobB), "find path contains about->");

  const c = await rpc("session.create", { cwd: CWD });
  hist = eventsOf(await rpc("session.history", { sessionId: c.sessionId, maxMessages: 20 }));
  await rpc("session.prompt", {
    sessionId: c.sessionId,
    mode: "queue",
    content: [{ type: "text", text: "只用 ctx_find 查询天气，贴工具原文。不要改文件。" }],
  });
  hist = await waitTurn(c.sessionId, hist.reduce((m, e) => Math.max(m, e.seq || 0), 0));
  const blobC = toolBlob(hist);
  console.log(blobC);
  ok(!/preference/.test(blobC) || !/天气真好/.test(blobC), "session C weather is not a preference hit");
} catch (err) {
  failed += 1;
  console.error("FAIL exception", err);
}

if (failed) {
  console.error(`live P2 failed (${failed})`);
  process.exit(1);
}
console.log("live P2 passed");
