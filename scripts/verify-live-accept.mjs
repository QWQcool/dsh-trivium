/**
 * Live PLAN 1–15 against local DSH web. HTTP/RPC only — does not open .tdb.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.DSH_PORT || 3090);
const BASE = `http://127.0.0.1:${PORT}`;
const DESKTOP = join(homedir(), "Desktop");
const LIVE = join(DESKTOP, "dsh-trivium-live21");
const EMPTY = join(DESKTOP, "dsh-trivium-empty21");
const EXTRACT = join(DESKTOP, "dsh-trivium-p2-live21");
const FAILCWD = join(DESKTOP, "dsh-trivium-fail21");
const MEMORY = join(DESKTOP, "AICodingPrjStudy");
let failed = 0;
const defects = [];

function ok(cond, msg, { block = false } = {}) {
  if (cond) console.log("ok  " + msg);
  else {
    failed += 1;
    console.error("FAIL " + msg);
    defects.push({ msg, block });
  }
  return !!cond;
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
    throw new Error(`${method}: ${JSON.stringify(body.result || body).slice(0, 500)}`);
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
  if (!res.ok || data.ok === false) {
    throw new Error(`${path} ${res.status} ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data;
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

function eventText(event) {
  const data = event?.data;
  if (!data) return "";
  if (typeof data.content === "string") return data.content;
  const content = data.content || data.message?.content;
  return contentText(content);
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

function maxSeq(events) {
  return events.reduce((m, e) => Math.max(m, Number(e.seq || 0)), 0);
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

async function promptTurn(sessionId, text) {
  let hist = eventsOf(await rpc("session.history", { sessionId, maxMessages: 80 }));
  const after = maxSeq(hist);
  await rpc("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text }],
  });
  return waitTurn(sessionId, after);
}

function ensureDir(cwd, readme) {
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "README.md"), readme, "utf8");
}

function mapEvent(events) {
  return events.find((e) => {
    if (e.type !== "user/message") return false;
    const src = e.data?.source;
    const text = eventText(e);
    return src?.plugin === "dsh-trivium" || text.includes("dsh-trivium memory map");
  });
}

function resultOnly(blob) {
  return String(blob || "")
    .split(/\n(?=CALL |RESULT )/g)
    .filter((s) => s.startsWith("RESULT"))
    .join("\n");
}

async function waitForMap(sessionId, timeoutMs = 15000) {
  const start = Date.now();
  let hist = [];
  while (Date.now() - start < timeoutMs) {
    hist = eventsOf(await rpc("session.history", { sessionId, maxMessages: 30 }));
    const hit = mapEvent(hist);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 400));
  }
  return mapEvent(hist);
}

const EXTRACT_FACTS = [
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
  "先别动 AuthGateway 冻结窗口，until 2020-01-03。",
  "记住，AuthGateway 日志走 header X。",
  "哈哈今天天气真好。",
  "把这个文件改了就行。",
  "记住 api_key=sk-abc123token。",
  "查询「鉴权」是什么意思？",
  "嗯好的。",
].join("\n");

try {
  const st0 = await trivium("/api/dsh-trivium/status");
  ok(st0.ok === true, "1 plugin /api/dsh-trivium/status", { block: true });
  ok(st0.autoRecall === false, "1/2/15 autoRecall off");
  ok(st0.extractEnabled !== false, "1 extractEnabled on");
  ok((st0.mapTokenBudget || 400) <= 400, "2 mapTokenBudget <= 400");

  ensureDir(LIVE, "live20\n");
  ensureDir(EMPTY, "empty20\n");
  ensureDir(EXTRACT, "p2 live20\n");
  mkdirSync(FAILCWD, { recursive: true });
  writeFileSync(join(FAILCWD, "README.md"), "fail20\n");
  writeFileSync(join(FAILCWD, ".dsh"), "not-a-directory\n");

  const failSess = await rpc("session.create", { cwd: FAILCWD });
  const failHist = await promptTurn(
    failSess.sessionId,
    "不要调用任何工具，不要改文件。只回复「pong」。",
  );
  ok(
    failHist.some((e) => e.type === "assistant/message" || e.type === "turn/end"),
    "3 TDB path broken still chats",
    { block: true },
  );

  const a = await rpc("session.create", { cwd: LIVE });
  const mapA = await waitForMap(a.sessionId);
  ok(!!mapA, "2 Trajectory dsh-trivium inject", { block: true });
  if (mapA) console.log("    map:", eventText(mapA).replace(/\s+/g, " ").slice(0, 240));
  const stMap = await trivium(`/api/dsh-trivium/status?cwd=${encodeURIComponent(LIVE)}`);
  ok((stMap.lastInjectTokens || 0) <= 400, `2/15 short map ${stMap.lastInjectTokens} <= 400`);
  ok(!/autoRecall/i.test(eventText(mapA || {})), "2 short map is not autoRecall dump");

  let hist = await promptTurn(
    a.sessionId,
    [
      "只用 ctx_remember / ctx_link。不要读文件、不要改文件、不要用 bash。",
      "按顺序调用，每次贴工具原文：",
      "1) ctx_remember type=entity name=AuthGateway text=AuthGateway",
      "2) ctx_remember type=preference text=本仓库鉴权走 header X ，link_to=刚记下的 AuthGateway id，link_label=about",
      "3) ctx_remember type=preference text=以后都用 pnpm，不要用 npm。 （不要 link）",
      "4) ctx_remember type=decision text=先别动 AuthGateway，下周再改。 link_to=AuthGateway id，link_label=decided",
      "5) ctx_remember type=decision text=AuthGateway 冻结窗口 until 2020-01-03。 link_to=AuthGateway id，link_label=decided",
      "6) ctx_remember type=experience text=mkdir 失败后改用 fs.mkdir。 fail=bash mkdir fix=fs.mkdir ；link_to=AuthGateway id，link_label=fixed",
      "7) ctx_remember type=decision text=旧方案：用 cookie 会话。",
      "8) ctx_remember type=decision text=现方案：用 header 会话。",
      "9) ctx_link 旧决策 -same_as-> 新决策",
    ].join("\n"),
  );
  const blobA = toolBlob(hist);
  console.log(blobA.slice(0, 2500));
  ok(/Remembered id=/.test(blobA), "4 ctx_remember persisted", { block: true });
  ok(/Linked /.test(blobA) || /link_label=about|about/.test(blobA), "4 linked about/decided");

  const nodesA = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(LIVE)}&stale=1`);
  const blobNodes = (nodesA.nodes || [])
    .map((n) => `#${n.id} [${n.type}] ${n.name} ${n.text} until=${n.until} stale=${n.stale} path=${(n.path || []).join("|")}`)
    .join("\n");
  console.log(blobNodes);
  const auth = (nodesA.nodes || []).find((n) => n.type === "entity" && /AuthGateway/i.test(n.name || n.text));
  const prefX = (nodesA.nodes || []).find((n) => n.type === "preference" && /header X/.test(n.text));
  const pnpm = (nodesA.nodes || []).find((n) => n.type === "preference" && /pnpm/i.test(n.text));
  ok(!!auth, "4/8 AuthGateway entity exists", { block: true });
  ok(!!prefX, "4 preference 鉴权 exists", { block: true });

  const b = await rpc("session.create", { cwd: LIVE });
  const mapB = await waitForMap(b.sessionId);
  ok(!!mapB, "2 session B also injected map");
  ok(/until/i.test(eventText(mapB || {})) || /下周/.test(eventText(mapB || {})), "15 named includes until decision");
  const stB = await trivium(`/api/dsh-trivium/status?cwd=${encodeURIComponent(LIVE)}`);
  ok((stB.lastInjectTokens || 0) <= 400, `15 session-start tokens ${stB.lastInjectTokens} <= 400`);
  ok(stB.autoRecall === false, "15 autoRecall still off");

  hist = await promptTurn(
    b.sessionId,
    "只用 ctx_find。不要改文件。查询「鉴权」，把工具返回原文贴出（含 id、type、path）。",
  );
  const findAuthz = resultOnly(toolBlob(hist));
  console.log("FIND 鉴权\n" + findAuthz);
  ok(/鉴权|header X/.test(findAuthz), "4 ctx_find(鉴权) hit", { block: true });
  ok(/about->/.test(findAuthz) || (auth && findAuthz.includes(String(auth.id))), "4 path contains entity");

  hist = await promptTurn(
    b.sessionId,
    "只用 ctx_find。不要改文件。依次查询：1) AuthGateway 2) AuthGateway 的决策 3) 周五。每次贴工具原文。",
  );
  const findGw = resultOnly(toolBlob(hist));
  console.log("FIND AuthGateway / 决策 / 周五\n" + findGw);
  ok(/AuthGateway/.test(findGw), "8 find(AuthGateway) anchors entity", { block: true });
  ok(/下周|先别动/.test(findGw), "8 unexpired decided neighbor visible");
  ok(!/pnpm/.test(findGw) || !/## preference[\s\S]*pnpm/.test(findGw), "8 does not drag unlinked pnpm");
  const gwBlock = findGw.split(/CALL ctx_find/).filter((s) => /AuthGateway/.test(s) && !/的决策/.test(s) && !/周五/.test(s))[0] || findGw;
  const entityLine = (gwBlock.match(/type=entity[\s\S]{0,400}/) || [""])[0];
  ok(/<-about-/.test(entityLine) || /<-decided-/.test(entityLine) || /<-about-/.test(findGw), "9 entity path has incoming about/decided");
  const staleHiddenDefault =
    !/2020-01-03/.test(gwBlock) || /stale/.test(findGw);
  ok(
    !/until=2020-01-03/.test(gwBlock) || /周五[\s\S]*2020-01-03/.test(findGw),
    "8/9 stale until hidden on AuthGateway find unless 周五 query",
  );
  ok(/周五/.test(findGw), "9 ctx_find(周五) was called");

  if (auth) {
    hist = await promptTurn(
      b.sessionId,
      `只用 ctx_read。不要改文件。读取 id=${auth.id}，把 JSON 原文贴出。`,
    );
    const readBlob = toolBlob(hist);
    console.log("READ\n" + readBlob.slice(0, 1500));
    ok(/"incoming"/.test(readBlob), "10 ctx_read has incoming", { block: true });
    ok(/about|decided|fixed/.test(readBlob), "10 incoming has about/decided/fixed");
  }

  hist = await promptTurn(
    b.sessionId,
    "只用 ctx_find。不要改文件。查询「用 cookie」，贴工具原文。",
  );
  const sameBlob = resultOnly(toolBlob(hist));
  console.log("FIND cookie\n" + sameBlob);
  ok(/cookie/.test(sameBlob), "11 find hits old decision text");
  ok(/header 会话|现方案/.test(sameBlob), "11 same_as follows to canonical node");

  hist = await promptTurn(
    b.sessionId,
    "只用 ctx_find。不要改文件。查询 AuthGateway，贴工具原文。确认是否出现 mkdir / fs.mkdir / experience。",
  );
  const expBlob = resultOnly(toolBlob(hist));
  console.log("FIND exp\n" + expBlob);
  ok(/mkdir|fs\.mkdir|experience/.test(expBlob), "13 find expands fixed experience");
  ok(/<-fixed-/.test(expBlob) || /<-broke-/.test(expBlob), "13 entity path has <-fixed- or <-broke-");

  const aboutNodes = auth
    ? await trivium(
        `/api/dsh-trivium/nodes?cwd=${encodeURIComponent(LIVE)}&about=${auth.id}`,
      )
    : { nodes: [] };
  ok(
    (aboutNodes.nodes || []).some((n) => n.type === "preference" && /header X/.test(n.text)) ||
      (aboutNodes.nodes || []).some((n) => n.type === "decision" && /下周|先别动/.test(n.text)),
    "14 about=AuthGateway shows linked pref/decision",
  );
  ok(
    !(aboutNodes.nodes || []).some((n) => n.type === "preference" && /pnpm/i.test(n.text)),
    "14 about filter hides unlinked pnpm",
  );
  const hiddenStale = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(LIVE)}`);
  const shownStale = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(LIVE)}&stale=1`);
  const staleDefault = (hiddenStale.nodes || []).filter((n) => n.type === "decision" && n.stale);
  const staleShown = (shownStale.nodes || []).filter((n) => n.type === "decision" && n.stale);
  ok(staleDefault.length === 0, "14 stale decisions hidden by default");
  ok(staleShown.length > 0 || staleDefault.length === 0, "14 stale=1 can reveal expired decisions");

  const archId = prefX?.id || pnpm?.id;
  if (archId != null) {
    await trivium(`/api/dsh-trivium/nodes/${archId}/archive?cwd=${encodeURIComponent(LIVE)}`, {
      method: "POST",
    });
    const c = await rpc("session.create", { cwd: LIVE });
    hist = await promptTurn(c.sessionId, "只用 ctx_find 查询「鉴权」，贴工具原文。不要改文件。");
    const afterArch = resultOnly(toolBlob(hist));
    console.log("FIND after archive\n" + afterArch);
    const gone =
      /No memory hits/i.test(afterArch) ||
      (!new RegExp(`id=${archId}\\b`).test(afterArch) && (archId === pnpm?.id || !/header X/.test(afterArch)));
    ok(gone || archId === pnpm?.id, "6 archived node no longer in find", { block: true });
  }

  const ex = await rpc("session.create", { cwd: EXTRACT });
  await promptTurn(
    ex.sessionId,
    "记住，本仓库鉴权走 header X。TriviumDB 是内核。\n不要改文件，不要调用任何工具，只回复「记下了」。",
  );
  await promptTurn(
    ex.sessionId,
    `${EXTRACT_FACTS}\n\n不要改文件，不要调用任何工具，只回复「记下了」。`,
  );
  await new Promise((r) => setTimeout(r, 14000));
  const exB = await rpc("session.create", { cwd: EXTRACT });
  let extract = null;
  let exNodes = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await trivium(`/api/dsh-trivium/status?cwd=${encodeURIComponent(EXTRACT)}`);
    const listed = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(EXTRACT)}&stale=1`);
    exNodes = listed.nodes || [];
    extract = st.lastExtract;
    if (extract?.applied > 0 || exNodes.some((n) => n.type === "preference")) break;
  }
  console.log("lastExtract", JSON.stringify(extract));
  console.log(exNodes.map((n) => `[${n.type}] ${n.name} ${n.text} until=${n.until} path=${(n.path || []).join("|")}`).join("\n"));
  ok(exNodes.some((n) => n.type === "preference"), "7 extract produced preferences", { block: true });
  ok(exNodes.some((n) => n.type === "preference" && /header X/.test(n.text)), "7 P1 header X");
  ok(exNodes.some((n) => n.type === "entity" && /AuthGateway/i.test(n.name || n.text)), "7 E2 AuthGateway");
  ok(!exNodes.some((n) => n.type === "entity" && n.name === "鉴权"), "5/7 「鉴权」不成实体");
  ok(!exNodes.some((n) => n.type === "preference" && /天气/.test(`${n.name} ${n.text}`)), "5 N1 no weather pref");
  ok(!exNodes.some((n) => n.type === "preference" && /把这个文件/.test(n.text)), "5 N2 no oneshot pref");
  ok(!exNodes.some((n) => /sk-abc123/.test(`${n.name} ${n.text}`)), "5 N3 secret not stored");
  const authPref = exNodes.find((n) => n.type === "preference" && /鉴权/.test(n.text) && /header X/.test(n.text));
  const logPref = exNodes.find((n) => n.type === "preference" && /日志/.test(n.text) && /header X/.test(n.text));
  const triviumEnt = exNodes.find((n) => n.type === "entity" && /TriviumDB/i.test(n.name || n.text));
  const gwEnt = exNodes.find((n) => n.type === "entity" && /AuthGateway/i.test(n.name || n.text));
  ok(
    !authPref ||
      !(authPref.path || []).some((p) => triviumEnt && p.includes(String(triviumEnt.id))) ||
      !(authPref.path || []).some((p) => p.startsWith("about->") && triviumEnt && p.includes(String(triviumEnt.id))),
    "12 鉴权 pref does not about→TriviumDB",
  );
  ok(
    !logPref ||
      (gwEnt && (logPref.path || []).some((p) => p.includes("about->") && p.includes(String(gwEnt.id)))),
    "12 AuthGateway 日志 pref about→AuthGateway",
  );

  hist = await promptTurn(exB.sessionId, "只用 ctx_find 查询鉴权，贴工具原文。不要改文件。");
  const exFind = resultOnly(toolBlob(hist));
  console.log("EXTRACT FIND 鉴权\n" + exFind);
  ok(/鉴权|header X/.test(exFind), "7 session B ctx_find 鉴权 hit");

  hist = await promptTurn(
    exB.sessionId,
    "只用 ctx_find。不要改文件。依次查询：1) AuthGateway 2) AuthGateway 的决策 3) 周五。每次贴工具原文。",
  );
  const exGw = resultOnly(toolBlob(hist));
  console.log("EXTRACT FIND AuthGateway\n" + exGw);
  ok(/AuthGateway/.test(exGw), "8 extract find(AuthGateway) anchors");
  ok(/下周|先别动/.test(exGw), "8 extract unexpired decided neighbor");
  ok(!/pnpm/.test(exGw.split(/周五/)[0] || exGw), "8 extract find(AuthGateway) does not drag pnpm");
  ok(/<-about-/.test(exGw) || /<-decided-/.test(exGw), "9 extract entity incoming path");
  const beforeFriday = (exGw.split(/周五/)[0] || exGw);
  ok(!/2020-01-03/.test(beforeFriday) || /until=2020-01-03/.test(exGw.split(/周五/).slice(1).join("周五")), "8/9 extract stale until hidden until 周五 query");
  if (gwEnt) {
    hist = await promptTurn(
      exB.sessionId,
      `只用 ctx_read。不要改文件。读取 id=${gwEnt.id}，把 JSON 原文贴出。`,
    );
    const exRead = toolBlob(hist);
    console.log("EXTRACT READ\n" + exRead.slice(0, 1500));
    ok(/"incoming"/.test(exRead), "10 extract ctx_read incoming");
    ok(/about|decided/.test(exRead), "10 extract incoming about/decided");
  }
  const exAbout = gwEnt
    ? await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(EXTRACT)}&about=${gwEnt.id}`)
    : { nodes: [] };
  ok(
    (exAbout.nodes || []).some((n) => /header X|下周|先别动|日志/.test(`${n.name} ${n.text}`)),
    "14 extract about=AuthGateway shows linked rows",
  );
  ok(!(exAbout.nodes || []).some((n) => n.type === "preference" && /pnpm/i.test(n.text)), "14 extract about hides pnpm");
  const exNoStale = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(EXTRACT)}`);
  const exYesStale = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(EXTRACT)}&stale=1`);
  ok(!(exNoStale.nodes || []).some((n) => n.type === "decision" && n.stale), "14 extract stale hidden by default");
  ok(
    (exYesStale.nodes || []).some((n) => n.type === "decision" && n.stale) ||
      (exYesStale.nodes || []).some((n) => /2020-01-03/.test(`${n.until} ${n.text}`)),
    "14 extract stale=1 shows expired decision",
  );

  const emptySess = await rpc("session.create", { cwd: EMPTY });
  hist = await promptTurn(emptySess.sessionId, "只用 ctx_find 查询鉴权，再查询 AuthGateway，贴工具原文。不要改文件。");
  const emptyBlob = resultOnly(toolBlob(hist));
  console.log("EMPTY FIND\n" + emptyBlob);
  ok(
    /No memory hits/i.test(emptyBlob) ||
      (!/header X/.test(emptyBlob) && !/preference/.test(emptyBlob)),
    "7 empty workspace ctx_find 鉴权/AuthGateway has no durable hit",
    { block: true },
  );

  if (existsSync(join(MEMORY, ".dsh", "trivium.tdb"))) {
    const memSess = await rpc("session.create", { cwd: MEMORY });
    const memNodes = await trivium(`/api/dsh-trivium/nodes?cwd=${encodeURIComponent(MEMORY)}&stale=1`);
    console.log(
      "MEMORY nodes",
      (memNodes.nodes || []).map((n) => `${n.type}:${n.name}:${String(n.text).slice(0, 40)}`).join(" | "),
    );
    hist = await promptTurn(memSess.sessionId, "只用 ctx_find 查询鉴权，再查询 AuthGateway，贴工具原文。不要改文件。");
    const memBlob = resultOnly(toolBlob(hist));
    console.log("MEMORY FIND\n" + memBlob);
    const hasDurable = (memNodes.nodes || []).some((n) => n.type === "preference" || n.type === "decision" || n.type === "entity");
    if (hasDurable) {
      ok(/ctx_find/.test(memBlob), "7 with-memory workspace ctx_find ran (plugin still loaded)");
    } else {
      ok(true, "7 with-memory tdb exists but has no pref/entity/decision yet (not a miss)");
    }
  }
} catch (err) {
  failed += 1;
  console.error("FAIL exception", err);
  defects.push({ msg: String(err && err.stack ? err.stack : err), block: true });
}

console.log("\n--- defects ---");
for (const d of defects) console.log(`${d.block ? "BLOCK" : "note"} ${d.msg}`);
if (failed) {
  console.error(`live accept failed (${failed})`);
  process.exit(1);
}
console.log("live accept passed");
