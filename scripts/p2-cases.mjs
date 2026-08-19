/**
 * P2 accuracy: 20 cross-session questions on an isolated .tdb.
 * Session A = distill(turns); close; Session B = search. Vanilla DSH analogue:
 * the same queries against an empty workspace return no durable hits.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distill, ruleCandidates } from "../lib/extract.js";
import {
  buildShortMapReport,
  closeAll,
  formatHit,
  listNodes,
  openWorkspaceDb,
  searchNodes,
} from "../lib/store.js";

const SESSION_A = [
  { role: "user", text: "记住，本仓库鉴权走 header X。TriviumDB 是内核。" },
  { role: "assistant", text: "记下了。TriviumDB 单文件即可。" },
  { role: "user", text: "以后都用 pnpm，不要用 npm。" },
  { role: "user", text: "别再把 README 改成英文。" },
  { role: "user", text: "从现在起回复用中文。" },
  { role: "user", text: "Remember to run tests before commit." },
  { role: "user", text: "AuthGateway 接登录。AuthGateway 不要暴露端口。" },
  { role: "user", text: "dsh-trivium 是插件。我们继续用 dsh-trivium。" },
  { role: "user", text: "DeepSeek_Harness 是宿主。DeepSeek_Harness 钉死 rc.6。" },
  { role: "user", text: "日志相关键是 X-Request-Id。网关也回传 X-Request-Id。" },
  { role: "user", text: "先别动 AuthGateway，下周再改。" },
  { role: "user", text: "采用方案 A 做登录。" },
  { role: "user", text: "就用这个 TriviumDB 单文件，不要另起服务。" },
  { role: "user", text: "postpone the migration until Friday." },
  { role: "tool", name: "bash", ok: false, text: "ENOENT mkdir", turn: 9 },
  { role: "tool", name: "bash", ok: true, text: "ok after mkdir", turn: 9 },
  { role: "user", text: "哈哈今天天气真好" },
  { role: "user", text: "把这个文件改了就行" },
  { role: "user", text: "记住 api_key=sk-abc123token" },
  { role: "user", text: "查询「鉴权」是什么意思？" },
  { role: "user", text: "嗯好的" },
];

const CASES = [
  { id: "P1", q: "鉴权", type: "preference", text: /header X/ },
  { id: "P2", q: "pnpm", type: "preference", text: /pnpm/ },
  { id: "P3", q: "README", type: "preference", text: /README|英文/ },
  { id: "P4", q: "中文", type: "preference", text: /中文/ },
  { id: "P5", q: "tests", type: "preference", text: /tests/i },
  { id: "E1", q: "TriviumDB", type: "entity", text: /TriviumDB/ },
  { id: "E2", q: "AuthGateway", type: "entity", text: /AuthGateway/ },
  { id: "E3", q: "dsh-trivium", type: "entity", text: /dsh-trivium/ },
  { id: "E4", q: "DeepSeek_Harness", type: "entity", text: /DeepSeek_Harness/ },
  { id: "E5", q: "X-Request-Id", type: "entity", text: /X-Request-Id/ },
  { id: "D1", q: "下周", type: "decision", text: /AuthGateway|下周/ },
  { id: "D2", q: "方案 A", type: "decision", text: /方案 A|登录/ },
  { id: "D3", q: "单文件", type: "decision", text: /单文件|TriviumDB/ },
  { id: "D4", q: "Friday", type: "decision", text: /Friday|migration/i },
  { id: "X1", q: "mkdir", type: "experience", text: /fail|mkdir|bash/i },
  { id: "N1", q: "天气", miss: true },
  { id: "N2", q: "把这个文件", missPref: true },
  { id: "N3", q: "api_key", miss: true },
  { id: "N4", noEntity: "鉴权" },
  { id: "N5", q: "嗯好的", missPref: true },
];

const cwd = mkdtempSync(join(tmpdir(), "dsh-trivium-p2-"));
const empty = mkdtempSync(join(tmpdir(), "dsh-trivium-p2-empty-"));
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log("ok  " + msg);
    return;
  }
  failed += 1;
  console.error("FAIL " + msg);
}

try {
  const quoted = ruleCandidates([
    { role: "user", text: "查询「鉴权」是什么意思？" },
    { role: "assistant", text: "「鉴权」指校验身份。" },
  ]);
  assert(
    !quoted.some((c) => c.type === "entity" && c.name === "鉴权"),
    "quoted 鉴权 is not an entity",
  );

  const dbA = await openWorkspaceDb(cwd);
  const result = await distill({ db: dbA, turns: SESSION_A, sessionId: "sess-a" });
  console.log("distill applied", result.applied.length, result.applied.map((a) => a.type + ":" + a.text).join(" | "));
  const map = buildShortMapReport(dbA, 400);
  assert(map.tokens <= 400, `short map ${map.tokens} <= 400`);
  assert(/preference:/.test(map.text), "short map lists preferences first");
  dbA.flush();
  closeAll();

  const vanilla = await openWorkspaceDb(empty);
  const vanillaHits = searchNodes(vanilla, "鉴权", { topK: 8, expandDepth: 1 });
  assert(
    !vanillaHits.some((h) => h.payload?.type === "preference"),
    "vanilla analogue: empty workspace has no preference for 鉴权",
  );
  closeAll();

  const dbB = await openWorkspaceDb(cwd);
  const nodes = listNodes(dbB);
  assert(
    !nodes.some((n) => n.type === "entity" && n.name === "鉴权"),
    "N4: no entity named 鉴权 after reopen",
  );
  assert(
    !nodes.some((n) => n.type === "entity" && n.name === "README"),
    "no singleton ALLCAPS entity minted from a preference mention",
  );
  const prefDup = nodes.filter((n) => n.type === "preference" && /header X/.test(n.text));
  const inWs = prefDup[0]
    ? (dbB.get(prefDup[0].id)?.edges || []).filter((e) => e.label === "in_workspace")
    : [];
  assert(inWs.length <= 1, `no duplicate in_workspace (got ${inWs.length})`);

  for (const c of CASES) {
    if (c.noEntity) continue;
    const hits = searchNodes(dbB, c.q, { topK: 8, expandDepth: 1 }).map((h) => formatHit(dbB, h));
    const types = hits.map((h) => h.type);
    if (c.miss) {
      assert(
        hits.length === 0 || !hits.some((h) => c.text?.test?.(h.l0)),
        `${c.id} miss durable hit for ${c.q} (got ${hits.map((h) => h.type + ":" + h.l0).join("; ") || "none"})`,
      );
      continue;
    }
    if (c.missPref) {
      assert(
        !hits.some((h) => h.type === "preference"),
        `${c.id} no preference for ${c.q}`,
      );
      continue;
    }
    const hit = hits.find((h) => h.type === c.type && c.text.test(h.l0));
    assert(
      !!hit,
      `${c.id} find(${c.q}) ${c.type} ${c.text} (got ${hits.map((h) => `[${h.type}] ${h.l0} path=${h.path.join(",")}`).join(" ;; ") || "none"}) types=${types}`,
    );
    if (c.id === "P1" && hit) {
      assert(/about->/.test(hit.path.join("|")) || /TriviumDB|dsh-trivium/.test(hit.path.join("|")), `${c.id} path carries entity`);
    }
    if (c.id === "D1" && hit) {
      const node = dbB.get(hit.id);
      assert(node?.payload?.until === "下周", `D1 until=下周 (got ${node?.payload?.until})`);
    }
  }
  closeAll();
} catch (err) {
  failed += 1;
  console.error("FAIL exception", err);
} finally {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
}

if (failed) {
  console.error(`P2 cases failed (${failed})`);
  process.exit(1);
}
console.log("P2 20 cross-session cases passed");
