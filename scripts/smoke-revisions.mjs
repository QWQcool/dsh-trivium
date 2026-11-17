/** revisions: independent historical regression cases. Run with npm test -- revisions.
 * Each function runs in its own process through run-all; settings and modules never leak. */

export const cases = Object.freeze({ p31, p48, p64, p67, p69 });

async function p31() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /** Public write guard and malformed-chain projection; synthetic native stores only. */

  const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p31-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const store = await import("../lib/store.js");
  const { makeRevisionResolver, supersede } = await import(
    "../lib/revisions.js"
  );
  const { registerTools } = await import("../lib/tools.js");
  const { selectContextRecords } = await import("../lib/context-budget.js");
  const tools = new Map();
  registerTools(
    {
      effect: (fn) => fn(),
      tools: {
        register(t) {
          tools.set(t.name, t);
          return () => {};
        },
      },
      on() {},
    },
    {},
  );
  const snapshot = (db) =>
    JSON.stringify(
      db
        .allNodeIds()
        .map(Number)
        .sort((a, b) => a - b)
        .map((id) => db.get(id)),
    );
  let checks = 0,
    failed = 0;
  const check = (ok, label) => {
    checks++;
    if (ok) console.log("ok  " + label);
    else {
      failed++;
      console.error("FAIL " + label);
    }
  };

  try {
    const cwd = join(root, "public");
    const db = await store.openWorkspaceDb(cwd);
    const old = store.insertNode(db, {
      type: "decision",
      name: "OriginalPolicy",
      text: "The original reviewed policy.",
    });
    const before = snapshot(db);
    const exec = { agent: { session: { id: "p31", header: { cwd } } } };
    const response = await tools
      .get("ctx_remember")
      .execute(
        {
          type: "decision",
          name: "UnconfirmedReplacement",
          text: "An unconfirmed different policy.",
          link_to: old,
          link_label: "supersedes",
        },
        exec,
      );
    check(
      String(response).startsWith("Refused:"),
      "REV-31 ctx_remember cannot bypass human confirmation through link_label",
    );
    check(
      snapshot(db) === before,
      "REV-31 rejected remember leaves no payload, node or edge behind",
    );
    const ordinary = await tools
      .get("ctx_remember")
      .execute(
        {
          type: "preference",
          text: "Keep this supported business relationship.",
          link_to: old,
          link_label: "about",
        },
        exec,
      );
    check(
      String(ordinary).startsWith("Remembered id="),
      "REV-31 normal remember-and-link still works",
    );
    check(
      String(
        await tools
          .get("ctx_link")
          .execute({ from: old, to: old, label: "supersedes" }, exec),
      ).startsWith("Refused:"),
      "REV-31 ctx_link keeps its existing revision guard",
    );

    for (const kind of [
      "cycle",
      "fork",
      "too-long",
      "non-decision",
      "missing-node",
    ]) {
      const badCwd = join(root, kind);
      const bad = await store.openWorkspaceDb(badCwd);
      const ids = Array.from(
        { length: kind === "too-long" ? 34 : kind === "fork" ? 3 : 2 },
        (_, i) =>
          store.insertNode(bad, {
            type: "decision",
            name: `${kind} Policy ${i}`,
            text: `G4_${kind}_${i} unique synthetic policy.`,
            uri: `test://${kind}/${i}`,
          }),
      );
      if (kind === "cycle") {
        assert.equal(
          supersede(bad, { oldId: ids[0], successorId: ids[1] }).ok,
          true,
        );
        assert.equal(
          store.ensureLink(bad, ids[0], ids[1], "supersedes"),
          true,
          "reverse edge, not the already-existing edge",
        );
      } else if (kind === "fork") {
        bad.link(ids[1], ids[0], "supersedes", 0.8);
        bad.link(ids[2], ids[0], "supersedes", 0.8);
      } else if (kind === "too-long") {
        for (let i = 1; i < ids.length; i++)
          bad.link(ids[i], ids[i - 1], "supersedes", 0.8);
      } else {
        bad.link(ids[1], ids[0], "supersedes", 0.8);
        if (kind === "non-decision")
          bad.updatePayload(ids[1], {
            ...bad.get(ids[1]).payload,
            type: "entity",
          });
        else bad.delete(ids[1]);
      }
      const resolver = makeRevisionResolver(bad);
      // The native delete may remove incident edges; a truly absent requested node
      // must still fail closed, without claiming a reachable dangling edge exists.
      const probes =
        kind === "missing-node"
          ? [ids[1]]
          : kind === "cycle"
            ? ids.slice(0, 2)
            : ids;
      check(
        probes.every(
          (id) => !store.currentHeadOf(bad, id).ok && resolver(id) === null,
        ),
        `REV-31 ${kind} is unavailable from every affected node`,
      );
      const plan = selectContextRecords({
        recall: probes.map((id) => ({
          id,
          type: "decision",
          l0: "corrupt candidate",
        })),
        resolveCurrent: resolver,
      });
      check(
        plan.records.length === 0,
        `REV-31 ${kind} does not enter automatic context`,
      );
      if (kind !== "missing-node") {
        const text = await tools
          .get("ctx_find")
          .execute(
            { query: kind },
            { agent: { session: { id: kind, header: { cwd: badCwd } } } },
          );
        check(
          !String(text).includes(`G4_${kind}`),
          `REV-31 ${kind} is not exposed as a current fact by ctx_find`,
        );
      }
    }
  } finally {
    store.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P31 revision gates: ${checks - failed}/${checks}`);
  if (failed) process.exitCode = 1;
}

async function p48() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p48 — a correction retires the decision it replaces.
   *
   * A-5 CORRECTION: "先别动方案 A" and "改用方案 B" were written as two independent
   * decisions, both stayed in the short map, and the model answered with the retired
   * one in 2 of 5 runs. An explicit replacement word now links the new decision to
   * the old one (new supersedes old), the old one leaves the map, and ctx_read can
   * still reach it. Ambiguity is reported instead of guessed.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p48-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  writeFileSync(
    process.env.DSH_TRIVIUM_SETTINGS,
    JSON.stringify({ supersedeMode: "auto" }),
    "utf8",
  );
  const store = await import("../lib/store.js");
  const extract = await import("../lib/extract.js");
  const rev = await import("../lib/revisions.js");

  let checks = 0;
  let failures = 0;
  function check(fn, label) {
    checks += 1;
    try {
      fn();
      console.log("ok " + label);
    } catch (e) {
      failures += 1;
      console.error("FAIL " + label + ": " + e.message);
    }
  }

  const one = (candidate) => async () =>
    JSON.stringify({ candidates: [candidate] });

  try {
    const db = await store.openWorkspaceDb(join(root, "ws"));

    const first = await extract.distill({
      db,
      turns: [{ role: "user", text: "先别动旧方案 A，我们还在评估。" }],
      sessionId: "p48",
      llmCall: one({
        type: "decision",
        name: "方案 A",
        text: "先别动旧方案 A，我们还在评估。",
        quote: "先别动旧方案 A，我们还在评估。",
      }),
    });
    // The rule layer may write its own node for the same sentence, so locate the
    // model-written decision by text instead of trusting applied[0].
    const idOf = (needle) =>
      db
        .allNodeIds()
        .find((id) => String(db.get(id)?.payload?.text || "").includes(needle));
    const oldId = idOf("先别动旧方案 A");
    check(() => assert.ok(oldId), "the first decision is written");

    const second = await extract.distill({
      db,
      turns: [{ role: "user", text: "更正：不再使用旧方案 A，改用方案 B。" }],
      sessionId: "p48",
      llmCall: one({
        type: "decision",
        name: "方案 B",
        text: "更正：不再使用旧方案 A，改用方案 B。",
        quote: "更正：不再使用旧方案 A，改用方案 B。",
      }),
    });
    const newId = idOf("不再使用旧方案 A");
    check(() => assert.ok(newId), "the replacement decision is written");
    check(
      () => assert.ok(second.superseded.some((row) => row.to === oldId)),
      "the replacement is linked to the old decision",
    );
    check(
      () => assert.equal(rev.currentHeadOf(db, oldId).id, newId),
      "the old decision now resolves to the new one",
    );
    check(
      () => assert.equal(store.supersedesIn(db, oldId).length, 1),
      "exactly one successor, no fork",
    );

    const map = store.buildShortMapReport(db, 400).text;
    check(
      () => assert.doesNotMatch(map, /decision:方案 A/),
      "the retired decision leaves the short map",
    );
    check(
      () => assert.match(map, /decision:方案 B/),
      "the current decision stays in the short map",
    );
    check(
      () => assert.match(map, /decisions=1/),
      "the map counts current decisions only",
    );

    // A decision that merely continues the thread must not retire anything.
    const third = await extract.distill({
      db,
      turns: [{ role: "user", text: "采用方案 C 作为备选。" }],
      sessionId: "p48",
      llmCall: one({
        type: "decision",
        name: "方案 C",
        text: "采用方案 C 作为备选。",
      }),
    });
    check(
      () => assert.deepEqual(third.superseded, []),
      "no replacement word, no retirement",
    );

    // Two live decisions answering to the same label: report, do not guess.
    await extract.distill({
      db,
      turns: [{ role: "user", text: "方案 D 暂时保留。" }],
      sessionId: "p48",
      llmCall: one({
        type: "decision",
        name: "方案 D",
        text: "方案 D 暂时保留。",
        quote: "方案 D 暂时保留。",
      }),
    });
    await extract.distill({
      db,
      turns: [{ role: "user", text: "方案 D 还有另一种用法。" }],
      sessionId: "p48",
      llmCall: one({
        type: "decision",
        name: "方案 D",
        text: "方案 D 还有另一种用法。",
        quote: "方案 D 还有另一种用法。",
      }),
    });
    const ambiguous = await extract.distill({
      db,
      turns: [{ role: "user", text: "更正：不再使用方案 D。" }],
      sessionId: "p48",
      llmCall: one({
        type: "decision",
        name: "方案 E",
        text: "更正：不再使用方案 D。",
        quote: "更正：不再使用方案 D。",
      }),
    });
    const dIds = db.allNodeIds().filter((id) => {
      const payload = db.get(id)?.payload || {};
      const text = String(payload.text || "");
      return (
        payload.type === "decision" &&
        text.includes("方案 D") &&
        !text.includes("更正")
      );
    });
    /*
     * Contract correction (W2): the old assertion required every same-label node to
     * be chained. Chaining could hide a fact that was never replaced, so ambiguity
     * is now reported and left for review instead.
     */
    check(
      () =>
        assert.equal(
          ambiguous.superseded.some((row) => row.pending === true),
          true,
        ),
      "an ambiguous replacement is reported as pending",
    );
    check(
      () =>
        assert.equal(
          dIds.some((id) => store.supersedesIn(db, id).length > 0),
          false,
        ),
      "ambiguous targets keep their current status",
    );
    const mapWithAmbiguity = store.buildShortMapReport(db, 400).text;
    check(
      () => assert.doesNotMatch(mapWithAmbiguity, /decision:方案 E/),
      "the unconfirmed decision is not offered as current",
    );

    store.closeAll();
  } finally {
    store.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P48: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p64() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p64 — a merge keeps the body it replaces (option B: node-level history).
   *
   * Zep closes a validity window rather than deleting; Mem0 writes old_memory /
   * new_memory into a side table. Here the node keeps its last three bodies, so
   * "what did this say before" survives without a schema migration and without
   * copying anything that would be refused today.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p64-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const store = await import("../lib/store.js");

  let checks = 0;
  let failures = 0;
  function check(fn, label) {
    checks += 1;
    try {
      fn();
      console.log("ok " + label);
    } catch (e) {
      failures += 1;
      console.error("FAIL " + label + ": " + e.message);
    }
  }

  const base = (text, extra = {}) => ({
    type: "decision",
    name: "上线方案",
    text,
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-01T09:00:00.000Z",
    source: { role: "user", seq: 3, messageId: "m-3" },
    ...extra,
  });

  try {
    // 1. the replaced body is kept, with the time it was written
    const merged = store.mergePayload(
      base("按方案 A 走"),
      base("按方案 A 走，随后改 B"),
    );
    check(
      () => assert.equal(merged.text, "按方案 A 走，随后改 B"),
      "the live text is the new one",
    );
    check(
      () => assert.equal(merged.history?.length, 1),
      "one previous body is kept",
    );
    check(
      () => assert.equal(merged.history[0].text, "按方案 A 走"),
      "the previous body is the old text",
    );
    check(
      () => assert.equal(merged.history[0].at, "2026-11-01T09:00:00.000Z"),
      "the previous body keeps its own timestamp",
    );
    check(
      () => assert.equal(merged.history[0].source?.seq, 3),
      "the previous body keeps its source locator",
    );

    // 2. several merges stack newest-first and stop at three
    let node = base("v1");
    for (const next of ["v2", "v3", "v4", "v5"])
      node = store.mergePayload(node, base(next));
    check(
      () => assert.equal(node.text, "v5"),
      "the live text follows the newest merge",
    );
    check(
      () => assert.equal(node.history.length, store.MAX_MERGE_HISTORY),
      "history is capped",
    );
    check(
      () =>
        assert.deepEqual(
          node.history.map((row) => row.text),
          ["v4", "v3", "v2"],
        ),
      "the newest replaced body comes first",
    );

    // 3. an identical merge adds nothing
    const same = store.mergePayload(base("没变化"), base("没变化"));
    check(
      () => assert.equal(same.history, undefined),
      "merging identical text records no history",
    );

    // 4. a body that would be refused today is not copied back in
    // The merge keeps the longer body, so the incoming text must be the longer one
    // for the credential-shaped body to be the one that gets replaced.
    const secret = store.mergePayload(
      base("部署密钥是 ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
      base(
        "部署已经改用 KMS 托管，原来那个密钥不再使用，等待完成轮换后再清理旧配置，这条只记录运维结论",
      ),
    );
    check(
      () => assert.equal(secret.history?.[0]?.text, "<redacted>"),
      "a credential-shaped previous body is redacted",
    );
    check(
      () => assert.doesNotMatch(JSON.stringify(secret.history), /ghp_/),
      "the credential never reaches history",
    );

    // 5. it survives a real write, and a replacement (which never merges) has none
    const db = await store.openWorkspaceDb(join(root, "ws"));
    const id = store.insertNode(db, {
      type: "decision",
      name: "发布窗口",
      text: "发布窗口是周五",
    });
    store.mergeInto(db, id, {
      type: "decision",
      name: "发布窗口",
      text: "发布窗口是周五下午",
    });
    const stored = db.get(id)?.payload || {};
    check(
      () => assert.equal(stored.text, "发布窗口是周五下午"),
      "the merge updated the stored body",
    );
    check(
      () => assert.equal(stored.history?.[0]?.text, "发布窗口是周五"),
      "the stored node kept the previous body",
    );
    const fresh = store.insertNode(db, {
      type: "decision",
      name: "新决定",
      text: "改用方案 B",
    });
    check(
      () => assert.equal(db.get(fresh)?.payload?.history, undefined),
      "a new node has no history",
    );

    // 6. the panel can show it without a second request
    const rows = store.listNodes(db, {});
    const mergedRow = rows.find((row) => row.id === Number(id));
    check(
      () => assert.equal(mergedRow?.history?.[0]?.text, "发布窗口是周五"),
      "the node list exposes the previous body",
    );
    check(
      () => assert.equal(mergedRow?.historyCount, 1),
      "the node list counts the previous bodies",
    );
    const plainRow = rows.find((row) => row.id === Number(fresh));
    check(
      () => assert.equal(plainRow?.historyCount, 0),
      "an unmerged node reports zero",
    );
    store.closeAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P64: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p67() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p67 — the same write seen twice is not two facts, even when the model words it
   * differently the second time.
   *
   * Live run (W9, 2026-11-02) stored two versions of one correction:
   *   "这次上线改走方案 B；之前定的方案 A 已废弃，不再沿用。"
   *   "这次上线改按方案 B 走，上一个方案（方案 A）已弃用"
   * Same user turn, same name, different paraphrase. Text similarity cannot separate
   * that pair from two genuinely different facts (a "负责人是张三/李四" pair scores
   * higher), so the rule uses provenance: same event + same type + same name.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p67-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const store = await import("../lib/store.js");
  const extract = await import("../lib/extract.js");

  let checks = 0;
  let failures = 0;
  function check(fn, label) {
    checks += 1;
    try {
      fn();
      console.log("ok " + label);
    } catch (e) {
      failures += 1;
      console.error("FAIL " + label + ": " + e.message);
    }
  }
  const turn = (text, seq) => ({
    role: "user",
    text,
    seq,
    messageId: `m-${seq}`,
    at: "2026-11-02T09:00:00.000Z",
    recorded: true,
  });
  const one = (candidate) => async () =>
    JSON.stringify({ candidates: [candidate] });
  const count = (db, needle) =>
    db
      .allNodeIds()
      .filter((id) => String(db.get(id)?.payload?.text || "").includes(needle))
      .length;

  try {
    // 1. replay and turn end disagree on the wording: still one fact
    {
      const db = await store.openWorkspaceDb(join(root, "ws-1"));
      await extract.distill({
        db,
        turns: [turn("这次上线按方案 A 走。", 1)],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案 A",
          text: "这次上线按方案 A 走。",
          quote: "这次上线按方案 A 走。",
        }),
      });
      // Both formulations have real source text; this case isolates event identity.
      const sentence = "上一个方案不要了，走新的，用方案 B。这次上线改走方案 B；之前定的方案 A 已废弃，不再沿用。这次上线改按方案 B 走，上一个方案（方案 A）已弃用";
      const shared = turn(sentence, 2);
      await extract.distill({
        db,
        turns: [shared],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案 B",
          text: "这次上线改走方案 B；之前定的方案 A 已废弃，不再沿用。",
          quote: sentence,
          supersedes: "方案 A",
        }),
      });
      await extract.distill({
        db,
        turns: [shared],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案 B",
          text: "这次上线改按方案 B 走，上一个方案（方案 A）已弃用",
          quote: sentence,
          supersedes: "方案 A",
        }),
      });
      check(
        () => assert.equal(count(db, "方案 B"), 1),
        "a paraphrase of the same write does not create a second node",
      );
      const namedA = db
        .allNodeIds()
        .filter(
          (id) => String(db.get(id)?.payload?.name || "") === "上线方案 A",
        );
      check(
        () => assert.equal(namedA.length, 1),
        "the replaced decision is untouched",
      );
      store.closeAll();
    }

    // 1b. the model renames its own paraphrase: still one write
    {
      const db = await store.openWorkspaceDb(join(root, "ws-1b"));
      await extract.distill({
        db,
        turns: [turn("这次上线按方案 A 走。", 1)],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案 A",
          text: "这次上线按方案 A 走。",
          quote: "这次上线按方案 A 走。",
        }),
      });
      const sentence = "上一个方案不要了，走新的，用方案 B。本次上线改按方案 B 执行；方案 A 已废弃，不再采用。";
      const shared = turn(sentence, 2);
      await extract.distill({
        db,
        turns: [shared],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案 B",
          text: "本次上线改按方案 B 执行；方案 A 已废弃，不再采用。",
          quote: sentence,
          supersedes: "上线方案 A",
        }),
      });
      await extract.distill({
        db,
        turns: [shared],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案",
          text: "本次上线改按方案 B 执行；方案 A 已废弃。",
          quote: sentence,
          supersedes: "方案 A",
        }),
      });
      /*
       * A renamed paraphrase is NOT folded any more: folding on "same event + the
       * stored node already replaced something" merged an unrelated budget fact
       * into the chain and threw REVISION_PROTECTED (review R-04). Without a name
       * match there is no proof it is the same fact, so the safer outcome is two
       * nodes and no exception.
       */
      check(
        () => assert.equal(count(db, "方案 B"), 2),
        "a renamed paraphrase is kept separately, not merged",
      );
      const names = db
        .allNodeIds()
        .map((id) => db.get(id)?.payload?.name)
        .filter(Boolean);
      check(
        () => assert.equal(names.includes("上线方案"), true),
        "the renamed node is stored under its own name",
      );
      store.closeAll();
    }

    // 2. the same wording from a later message is a real new fact
    {
      const db = await store.openWorkspaceDb(join(root, "ws-2"));
      await extract.distill({
        db,
        turns: [turn("这次上线改走方案 B。", 2)],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案 B",
          text: "这次上线改走方案 B。",
          quote: "这次上线改走方案 B。",
        }),
      });
      await extract.distill({
        db,
        turns: [turn("再说一遍：这次上线改走方案 B。", 3)],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案 B",
          text: "这次上线改走方案 B。",
          quote: "再说一遍：这次上线改走方案 B。",
        }),
      });
      // Both carry the same text, so the exact-text retry rule folds them; that is
      // the existing behaviour and it is not what this case is about.
      check(
        () => assert.equal(count(db, "方案 B"), 1),
        "identical text from another message still folds",
      );
      store.closeAll();
    }

    // 3. two different facts from one message keep both names
    {
      const db = await store.openWorkspaceDb(join(root, "ws-3"));
      const shared = turn("负责人是张三，预算上限 5000 元。", 4);
      await extract.distill({
        db,
        turns: [shared],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "负责人",
          text: "负责人是张三",
          quote: shared.text,
        }),
      });
      await extract.distill({
        db,
        turns: [shared],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "预算",
          text: "预算上限 5000 元",
          quote: shared.text,
        }),
      });
      check(() => assert.equal(count(db, "张三"), 1), "the first fact is kept");
      check(
        () => assert.equal(count(db, "5000"), 1),
        "a different name from the same message is kept separately",
      );
      store.closeAll();
    }

    // 4. the merge keeps what it replaced, so a wrong fold is recoverable
    {
      const db = await store.openWorkspaceDb(join(root, "ws-4"));
      const shared = turn("上一个方案不要了，走新的，用方案 B。这次上线改走方案 B，方案 A 作废", 5);
      await extract.distill({
        db,
        turns: [shared],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案 B",
          text: "这次上线改走方案 B",
          quote: shared.text,
        }),
      });
      await extract.distill({
        db,
        turns: [shared],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案 B",
          text: "这次上线改走方案 B，方案 A 作废",
          quote: shared.text,
        }),
      });
      const node = db
        .allNodeIds()
        .map((id) => db.get(id)?.payload || {})
        .find((p) => String(p.text || "").includes("方案 B"));
      check(
        () => assert.equal(node?.text, "这次上线改走方案 B，方案 A 作废"),
        "the richer text wins",
      );
      check(
        () => assert.equal(node?.history?.[0]?.text, "这次上线改走方案 B"),
        "the folded body is kept as history",
      );
      store.closeAll();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P67: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p69() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p69 — the five blockers from the independent 0.8.3 review (R-01..R-05).
   *
   * Every case here was first reported as a counterexample against 2c77f58 and
   * passed at the time: a claim of "replacement" retired a decision the sentence
   * never mentioned, a quoted or negated replacement word retired one anyway, a
   * sequence-number collision merged across sessions, two facts in one sentence
   * collapsed into a chain, and a revision-linked node threw REVISION_PROTECTED.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p69-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  writeFileSync(
    process.env.DSH_TRIVIUM_SETTINGS,
    JSON.stringify({ supersedeMode: "auto" }),
    "utf8",
  );
  const store = await import("../lib/store.js");
  const extract = await import("../lib/extract.js");

  let checks = 0;
  let failures = 0;
  function check(fn, label) {
    checks += 1;
    try {
      fn();
      console.log("ok " + label);
    } catch (e) {
      failures += 1;
      console.error("FAIL " + label + ": " + e.message);
    }
  }
  const turn = (text, seq = 2, extra = {}) => ({
    role: "user",
    text,
    seq,
    messageId: `m-${seq}`,
    at: "2026-11-02T09:00:00.000Z",
    recorded: true,
    ...extra,
  });
  const one = (candidate) => async () =>
    JSON.stringify({ candidates: [candidate] });
  const edges = (db) => {
    const out = [];
    for (const id of db.allNodeIds())
      for (const e of db.get(id)?.edges || [])
        if (String(e.label) === "supersedes") out.push(`${id}->${e.targetId}`);
    return out;
  };
  async function seed(db, text = "本次上线按方案 A 执行", extra = {}) {
    return store.insertNode(db, {
      type: "decision",
      name: "上线方案",
      text,
      ...extra,
    });
  }

  try {
    // R-01: a supersedes claim the sentence does not back retires nothing
    {
      const db = await store.openWorkspaceDb(join(root, "ws-r01"));
      const oldId = await seed(db);
      const sentence = "发布负责人是张三。";
      const out = await extract.distill({
        db,
        turns: [turn(sentence)],
        sessionId: "new",
        llmCall: one({
          type: "decision",
          name: "负责人",
          text: "发布负责人是张三。",
          quote: sentence,
          supersedes: "方案 A",
        }),
      });
      check(
        () => assert.equal(edges(db).length, 0),
        "a claim without replacement wording retires nothing",
      );
      check(
        () => assert.equal(store.currentHeadOf(db, oldId).id, oldId),
        "the old decision is still current",
      );
      check(
        () =>
          assert.equal(
            out.superseded.some(
              (row) => row.skipped === "no-replacement-wording",
            ),
            true,
          ),
        "the reason is reported",
      );
      store.closeAll();
    }

    // R-01b: a deictic name is not wording either
    {
      const db = await store.openWorkspaceDb(join(root, "ws-r01b"));
      const oldId = await seed(db);
      const sentence = "发布负责人是张三。";
      await extract.distill({
        db,
        turns: [turn(sentence)],
        sessionId: "new",
        llmCall: one({
          type: "decision",
          name: "负责人",
          text: "发布负责人是张三。",
          quote: sentence,
          supersedes: "上一个方案",
        }),
      });
      check(
        () => assert.equal(edges(db).length, 0),
        "a deictic name alone does not authorise a retirement",
      );
      check(
        () => assert.equal(store.currentHeadOf(db, oldId).id, oldId),
        "and the head stays put",
      );
      store.closeAll();
    }

    // R-02: negated and quoted replacement words retire nothing
    for (const [label, sentence] of [
      ["negated", "不要换掉方案 A，继续沿用。"],
      ["quoted", "请把“换掉方案 A”这句话翻译成英文。"],
    ]) {
      const db = await store.openWorkspaceDb(join(root, `ws-r02-${label}`));
      const oldId = await seed(db);
      await extract.distill({
        db,
        turns: [turn(sentence)],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案",
          text: "改用方案 B",
          quote: sentence,
        }),
      });
      check(
        () => assert.equal(edges(db).length, 0),
        `a ${label} replacement word retires nothing`,
      );
      check(
        () => assert.equal(store.currentHeadOf(db, oldId).id, oldId),
        `the head survives a ${label} cue`,
      );
      store.closeAll();
    }

    // R-03: the same sequence number in another session is not the same event
    {
      const db = await store.openWorkspaceDb(join(root, "ws-r03"));
      const oldId = await seed(db, "本次上线按方案 A 执行", {
        source: {
          kind: "extract",
          sessionId: "other-session",
          seq: 1,
          messageId: null,
          role: "user",
          quoteMatch: "exact",
        },
      });
      const sentence = "本次上线改用方案 B 执行；算了，不用 A 了，改 B";
      const out = await extract.distill({
        db,
        turns: [turn(sentence, 1, { messageId: null })],
        sessionId: "new-session",
        llmCall: one({
          type: "decision",
          name: "上线方案",
          text: "本次上线改用方案 B 执行",
          quote: sentence,
        }),
      });
      check(
        () => assert.equal(out.applied[0]?.action, "insert"),
        "a cross-session sequence collision inserts instead of merging",
      );
      check(
        () =>
          assert.equal(db.get(oldId)?.payload?.text, "本次上线按方案 A 执行"),
        "the old body is not overwritten",
      );
      store.closeAll();
    }

    // R-04: two facts from one sentence do not collapse into the chain
    {
      const db = await store.openWorkspaceDb(join(root, "ws-r04"));
      const oldId = await seed(db);
      const sentence =
        "不再使用方案 A，改用方案 B；发布预算为 5000 元，必须由人工核验之后执行。";
      const out = await extract.distill({
        db,
        turns: [turn(sentence)],
        sessionId: "s",
        llmCall: async () =>
          JSON.stringify({
            candidates: [
              {
                type: "decision",
                name: "上线方案 B",
                text: "改用方案 B",
                quote: sentence,
                supersedes: "方案 A",
              },
              {
                type: "decision",
                name: "发布预算",
                text: "发布预算为 5000 元，必须由人工核验之后执行。",
                quote: sentence,
              },
            ],
          }),
      });
      const budget = db
        .allNodeIds()
        .map((id) => db.get(id)?.payload || {})
        .find((p) => String(p.text || "").includes("5000"));
      check(() => assert.ok(budget), "the budget fact is written");
      check(
        () =>
          assert.equal(
            budget?.text,
            "发布预算为 5000 元，必须由人工核验之后执行。",
          ),
        "and it keeps its own body",
      );
      check(
        () => assert.equal(edges(db).length, 1),
        "only the correction creates a link",
      );
      check(
        () => assert.equal(edges(db)[0], `${out.applied[0].id}->${oldId}`),
        "the link points at the replaced decision",
      );
      store.closeAll();
    }

    // R-04b: a longer repeat on a revision-linked node must not throw
    {
      const db = await store.openWorkspaceDb(join(root, "ws-r04b"));
      await seed(db);
      const sentence = "不再使用方案 A，改用方案 B；改用方案 B，部署前必须经过人工验证并完成备份";
      const first = await extract.distill({
        db,
        turns: [turn(sentence)],
        sessionId: "s",
        llmCall: one({
          type: "decision",
          name: "上线方案 B",
          text: "改用方案 B",
          quote: sentence,
          supersedes: "方案 A",
        }),
      });
      let second;
      let threw = null;
      try {
        second = await extract.distill({
          db,
          turns: [turn(sentence)],
          sessionId: "s",
          llmCall: one({
            type: "decision",
            name: "上线方案 B",
            text: "改用方案 B，部署前必须经过人工验证并完成备份",
            quote: sentence,
            supersedes: "方案 A",
          }),
        });
      } catch (err) {
        threw = err.message;
      }
      check(
        () => assert.equal(threw, null),
        "a repeat with a longer body does not throw REVISION_PROTECTED",
      );
      check(
        () => assert.equal(second?.applied.length, 1),
        "the longer body is stored",
      );
      check(
        () => assert.equal(edges(db).length, 1),
        "and the chain is not forked",
      );
      store.closeAll();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P69: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}
