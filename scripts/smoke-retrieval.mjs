/** retrieval: independent historical regression cases. Run with npm test -- retrieval.
 * Each function runs in its own process through run-all; settings and modules never leak. */

export const cases = Object.freeze({ p30, p34, p35, p37, p104 });

async function p30() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /** C-review P0: an exact, current name must survive top-K independently of degree. */

  const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p30-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const store = await import("../lib/store.js");
  const { registerTools } = await import("../lib/tools.js");
  const registered = new Map();
  registerTools(
    {
      effect: (fn) => fn(),
      tools: {
        register(tool) {
          registered.set(tool.name, tool);
          return () => {};
        },
      },
      on() {},
    },
    {},
  );
  let checks = 0,
    failed = 0;
  function check(value, label) {
    checks++;
    if (value) console.log("ok  " + label);
    else {
      failed++;
      console.error("FAIL " + label);
    }
  }

  try {
    const cwd = join(root, "rank");
    let db = await store.openWorkspaceDb(cwd);
    const target = store.insertNode(db, {
      type: "entity",
      name: "revision note 2",
      text: "Exact isolated target marker RANK_TARGET.",
      uri: "test://rank/exact",
    });
    const hub = store.insertNode(db, {
      type: "entity",
      name: "BusinessHub",
      text: "Business relation endpoint.",
    });
    for (let i = 0; i < 12; i++) {
      const id = store.insertNode(db, {
        type: "entity",
        name: `revision note 2${i + 10}`,
        text: `A weaker name match ${i}.`,
      });
      assert.equal(store.ensureLink(db, id, hub, "about"), true);
    }
    const query = "revision note 2";
    const stages = {};
    const before = store.searchNodes(db, query, {
      topK: 8,
      expandDepth: 0,
      onStage: (name, ids) => {
        stages[name] = ids;
      },
    });
    check(
      stages["entity-anchor"].includes(target),
      "RANK-30 exact target really entered the candidate pipeline",
    );
    check(
      before[0]?.id === target,
      "RANK-30 exact unlinked name outranks twelve connected partial names",
    );
    check(before.length <= 8, "RANK-30 top-K remains bounded");
    store.ensureLink(db, target, hub, "about");
    check(
      store.searchNodes(db, query, { topK: 8, expandDepth: 0 })[0]?.id ===
        target,
      "RANK-30 adding a target edge cannot change its exact-match rank",
    );
    store.dropLink(db, target, hub, "about");
    check(
      store.searchNodes(db, "  REVISION NOTE 2  ", { topK: 8 })[0]?.id ===
        target,
      "RANK-30 case/whitespace normalization preserves the exact hit",
    );

    const native = db.searchHybrid;
    db.searchHybrid = () => [];
    try {
      check(
        store.searchNodes(db, query, { topK: 8 })[0]?.id === target,
        "RANK-30 exact target also survives the lexical fallback",
      );
    } finally {
      db.searchHybrid = native;
    }
    const output = await registered
      .get("ctx_find")
      .execute(
        { query },
        { agent: { session: { id: "rank", header: { cwd } } } },
      );
    check(
      String(output).includes("RANK_TARGET"),
      "RANK-30 the public find tool returns the target body",
    );
    store.closeAll();
    db = await store.openWorkspaceDb(cwd);
    check(
      store.searchNodes(db, query, { topK: 8 })[0]?.id === target,
      "RANK-30 reopening keeps exact-name recall",
    );

    const expiryDb = await store.openWorkspaceDb(join(root, "expiry"));
    const stale = store.insertNode(expiryDb, {
      type: "decision",
      name: "ReleaseGuard",
      text: "Historical release policy.",
      until: "2000-01-01",
    });
    const live = store.insertNode(expiryDb, {
      type: "decision",
      name: "ReleaseGuard current",
      text: "Current release policy.",
    });
    const ordered = store.searchNodes(expiryDb, "ReleaseGuard", {
      topK: 8,
      expandDepth: 0,
    });
    check(
      ordered.findIndex((hit) => hit.id === live) <
        ordered.findIndex((hit) => hit.id === stale),
      "RANK-30 exact-name priority cannot promote stale history above a live match",
    );
    check(
      store.formatHit(
        expiryDb,
        ordered.find((hit) => hit.id === stale),
      ).stale,
      "RANK-30 explicit historical search retains the stale label",
    );
    check(
      !store
        .searchNodes(expiryDb, "ReleaseGuard", { includeStale: false })
        .some((hit) => hit.id === stale),
      "RANK-30 current-only filtering stays unchanged",
    );
  } finally {
    store.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P30 exact-name recall: ${checks - failed}/${checks}`);
  if (failed) process.exitCode = 1;
}

async function p34() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "dsh-cost-p34-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const store = await import("../lib/store.js");
  const { distill, ruleCandidates } = await import("../lib/extract.js");
  const { registerTools } = await import("../lib/tools.js");
  const tools = new Map();
  registerTools(
    {
      effect: (f) => f(),
      tools: {
        register: (t) => {
          tools.set(t.name, t);
          return () => {};
        },
      },
      on() {},
    },
    {},
  );
  try {
    assert.ok(
      !ruleCandidates([
        { role: "user", text: "采用方案 BluePlan，先验证兼容性。" },
      ]).some((r) => r.type === "entity" && r.name === "方案 B"),
      "a multi-letter name is not a one-letter plan",
    );
    assert.ok(
      ruleCandidates([
        { role: "user", text: "采用方案 B，先验证兼容性。" },
      ]).some((r) => r.type === "entity" && r.name === "方案 B"),
      "the actual one-letter plan still works",
    );
    const cwd = join(root, "workspace"),
      db = await store.openWorkspaceDb(cwd);
    let calls = 0;
    const llmCall = async () => {
      calls++;
      return '{"candidates":[]}';
    };
    await distill({
      db,
      turns: [
        { role: "user", text: "谢谢！" },
        { role: "assistant", text: "好的。" },
      ],
      llmCall,
    });
    assert.equal(calls, 0, "pure acknowledgements need no model");
    for (const turns of [
      [{ role: "user", text: "以后发布都先验收" }],
      [{ role: "user", text: "这个项目的数据库是 QuasarStore" }],
      [{ role: "tool", text: "failure", ok: false }],
    ])
      await distill({ db, turns, llmCall });
    assert.equal(
      calls,
      3,
      "explicit, implicit and tool evidence still reach the model",
    );
    const toolOnly = await distill({
      db,
      turns: [
        { role: "tool", name: "compile", turn: 9, ok: false, text: "" },
        { role: "tool", name: "compile", turn: 9, ok: true, text: "" },
      ],
      llmCall,
    });
    assert.ok(
      toolOnly.applied.some((x) => x.type === "experience"),
      "empty tool text still carries failure/success evidence",
    );
    const entity = store.insertNode(db, {
      type: "entity",
      name: "AuroraService",
      text: "AuroraService",
    });
    const id = store.insertNode(db, {
      type: "decision",
      name: "验收约定",
      text: "AuroraService 必须跑验收脚本。",
    });
    store.ensureLink(db, id, entity, "about");
    const hit = { id, score: 1 };
    assert.ok(
      store.formatHit(db, hit).path.some((p) => p.includes("in_workspace")),
      "management path remains available",
    );
    const model = store.formatHit(db, hit, { includeWorkspace: false });
    assert.ok(model.path.some((p) => p.includes("about")));
    assert.ok(model.path.every((p) => !p.includes("in_workspace")));
    const exec = { agent: { session: { header: { cwd } } } };
    const found = String(
      await tools.get("ctx_find").execute({ query: "验收约定" }, exec),
    );
    assert.match(found, /必须跑验收/);
    assert.match(found, /about/);
    assert.doesNotMatch(found, /in_workspace|path: \(none\)/);
    const full = String(await tools.get("ctx_read").execute({ id }, exec));
    assert.equal(
      JSON.parse(full).payload.text,
      "AuroraService 必须跑验收脚本。",
    );
    assert.ok(
      JSON.parse(full).edges.length >= 2,
      "explicit read still returns all edges",
    );
    assert.equal(
      full,
      JSON.stringify(JSON.parse(full)),
      "compact serialization changes no JSON fields",
    );
    console.log(
      "P34 cost guards passed: acknowledgements only, implicit/tool facts retained, business paths and full read preserved",
    );
  } finally {
    store.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
}

async function p35() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * P35: 注入完整性的两条回归（C4 实测暴露的两个缺陷）。
   *
   * 1. S07「六条并列事实」只注入三条 —— 根因不是预算（只用了 89/300），而是
   *    `recallCandidates()` 里写死的 `topK: 3` + `slice(0, 3)`。预算才是真正的约束，
   *    这里钉住：预算够时六条必须全部到达。
   * 2. S05「长正文答案在尾部」被 200 字**只留头**的截断吃掉 —— 决策是「尾部保底」，
   *    这里钉住：结论在尾部时必须仍在注入文本里，且单条仍受 200 字上限约束。
   *
   * 全部走真实 pre-step（plugin.apply + agent/pre-step），临时库，零模型调用。
   */

  const home = mkdtempSync(join(tmpdir(), "dsh-trivium-p35-"));
  process.env.DSH_TRIVIUM_SETTINGS = join(home, "settings.json");
  process.env.DSH_HOME = join(home, "dsh-home");

  const store = await import("../lib/store.js");
  const settings = await import("../lib/settings.js");
  const {
    preserveEnds,
    L0_MAX_CHARS,
    renderContextRecords,
    selectContextRecords,
  } = await import("../lib/context-budget.js");
  const { makeRevisionResolver } = await import("../lib/revisions.js");
  const { estimateTokens } = await import("../lib/tokens.js");
  const plugin = await import("../lib/index.js");

  let checks = 0;
  let failed = 0;
  function check(ok, label, detail = "") {
    checks += 1;
    if (ok) console.log("ok  " + label);
    else {
      failed += 1;
      console.error("FAIL " + label + (detail ? ": " + detail : ""));
    }
  }

  try {
    /* ---------- 单元：尾部保底 ---------- */
    const long = `${"背景记录。".repeat(55)}最终验收命令为 verify-QA-71.mjs。`;
    const clipped = preserveEnds(long, L0_MAX_CHARS);
    check(
      clipped.length <= L0_MAX_CHARS,
      "UNIT-35 clipped body never exceeds the cap",
      String(clipped.length),
    );
    check(
      clipped.includes("verify-QA-71.mjs"),
      "UNIT-35 the tail (the answer) survives",
      clipped.slice(-40),
    );
    check(
      clipped.startsWith("背景记录。"),
      "UNIT-35 the head is still there for context",
    );
    check(clipped.includes("…"), "UNIT-35 the omission is visible, not silent");
    check(
      preserveEnds("短事实。", L0_MAX_CHARS) === "短事实。",
      "UNIT-35 short bodies are untouched",
    );

    /* ---------- 真实 pre-step ---------- */
    const handlers = new Map();
    const ctx = {
      logger: () => ({ warn() {}, info() {}, error() {} }),
      inject(_deps, fn) {
        fn(ctx);
      },
      on(name, fn) {
        handlers.set(name, fn);
        return () => {};
      },
      effect(fn) {
        fn();
        return () => {};
      },
      tools: { register: () => () => {} },
    };
    plugin.apply(ctx, {});
    settings.writeUiSettings({
      recallMode: "auto",
      chipsEnabled: false,
      extractEnabled: false,
      gitSidecarEnabled: false,
    });

    const preStep = handlers.get("agent/pre-step");
    assert.equal(typeof preStep, "function", "agent/pre-step registered");
    const message = (id, text) => ({
      id,
      source: { kind: "user" },
      content: [{ type: "text", text }],
    });
    const textsOf = (decision) =>
      (decision.messages || [])
        .flatMap((m) => m.content || [])
        .map((x) => x.text || "")
        .join("\n");

    const ws = join(home, "ws");
    const db = await store.openWorkspaceDb(ws);
    const codes = [1, 2, 3, 4, 5, 6].map((i) => `QA${i}-71`);
    for (const [i, code] of codes.entries()) {
      store.insertNode(db, {
        type: "decision",
        name: `联调约定${i + 1}`,
        text: `先跑基线。联调约定编号 ${code}，关注事项 ${i + 1}。`,
      });
    }
    // 噪音：同库再加 6 条无关事实，确保命中不是全库回吐
    for (let i = 0; i < 6; i += 1)
      store.insertNode(db, {
        type: "entity",
        name: `旁支${i}`,
        text: `无关设备编号 DEVICE-${i}。`,
      });

    const six = await preStep(
      {
        agent: { session: { id: "p35-six", header: { cwd: ws } } },
        messages: [message("p35-six-1", "列出全部六条联调约定的编号。")],
      },
      async () => ({ kind: "enter", messages: [] }),
    );
    const sixText = textsOf(six);
    const present = codes.filter((c) => sixText.includes(c));
    check(
      present.length === 6,
      "S07-35 all six parallel facts reach the model when the budget allows",
      `got ${present.length}/6: ${sixText.slice(0, 160)}`,
    );
    check(
      estimateTokens(sixText) <= 300,
      "S07-35 the shared 300-token turn budget still holds",
      String(estimateTokens(sixText)),
    );
    check(
      !sixText.includes("DEVICE-3"),
      "S07-35 unrelated rows are not dragged in",
      sixText.slice(0, 120),
    );

    const longId = store.insertNode(db, {
      type: "experience",
      name: "发布流程",
      text: long,
    });
    const longTurn = await preStep(
      {
        agent: { session: { id: "p35-long", header: { cwd: ws } } },
        messages: [message("p35-long-1", "“发布流程”的最终验收命令是什么？")],
      },
      async () => ({ kind: "enter", messages: [] }),
    );
    const longText = textsOf(longTurn);
    check(
      longText.includes("verify-QA-71.mjs"),
      "S05-35 a tail-only answer is delivered without ctx_read",
      longText.slice(-80),
    );
    check(
      longText.includes(`experience#${longId}`),
      "S05-35 the long fact is the record that arrived (not another row)",
    );
    const bodyLine =
      longText.split("\n").find((l) => l.includes(`experience#${longId}`)) ||
      "";
    check(
      bodyLine.length <= L0_MAX_CHARS + 40,
      "S05-35 one record still cannot eat the whole turn budget",
      String(bodyLine.length),
    );

    // 预算仍优先于条数：8 条长事实不可能全进，且必须**整条丢弃**而不是把中间挖掉。
    // 这一段直接测选择层：pre-step 里短地图也会占用同一份 300 预算（真实宿主里地图确实在对话中，
    // 但本 harness 的 fake next() 不携带地图消息），走 pre-step 会把这层记账差异混进断言。
    const many = join(home, "ws-many");
    const dbMany = await store.openWorkspaceDb(many);
    for (let i = 0; i < 8; i += 1) {
      store.insertNode(dbMany, {
        type: "decision",
        name: `长约定${i}`,
        text: `${"长正文".repeat(90)}结论${i}：RUN-${i}-71。`,
      });
    }
    const hitsMany = store
      .searchNodes(dbMany, "列出全部长约定的结论。", {
        topK: 8,
        expandDepth: 1,
        includeStale: false,
      })
      .map((h) => store.formatHit(dbMany, h, { includeWorkspace: false }));
    const planMany = selectContextRecords({
      pins: [],
      recall: hitsMany,
      corrections: [],
      budget: 300,
      form: "autoRecall",
      delivered: new Set(),
      mapText: store.buildShortMapReport(dbMany, 400).text,
      resolveCurrent: makeRevisionResolver(dbMany),
    });
    const selectedText = renderContextRecords(planMany, { form: "autoRecall" })
      .recall.text;
    check(
      planMany.records.length >= 1,
      "BUDGET-35 a long fact still fits the 300-token turn",
      String(planMany.records.length),
    );
    check(
      planMany.tokens <= 300,
      "BUDGET-35 the cap is honoured",
      String(planMany.tokens),
    );
    check(
      planMany.records.every((r) => r.l0.slice(-6).includes("。")),
      "BUDGET-35 selected bodies end on a record boundary, not mid-word",
    );
    check(
      planMany.dropped.length >= 1 &&
        planMany.dropped.every((d) => d.reason === "over-budget"),
      "BUDGET-35 the rest are dropped whole, with an explicit reason",
      JSON.stringify(planMany.dropped.slice(0, 2)),
    );
    check(
      selectedText.includes("RUN-"),
      "BUDGET-35 the selected record still carries its conclusion",
    );
  } finally {
    settings.writeUiSettings({ gitSidecarEnabled: false });
    store.closeAll();
    rmSync(home, { recursive: true, force: true });
  }

  console.log(`P35 injection integrity: ${checks - failed}/${checks} passed`);
  if (failed) process.exitCode = 1;
}

async function p37() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * P37: 定位 C4 S07「六条并列只进三条」的失败类（不是猜测）。
   *
   * C4 当时的假设是「注入装配层把结构相似的三条折掉了」。D0 改了 topK 之后复测
   * 变成 18/18，但「为什么」没有单独取证。这里做 A/B 归因：
   *
   *   A. 用旧形状的 topK=3 取候选 → 3 条到达，预算只用了约 89/300，
   *      dropped 里**没有** duplicate-node / duplicate-in-turn —— 说明不是去重。
   *   B. 用现行 topK=8 → 6 条全部到达，同样没有去重丢弃。
   *
   * 结论：失败类是「预算之前的一处未文档化的候选条数上限」，不是内容折叠。
   * 该断言防止将来有人把去重/相似度折叠加回来却让 p35 仍然只是"恰好 6 条"。
   */

  const home = mkdtempSync(join(tmpdir(), "dsh-trivium-p37-"));
  process.env.DSH_TRIVIUM_SETTINGS = join(home, "settings.json");
  process.env.DSH_HOME = join(home, "dsh-home");

  const store = await import("../lib/store.js");
  const { selectContextRecords, renderContextRecords, TURN_ADDITIONAL_BUDGET } =
    await import("../lib/context-budget.js");
  const { makeRevisionResolver } = await import("../lib/revisions.js");

  let checks = 0;
  let failed = 0;
  function check(ok, label, detail = "") {
    checks += 1;
    if (ok) console.log("ok  " + label);
    else {
      failed += 1;
      console.error("FAIL " + label + (detail ? ": " + detail : ""));
    }
  }

  const QUERY = "列出全部六条“联调约定”的编号。";
  const DEDUPE_REASONS = new Set([
    "duplicate-node",
    "duplicate-in-turn",
    "already-in-map",
    "empty",
  ]);

  try {
    const ws = join(home, "ws");
    const db = await store.openWorkspaceDb(ws);

    // Same shape as quality-fixtures S07: six facts, one shared prefix, distinct ids and codes.
    const codes = [1, 2, 3, 4, 5, 6].map((i) => `QAF${i}`);
    const bodies = [
      "环境隔离",
      "版本固定",
      "种子记录",
      "失败样本",
      "回滚方案",
      "验收门槛",
    ];
    for (const [i, code] of codes.entries()) {
      store.insertNode(db, {
        type: "decision",
        name: `联调约定${i + 1}`,
        text: `先跑基线。联调约定编号 ${code}，关注${bodies[i]}。`,
      });
    }

    const plan = (topK) => {
      const hits = store
        .searchNodes(db, QUERY, { topK, expandDepth: 1, includeStale: false })
        .slice(0, topK)
        .map((hit) => store.formatHit(db, hit, { includeWorkspace: false }));
      const selected = selectContextRecords({
        pins: [],
        recall: hits,
        corrections: [],
        budget: TURN_ADDITIONAL_BUDGET,
        form: "autoRecall",
        delivered: new Set(),
        mapText: "",
        resolveCurrent: makeRevisionResolver(db),
      });
      return {
        hits,
        selected,
        text: renderContextRecords(selected, { form: "autoRecall" }).recall
          .text,
      };
    };

    const oldShape = plan(3);
    check(
      oldShape.hits.length === 3,
      "OLD-37 the legacy topK=3 yields only three candidates",
      String(oldShape.hits.length),
    );
    check(
      oldShape.selected.records.length === 3,
      "OLD-37 three records reach the injection",
      String(oldShape.selected.records.length),
    );
    check(
      oldShape.selected.tokens < TURN_ADDITIONAL_BUDGET,
      "OLD-37 the budget was never the limiter",
      `${oldShape.selected.tokens}/${TURN_ADDITIONAL_BUDGET}`,
    );
    check(
      oldShape.selected.dropped.every((d) => !DEDUPE_REASONS.has(d.reason)),
      "OLD-37 nothing was deduplicated away; the cap sat before the budget",
      JSON.stringify(oldShape.selected.dropped),
    );

    const current = plan(8);
    check(
      current.hits.length === 6,
      "NOW-37 all six candidates are produced",
      String(current.hits.length),
    );
    check(
      current.selected.records.length === 6,
      "NOW-37 all six are selected",
      String(current.selected.records.length),
    );
    check(
      current.selected.tokens <= TURN_ADDITIONAL_BUDGET,
      "NOW-37 the shared budget still holds",
      `${current.selected.tokens}/${TURN_ADDITIONAL_BUDGET}`,
    );
    check(
      codes.every((c) => current.text.includes(c)),
      "NOW-37 every code is in the rendered text",
      codes.filter((c) => !current.text.includes(c)).join(","),
    );
    check(
      current.selected.dropped.length === 0,
      "NOW-37 no record is dropped at the current shape",
      JSON.stringify(current.selected.dropped),
    );

    // Distinct ids must never be folded because their bodies look alike.
    const ids = current.selected.records.map((r) => r.id);
    check(
      new Set(ids).size === 6,
      "NOW-37 six distinct ids, no content folding",
      ids.join(","),
    );

    store.closeAll();
  } finally {
    try {
      store.closeAll();
    } catch {}
    rmSync(home, { recursive: true, force: true });
    console.log(`\nP37 S07 failure class: ${checks - failed}/${checks} passed`);
    assert.equal(failed, 0, `${failed} check(s) failed`);
  }
}

async function p104() {
  const assert = (await import('node:assert/strict')).default;
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'trivium-pack-'));
  process.env.DSH_HOME = join(root, 'home');
  process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
  const store = await import('../lib/store.js');
  const { searchEntity, validateEntitySearch } = await import('../lib/entity-search.js');
  const { createReadSnapshot } = await import('../lib/read-snapshots.js');
  const { searchEntitySnapshot } = await import('../lib/entity-search-snapshot.js');
  const { estimateTokens } = await import('../lib/tokens.js');
  try {
    const cwd = join(root, 'ws'), db = await store.openWorkspaceDb(cwd);
    const anchor = store.insertNode(db, { type: 'entity', name: '审计', text: '审计留存配置。' });
    const older = store.insertNode(db, { type: 'decision', name: '审计留存', text: '审计记录保留 30 天。', createdAt: '2025-01-01T00:00:00Z' });
    const newer = store.insertNode(db, { type: 'decision', name: '审计留存', text: '审计记录保留 90 天。', createdAt: '2026-06-01T00:00:00Z' });
    const outside = store.insertNode(db, { type: 'decision', name: '旁支', text: '审计记录保留 999 天。' });
    db.link(older, anchor, 'about', 1); db.link(newer, anchor, 'about', 1); db.flush();
    const graph = () => JSON.stringify(db.allNodeIds().map(id => db.get(id)));
    const before = graph();
    const body = { entityId: anchor, query: '审计记录保留多久', packTokens: 500 };
    const result = await searchEntity(db, body);
    assert.equal(Number(result.textCandidates[0].id), newer, 'C4 tie should prefer newer recorded fact');
    assert.ok(result.textCandidates.some(row => Number(row.id) === older), 'old active alternative was hidden');
    assert.ok(result.warnings.some(row => row.code === 'MULTIPLE_CURRENT_FACTS'));
    assert.deepEqual(new Set(result.memoryPack.facts.map(row => Number(row.id))), new Set([older, newer]));
    assert.ok(result.memoryPack.context.includes('UNRESOLVED'));
    const citedRows = result.memoryPack.context.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.deepEqual(citedRows.map(row => row.id), [newer, older], 'full context must expose numeric fact IDs');
    assert.ok(citedRows.every(row => row.path.nodes.every(Number.isSafeInteger)
      && row.path.edges.every(edge => Number.isSafeInteger(edge.from) && Number.isSafeInteger(edge.to))));
    assert.ok(result.memoryPack.facts.every(row => typeof row.id === 'string' && row.path.nodes.every(id => typeof id === 'string')),
      'structured API keeps string IDs');
    assert.equal(result.memoryPack.estimatedTokens, estimateTokens(result.memoryPack.context));
    assert.ok(result.memoryPack.estimatedTokens <= 500);
    assert.ok(result.memoryPack.facts.every(row => row.path.edges.length === 1 && row.source === null));
    assert.ok(!result.memoryPack.facts.some(row => Number(row.id) === outside));
    const tiny = await searchEntity(db, { ...body, packTokens: 1 });
    assert.equal(tiny.memoryPack.facts.length, 0, 'conflicting alternatives must fit together');
    assert.ok(tiny.memoryPack.estimatedTokens <= 1);
    assert.equal((await searchEntity(db, { entityId: anchor, query: body.query })).memoryPack, undefined);
    assert.throws(() => validateEntitySearch({ ...body, packTokens: 2001 }));
    assert.equal(graph(), before, 'read pack changed the graph');
    const snapshot = createReadSnapshot(db, cwd);
    store.updateNode(db, newer, { text: '审计记录保留 120 天。' });
    const historical = await searchEntitySnapshot(cwd, snapshot.snapshotId, body);
    assert.equal(historical.memoryPack.source, 'snapshot');
    assert.ok(historical.memoryPack.facts.some(row => row.text.includes('90 天')));
    assert.ok(!historical.memoryPack.context.includes('120 天'));
    console.log('P104: whole-fact budget, source/path labels, C4 ambiguity, read-only graph, scope and pinned snapshots passed');
  } finally { store.closeAll(); rmSync(root, { recursive: true, force: true }); }
}
