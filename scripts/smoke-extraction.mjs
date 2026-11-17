/** extraction: independent historical regression cases. Run with npm test -- extraction.
 * Each function runs in its own process through run-all; settings and modules never leak. */

export const cases = Object.freeze({ p43, p45, p46, p49, p50, p66, p100, p103 });

async function p43() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p43 — a tool-driving sentence must not swallow the fact in the same turn.
   *
   * Regression for the R3 F1 finding: `distillableTurns()` used to drop the whole
   * user turn when it matched a tool-driving cue, so "按顺序调用工具，生产端口是 9443。"
   * was consumed without rule extraction, model extraction, or pending retention.
   *
   * Direction of the fix: only a turn whose EVERY sentence is a pure operation
   * instruction may be dropped. Anything that cannot be proven empty goes to the
   * existing extraction path. Over-calling is acceptable; losing a fact is not.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p43-"));
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
  const callOf = (text) => extract.shouldExtractBatch([{ role: "user", text }]);

  try {
    // 1. the reported failure: cue sentence plus a real fact in the same turn
    for (const text of [
      "按顺序调用工具，生产端口是 9443。",
      "只用 ctx_find，负责人是张三。",
      "贴工具原文：预算上限改成 5000 元。",
      "按顺序调用工具。生产端口是 9443。",
      "只用 ctx_read 读一下，别再推荐看过的视频。",
    ]) {
      check(
        () => assert.equal(callOf(text).call, true),
        "mixed tool cue keeps the fact: " + text,
      );
    }

    // 2. a fact that only looks numeric must survive too
    check(
      () =>
        assert.equal(callOf("按顺序调用工具，重试次数改为 5 次。").call, true),
      "count fact survives the cue",
    );

    // 3. a genuinely pure operation instruction may still be skipped
    for (const text of ["只用 ctx_find。", "按顺序调用工具。", "贴工具原文"]) {
      check(
        () => assert.equal(callOf(text).call, false),
        "pure operation wording may skip: " + text,
      );
    }

    // 4. whole-window rule still holds: a pure operation user turn + assistant fact
    check(
      () =>
        assert.equal(
          extract.shouldExtractBatch([
            { role: "user", text: "按顺序调用工具。" },
            {
              role: "assistant",
              text: "采用方案 CedarPlan，发布前需要执行验收。",
            },
          ]).call,
          true,
        ),
      "assistant fact still opens the window",
    );

    // 5. rule extraction sees the fact, not just the gate
    const rule = extract.ruleCandidates([
      { role: "user", text: "记住：按顺序调用工具，视频偏好是有实拍演示。" },
    ]);
    check(
      () => assert.equal(rule.length >= 1, true),
      "rule candidate still produced for a mixed turn",
    );

    // 6. end to end: the model is actually asked, and the prompt carries the fact
    const cwd = join(root, "ws");
    const db = await store.openWorkspaceDb(cwd);
    let prompt = "";
    const result = await extract.distill({
      db,
      turns: [{ role: "user", text: "按顺序调用工具，生产端口是 9443。" }],
      sessionId: "p43",
      llmCall: async (p) => {
        prompt = p;
        return JSON.stringify({
          candidates: [
            { type: "decision", name: "生产端口", text: "生产端口是 9443。" },
          ],
        });
      },
    });
    check(
      () => assert.match(prompt, /生产端口是 9443/),
      "extraction prompt carries the fact text",
    );
    check(
      () => assert.equal(result.gate.skipped, false),
      "gate does not report a skip for a mixed turn",
    );
    check(
      () => assert.equal(result.applied.length, 1),
      "extracted fact is applied to the database",
    );
    check(() => assert.equal(result.llmFailed, false), "no extraction failure");

    // 7. and it is visible to a later session
    const hits = db
      .allNodeIds()
      .map((id) => db.get(id)?.payload)
      .filter((p) => String(p?.text || "").includes("9443"));
    check(
      () => assert.equal(hits.length >= 1, true),
      "fact is readable back from the workspace database",
    );

    // 8. the pending window is not consumed when the only content is operation wording
    const empty = await extract.distill({
      db,
      turns: [{ role: "user", text: "只用 ctx_find。" }],
      sessionId: "p43",
      llmCall: async () => {
        throw new Error("must not be called");
      },
    });
    check(
      () => assert.equal(empty.applied.length, 0),
      "pure operation turn applies nothing",
    );
    store.closeAll();
  } finally {
    store.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P43: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p45() {
  const { default: assert } = await import("node:assert/strict");
  /**
   * p45 — extraction asks for reasoning "off", but never depends on it.
   *
   * A-3 baseline (real model): 12 of 18 extraction calls ended
   * stop_reason=max_tokens even with a 900-token budget, because reasoning ate the
   * budget before any JSON was written. Extraction is a JSON errand, so it requests
   * the "off" effort and retries once without it when the host's catalog does not
   * advertise that effort (an unknown effort must not disable extraction).
   */

  process.env.DSH_HOME = "C:/nonexistent-p45-home";
  const { makeLlmCall } = await import("../lib/index.js");

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
  async function checkAsync(fn, label) {
    checks += 1;
    try {
      await fn();
      console.log("ok " + label);
    } catch (e) {
      failures += 1;
      console.error("FAIL " + label + ": " + e.message);
    }
  }

  const session = {
    id: "session-p45",
    requestHeader: () => ({
      config: { provider: "deepseek-official", model: "deepseek-flash" },
    }),
  };

  function host({ failFirst }) {
    const calls = [];
    const llm = {
      stream(options) {
        calls.push(JSON.parse(JSON.stringify(options)));
        if (failFirst && calls.length === 1) {
          return (async function* () {
            const err = new Error(
              'provider "x" model "y" does not support reasoning effort "off"',
            );
            err.code = "UNSUPPORTED_REASONING_EFFORT";
            throw err;
          })();
        }
        return (async function* () {
          throw new Error("stop-here");
        })();
      },
    };
    return { calls, ctx: { llm } };
  }

  // 1. happy path: first attempt asks for the off effort and a 900-token budget
  {
    const { calls, ctx } = host({ failFirst: false });
    const call = makeLlmCall(ctx, session, null);
    await call("prompt").catch(() => {});
    check(
      () => assert.equal(calls.length, 1),
      "one attempt when the host accepts the effort",
    );
    check(
      () => assert.equal(calls[0].reasoningEffort, "off"),
      "extraction asks for reasoning off",
    );
    check(
      () => assert.equal(calls[0].maxTokens, 900),
      "extraction keeps the 900-token budget",
    );
    check(
      () => assert.equal(calls[0].provider, "deepseek-official"),
      "provider comes from the session header",
    );
  }

  // 2. unknown effort: retry once without it, everything else unchanged
  {
    const { calls, ctx } = host({ failFirst: true });
    const call = makeLlmCall(ctx, session, null);
    await checkAsync(async () => {
      await assert.rejects(() => call("prompt"), /stop-here/);
    }, "the retry error still propagates");
    check(() => assert.equal(calls.length, 2), "exactly one fallback attempt");
    check(
      () => assert.equal(calls[1].reasoningEffort, undefined),
      "the fallback drops the effort",
    );
    check(
      () => assert.equal(calls[1].maxTokens, 900),
      "the fallback keeps the budget",
    );
    check(
      () => assert.equal(calls[1].model, "deepseek-flash"),
      "the fallback keeps the model",
    );
  }

  // 3. an unrelated error is not retried
  {
    const { calls, ctx } = host({ failFirst: false });
    const call = makeLlmCall(ctx, session, null);
    await checkAsync(async () => {
      await assert.rejects(() => call("prompt"), /stop-here/);
    }, "unrelated errors propagate");
    check(
      () => assert.equal(calls.length, 1),
      "unrelated errors are not retried",
    );
  }

  console.log(`P45: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p46() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p46 — credential values are refused on the way into the database, and the
   * refusal is reported instead of silently dropping the fact.
   *
   * A-3 showed the extractor no longer redacts credential-shaped text by itself
   * once extraction runs with reasoning off, so the gate must recognise the shapes.
   * The refusal must not echo the secret back into logs or status either.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p46-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const store = await import("../lib/store.js");
  const extract = await import("../lib/extract.js");
  const { looksSecret } = await import("../lib/schema.js");
  const hygiene = await import("../lib/hygiene.js");

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

  // 1. credential shapes are recognised
  for (const [label, value] of [
    ["github pat", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github fine-grained", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"],
    ["aws access key", "AKIAIOSFODNN7EXAMPLE"],
    ["google api key", "AIzaSyD-abcdefghijklmnopqrstuvwxyz012345"],
    ["npm token", "npm_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["slack token", "xoxb-1234567890-abcdefghijkl"],
    [
      "jwt",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
    ["pem", "-----BEGIN RSA PRIVATE KEY-----"],
    ["chinese password", "数据库密码：Zx9q2Wm7"],
    ["chinese code word", "发布前置校验口令 verify-QA-71"],
  ]) {
    check(() => assert.equal(looksSecret(value), true), "refuses " + label);
  }

  // 2. ordinary facts are not mistaken for credentials
  for (const [label, value] of [
    ["project code name", "本次发布代号是 BlueHeron。"],
    ["port", "生产端口是 9443。"],
    ["person", "项目负责人是张三。"],
    ["password topic without a value", "密码学很难，团队还在补课。"],
    ["budget", "预算上限是 5000 元。"],
    ["hash in prose", "清单的 sha256 已核对过。"],
    // A bare English noun is a topic, not a value.
    ["token budget", "token 预算上限是 500，别超。"],
    [
      "password policy",
      "The password policy requires 12 characters and a symbol.",
    ],
    ["api key location", "api key 存在环境变量里，不要写进仓库。"],
  ]) {
    check(() => assert.equal(looksSecret(value), false), "keeps " + label);
  }

  // 2b. the same words DO count once a value follows them
  for (const [label, value] of [
    ["token assignment", "token=abcd1234efgh"],
    ["password is", "the password is hunter2"],
    ["api key colon", "api_key: AIzaSyD-abcdefghijklmnopqrstuvwxyz012345"],
    ["sk prefix alone", "use sk-abcdefghijklmnopqrstuvwxyz012345"],
    ["bearer header", "Authorization: bearer abcdef1234567890"],
  ]) {
    check(
      () => assert.equal(looksSecret(value), true),
      "still refuses " + label,
    );
  }

  // 3. the extraction path refuses the candidate and reports it
  const cwd = join(root, "ws");
  const db = await store.openWorkspaceDb(cwd);
  const result = await extract.distill({
    db,
    turns: [
      {
        role: "user",
        text: "我的部署密钥是 ghp_abcdefghijklmnopqrstuvwxyz0123456789，记住它。部署目标是预发环境。",
      },
    ],
    sessionId: "p46",
    llmCall: async () =>
      JSON.stringify({
        candidates: [
          {
            type: "preference",
            name: "部署密钥",
            text: "部署密钥是 ghp_abcdefghijklmnopqrstuvwxyz0123456789。",
          },
          { type: "decision", name: "部署目标", text: "部署目标是预发环境。" },
        ],
      }),
  });
  check(
    () => assert.equal(result.applied.length, 1),
    "the clean candidate is written",
  );
  check(
    () => assert.equal(result.applied[0].text, "部署目标是预发环境。"),
    "the written candidate is the clean one",
  );
  check(
    () => assert.equal(result.skipped.length, 1),
    "the secret candidate is reported as skipped",
  );
  check(
    () => assert.equal(result.skipped[0].reason, "secret"),
    "skip reason is secret",
  );
  check(
    () => assert.equal(result.skipped[0].preview, "<redacted>"),
    "the skip report does not echo the secret",
  );
  check(
    () => assert.equal(typeof result.skipped[0].length, "number"),
    "the skip report keeps only a length",
  );
  const stored = db
    .allNodeIds()
    .map((id) => String(db.get(id)?.payload?.text || ""))
    .join("\n");
  check(
    () => assert.doesNotMatch(stored, /ghp_/),
    "no credential reached the database",
  );
  check(
    () => assert.match(stored, /预发环境/),
    "the clean fact did reach the database",
  );

  // 4. the write gate used by ctx_remember shares the same rule
  check(
    () =>
      assert.equal(
        hygiene.sanitizeForWrite(
          "部署密钥是 ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        ).ok,
        false,
      ),
    "ctx_remember gate refuses the same value",
  );
  check(
    () =>
      assert.equal(hygiene.sanitizeForWrite("部署目标是预发环境。").ok, true),
    "ctx_remember gate keeps the clean fact",
  );

  store.closeAll();
  rmSync(root, { recursive: true, force: true });
  console.log(`P46: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p49() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p49 — an invented absolute date is dropped, the fact itself is kept.
   *
   * A-5 caught "On 2026-04-06 (per conversation context), user corrected: ..." in a
   * session that ran on 2026-10-30. A date the conversation never contained is not a
   * detail worth losing the whole fact over, so it is removed and reported; if the
   * date was the whole content the candidate is refused instead.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p49-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const store = await import("../lib/store.js");
  const extract = await import("../lib/extract.js");
  const dates = await import("../lib/date-parse.js");

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
  const retained = result => result.applied[0]?.text || result.unverified?.[0]?.text || "";
  const one = (candidate) => async () =>
    JSON.stringify({ candidates: [candidate] });

  try {
    const db = await store.openWorkspaceDb(join(root, "ws"));

    // 1. invented date in a leading clause is removed, the fact survives
    const invented = await extract.distill({
      db,
      turns: [{ role: "user", text: "更正：不再使用旧方案 A，改用方案 B。" }],
      sessionId: "p49",
      llmCall: one({
        type: "decision",
        name: "方案 B",
        text: "On 2026-04-06 (per conversation context), user corrected: switch from plan A to plan B.",
      }),
    });
    const stored = String(retained(invented));
    check(
      () => assert.equal(invented.applied.length + invented.unverified.length, 1),
      "the scrubbed fact is retained as written or pending",
    );
    check(
      () => assert.doesNotMatch(stored, /2026-04-06/),
      "the invented date is gone from the stored text",
    );
    check(
      () => assert.match(stored, /switch from plan A to plan B/i),
      "the fact body survives",
    );
    check(
      () => assert.equal(invented.adjusted.length, 1),
      "the removal is reported",
    );
    check(
      () => assert.deepEqual(invented.adjusted[0].removed, ["2026-04-06"]),
      "the removed date is named",
    );

    // 1b. removing a prefix date must not leave its connector behind
    const residue = await extract.distill({
      db,
      turns: [{ role: "user", text: "把发布日期记一下。" }],
      sessionId: "p49",
      llmCall: one({
        type: "decision",
        name: "发布安排",
        text: "2026-07-13 起采用方案 B",
      }),
    });
    const residueText = String(retained(residue));
    check(
      () => assert.doesNotMatch(residueText, /2026-07-13/),
      "the date is gone",
    );
    check(
      () => assert.doesNotMatch(residueText, /^起/),
      "the connector that belonged to the date is gone too",
    );
    check(
      () => assert.equal(residueText, "采用方案 B"),
      "what remains is the fact itself",
    );

    // 2. a date that really appeared in the window is kept as-is
    const real = await extract.distill({
      db,
      turns: [{ role: "user", text: "2026-10-30 起，发布前必须先跑 smoke。" }],
      sessionId: "p49",
      llmCall: one({
        type: "decision",
        name: "发布前置",
        text: "2026-10-30 起，发布前必须先跑 smoke。",
      }),
    });
    check(
      () => assert.match(String(retained(real)), /2026-10-30/),
      "a supported date is kept",
    );
    check(
      () => assert.equal(real.adjusted.length, 0),
      "nothing is reported when the date is supported",
    );

    // 3. the same date written in another format still counts as supported
    const otherFormat = await extract.distill({
      db,
      turns: [{ role: "user", text: "截止日期是 2026年12月31日。" }],
      sessionId: "p49",
      llmCall: one({
        type: "decision",
        name: "截止日期",
        text: "预算截止 2026-12-31。",
      }),
    });
    check(
      () =>
        assert.match(String(retained(otherFormat)), /2026-12-31/),
      "format differences do not count as invented",
    );
    check(
      () => assert.equal(otherFormat.adjusted.length, 0),
      "no adjustment for a cross-format match",
    );

    /*
     * C2: English month spellings are unambiguous, so they take part in exactly the
     * same check — a spelled date in the window authorises the abbreviated form in
     * the fact, and an invented one is still removed.
     */
    const englishReal = await extract.distill({
      db,
      turns: [{ role: "user", text: "Ship on November 20, 2026." }],
      sessionId: "p49",
      llmCall: one({
        type: "decision",
        name: "发布日",
        text: "Ship on Nov 20, 2026.",
      }),
    });
    check(
      () => assert.equal(englishReal.adjusted.length, 0),
      "an English date in the window authorises the abbreviated form",
    );
    check(
      () =>
        assert.match(
          String(retained(englishReal)),
          /Nov 20, 2026/,
        ),
      "and the fact keeps the date as written",
    );

    const englishInvented = await extract.distill({
      db,
      turns: [{ role: "user", text: "把结论记一下。" }],
      sessionId: "p49",
      llmCall: one({
        type: "decision",
        name: "发布日",
        text: "Ship on November 20, 2026.",
      }),
    });
    check(
      () => assert.equal(englishInvented.adjusted.length, 1),
      "an invented English date is reported",
    );
    check(
      () =>
        assert.deepEqual(englishInvented.adjusted[0].removed, ["2026-11-20"]),
      "it is named by the same key",
    );
    check(
      () =>
        assert.doesNotMatch(
          String(retained(englishInvented)),
          /November/,
        ),
      "and removed from the fact",
    );

    for (const malformed of [
      "November 202026",
      "November 20th2026",
      "20 Nov2026",
      "20 Nov.2026",
    ]) {
      check(
        () =>
          assert.deepEqual(dates.absoluteDates(`Ship on ${malformed}.`), []),
        `the body parser rejects a missing year separator: ${malformed}`,
      );
    }
    const englishMalformedSource = await extract.distill({
      db,
      turns: [{ role: "user", text: "Ship on November 202026." }],
      sessionId: "p49",
      llmCall: one({
        type: "decision",
        name: "格式错误的发布日",
        text: "Ship on November 20, 2026.",
      }),
    });
    check(() => {
      assert.equal(englishMalformedSource.applied.length + englishMalformedSource.unverified.length, 1);
      assert.deepEqual(englishMalformedSource.adjusted[0]?.removed, [
        "2026-11-20",
      ]);
      assert.doesNotMatch(retained(englishMalformedSource), /November/);
    }, "a malformed source date cannot authorise a date invented by the model");

    // 4. if the date was the whole content, refuse instead of storing a stub
    const stub = await extract.distill({
      db,
      // Not filler, so the gate really calls the model and the candidate is seen.
      turns: [{ role: "user", text: "把发布日期记一下。" }],
      sessionId: "p49",
      llmCall: one({ type: "decision", name: "日期", text: "2026-04-06" }),
    });
    check(
      () => assert.equal(stub.applied.length, 0),
      "a date-only candidate is not stored",
    );
    check(
      () =>
        assert.equal(
          stub.skipped.some((row) => row.reason === "unsupported-date"),
          true,
        ),
      "the refusal is named unsupported-date",
    );

    // 5. dates inside the fact body (not a leading clause) are also handled
    const inlineDate = await extract.distill({
      db,
      turns: [{ role: "user", text: "负责人换成李四。" }],
      sessionId: "p49",
      llmCall: one({
        type: "decision",
        name: "负责人",
        text: "负责人换成李四（2025-01-01 确认）。",
      }),
    });
    check(
      () =>
        assert.doesNotMatch(
          String(retained(inlineDate)),
          /2025-01-01/,
        ),
      "an inline invented date is removed",
    );
    check(
      () => assert.match(String(retained(inlineDate)), /李四/),
      "the fact body still survives",
    );

    // 6. a relative expression the model resolved correctly keeps its date.
    // W3: the anchor is the source turn's own timestamp, not "now".
    const NOW = new Date("2026-10-30T00:00:00Z");
    const anchored = {
      role: "user",
      text: "下周五之前必须提交。",
      seq: 21,
      messageId: "m-21",
      at: "2026-10-30T09:00:00+08:00",
    };
    const resolved = await extract.distill({
      db,
      turns: [anchored],
      sessionId: "p49",
      now: NOW,
      llmCall: one({
        type: "decision",
        name: "提交期限",
        text: "2026-11-06 之前必须提交。",
        quote: anchored.text,
      }),
    });
    check(
      () => assert.match(String(retained(resolved)), /2026-11-06/),
      "a correctly resolved relative date is kept",
    );
    check(
      () => assert.equal(resolved.adjusted.length, 0),
      "the resolved date is not reported as invented",
    );

    // 7. the allowance does not cover a date far outside the plausible window
    const farOff = await extract.distill({
      db,
      turns: [anchored],
      sessionId: "p49",
      now: NOW,
      llmCall: one({
        type: "decision",
        name: "提交期限",
        text: "2020-01-01 之前必须提交。",
        quote: anchored.text,
      }),
    });
    check(
      () =>
        assert.doesNotMatch(
          String(retained(farOff)),
          /2020-01-01/,
        ),
      "a far-off date is still removed",
    );
    check(
      () => assert.equal(farOff.adjusted.length, 1),
      "the far-off removal is reported",
    );

    store.closeAll();
  } finally {
    store.closeAll();
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P49: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p50() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p50 (W1) — source events must carry real host locators through buffer, pending
   * and write, and a model-written quote must never become user evidence.
   *
   * Written before the implementation: every assertion below fails on 0.8.2.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p50-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const src = await import("../lib/source-events.js");
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

  // Real host event shapes, copied from an observed session/event stream.
  const userEvent = (
    text,
    seq = 11,
    id = "b444c5c4-0214-4040-abe8-a41bfe79261c",
    time = 1793279146761,
  ) => ({
    type: "user/message",
    seq,
    time,
    data: {
      content: [{ type: "text", text }],
      source: { kind: "user" },
      role: "user",
      id,
    },
  });
  const pluginEvent = (text) => ({
    type: "user/message",
    seq: 10,
    time: 1793279146760,
    data: {
      content: [{ type: "text", text }],
      source: { kind: "plugin:dsh-trivium", form: "snapshot" },
      role: "user",
      id: "map-1",
    },
  });
  const assistantEvent = (text, seq = 19) => ({
    type: "assistant/message",
    seq,
    turn: 1,
    data: {
      turn: 1,
      step: 0,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        id: "a-1",
      },
      usage: {},
      stream: true,
    },
  });
  const toolEvent = (text, ok = true) => ({
    type: "tool/result",
    seq: 62,
    turn: 3,
    data: {
      turn: 3,
      step: 1,
      message: {
        role: "tool",
        toolCallId: "c1",
        content: [{ type: "text", text }],
        isError: !ok,
        id: "t-1",
      },
    },
  });

  try {
    // 1. a real user event keeps every locator the host actually provides
    const userTurn = src.turnFromEvent(userEvent("记住：生产端口是 9443。"));
    check(
      () => assert.equal(userTurn.role, "user"),
      "user event becomes a user turn",
    );
    check(() => assert.equal(userTurn.seq, 11), "event sequence is kept");
    check(
      () =>
        assert.equal(
          userTurn.messageId,
          "b444c5c4-0214-4040-abe8-a41bfe79261c",
        ),
      "message id is kept",
    );
    check(
      () => assert.equal(userTurn.at, new Date(1793279146761).toISOString()),
      "source time is kept as an absolute timestamp",
    );
    check(
      () => assert.equal(userTurn.recorded, true),
      "a turn with a locator reports itself as recorded",
    );

    // 2. our own injected map is not user evidence and is not buffered
    check(
      () =>
        assert.equal(
          src.turnFromEvent(pluginEvent("dsh-trivium memory map: …")),
          null,
        ),
      "plugin-injected message is not buffered",
    );

    // 3. assistant and tool turns are labelled, never "user"
    const aTurn = src.turnFromEvent(assistantEvent("采用方案 CedarPlan。"));
    check(
      () => assert.equal(aTurn.role, "assistant"),
      "assistant event keeps its role",
    );
    const tTurn = src.turnFromEvent(toolEvent("生产端口是 9443。"));
    check(() => assert.equal(tTurn.role, "tool"), "tool event keeps its role");
    check(() => assert.equal(tTurn.ok, true), "tool result keeps its ok flag");

    // 4. missing locators degrade to unknown, never to a made-up value
    const bare = src.turnFromEvent({
      type: "user/message",
      data: {
        content: [{ type: "text", text: "没有定位信息。" }],
        source: { kind: "user" },
      },
    });
    check(() => assert.equal(bare.seq, null), "missing sequence is null");
    check(
      () => assert.equal(bare.messageId, null),
      "missing message id is null",
    );
    check(() => assert.equal(bare.at, null), "missing time is null");
    check(
      () => assert.equal(bare.recorded, false),
      "a turn without locators reports itself as not recorded",
    );

    // 5. a quote that matches a user turn becomes user evidence with its locators
    const turns = [userTurn];
    const matched = src.buildSource({
      quote: "记住：生产端口是 9443。",
      turns,
      sessionId: "s1",
      via: "extract",
    });
    check(
      () => assert.equal(matched.quoteMatch, "exact"),
      "an exact quote is recognised as exact",
    );
    check(() => assert.equal(matched.role, "user"), "the source role is user");
    check(
      () => assert.equal(matched.messageId, userTurn.messageId),
      "the source carries the matched message id",
    );
    check(
      () => assert.equal(matched.seq, 11),
      "the source carries the matched sequence",
    );
    check(
      () => assert.equal(src.isUserEvidence(matched), true),
      "a matched user quote counts as user evidence",
    );

    // 6. the same words written by the assistant are not user evidence
    const aiOnly = src.buildSource({
      quote: "采用方案 CedarPlan。",
      turns: [aTurn],
      sessionId: "s1",
      via: "extract",
    });
    check(
      () => assert.equal(aiOnly.role, "assistant"),
      "assistant wording keeps the assistant role",
    );
    check(
      () => assert.equal(src.isUserEvidence(aiOnly), false),
      "assistant wording is not user evidence",
    );

    // 7. an unmatched quote is kept but marks the source as unmatched
    const unmatched = src.buildSource({
      quote: "我从没这么说。",
      turns,
      sessionId: "s1",
      via: "extract",
    });
    check(
      () => assert.equal(unmatched.quoteMatch, "none"),
      "an unmatched quote is reported as none",
    );
    check(
      () => assert.equal(unmatched.role, "unknown"),
      "an unmatched quote has an unknown role",
    );
    check(
      () => assert.equal(unmatched.quote, "我从没这么说。"),
      "the quote is still displayed",
    );
    check(
      () => assert.equal(src.isUserEvidence(unmatched), false),
      "an unmatched quote is not user evidence",
    );

    // 8. pending keeps the locators unchanged (no re-timestamping on replay)
    const cwd = join(root, "ws");
    await extract.savePending(cwd, { sessionId: "s1", turns });
    const back = extract.loadPending(cwd);
    check(
      () => assert.equal(back.turns[0].messageId, userTurn.messageId),
      "pending keeps the message id",
    );
    check(
      () => assert.equal(back.turns[0].at, userTurn.at),
      "pending keeps the original source time",
    );
    check(
      () => assert.equal(back.turns[0].seq, 11),
      "pending keeps the sequence",
    );

    // 9. an old pending file without the new fields still loads, fields unknown
    const legacy = join(root, "ws-legacy");
    await extract.savePending(legacy, {
      sessionId: "s0",
      turns: [{ role: "user", text: "旧数据。" }],
    });
    const legacyBack = extract.loadPending(legacy);
    check(
      () => assert.equal(legacyBack.turns[0].text, "旧数据。"),
      "legacy pending still loads",
    );
    check(
      () => assert.equal(src.turnLocator(legacyBack.turns[0]).known, false),
      "legacy turn reports an unknown locator",
    );

    // 10. the same sentence twice is two events; a retried event is one
    const twice = [
      src.turnFromEvent(userEvent("同一句。", 11, "m-1")),
      src.turnFromEvent(userEvent("同一句。", 12, "m-2")),
    ];
    check(
      () => assert.equal(twice.length, 2),
      "two identical sentences stay two turns",
    );
    check(
      () => assert.notEqual(twice[0].messageId, twice[1].messageId),
      "identical text does not collapse two events",
    );
    const appended = [];
    src.appendSourceTurn(appended, twice[0]);
    src.appendSourceTurn(appended, twice[0]);
    check(
      () => assert.equal(appended.length, 1),
      "a retried event is not registered twice",
    );
    src.appendSourceTurn(appended, {
      ...twice[0],
      text: "同一定位符但内容不同。",
    });
    src.appendSourceTurn(appended, {
      ...twice[0],
      role: "tool",
      name: "test",
      ok: false,
    });
    src.appendSourceTurn(appended, {
      ...twice[0],
      role: "tool",
      name: "test",
      ok: true,
    });
    check(
      () => assert.equal(appended.length, 4),
      "reused locator keeps changed text, role, and tool outcome",
    );
    const seqOnly = [];
    src.appendSourceTurn(seqOnly, { role: "user", seq: 7, text: "第一条" });
    src.appendSourceTurn(seqOnly, { role: "user", seq: 7, text: "第二条" });
    src.appendSourceTurn(seqOnly, { role: "user", seq: 7, text: "第二条" });
    check(
      () => assert.equal(seqOnly.length, 2),
      "reused sequence keeps changed text while exact retry deduplicates",
    );

    // 11. the write path stores the source on the node
    const store = await import("../lib/store.js");
    const db = await store.openWorkspaceDb(join(root, "db"));
    const applied = extract.applyCandidates(
      db,
      [
        {
          type: "decision",
          name: "端口",
          text: "生产端口是 9443。",
          quote: "记住：生产端口是 9443。",
        },
      ],
      {
        sessionId: "s1",
        sourceTurns: [userTurn],
      },
    );
    const node = db.get(applied[0]?.id)?.payload || {};
    check(
      () => assert.equal(node.source?.messageId, userTurn.messageId),
      "the written node keeps the source message id",
    );
    check(
      () => assert.equal(node.source?.seq, 11),
      "the written node keeps the source sequence",
    );
    check(
      () => assert.equal(node.source?.role, "user"),
      "the written node keeps the source role",
    );
    check(
      () => assert.equal(node.source?.quoteMatch, "exact"),
      "the written node keeps the quote match result",
    );

    // 12. replay from pending keeps the original source time, not the replay time
    const replayTurns = extract.loadPending(cwd).turns;
    const replayed = await extract.distill({
      db,
      turns: replayTurns,
      sessionId: "s1",
      llmCall: async () =>
        JSON.stringify({
          candidates: [
            {
              type: "decision",
              name: "重放端口",
              text: "生产端口是 9443。",
              quote: "记住：生产端口是 9443。",
            },
          ],
        }),
    });
    const replayedNode = db.get(replayed.applied[0]?.id)?.payload || {};
    check(
      () => assert.equal(replayedNode.source?.at, userTurn.at),
      "replay keeps the original source time",
    );
    check(
      () => assert.equal(replayedNode.source?.messageId, userTurn.messageId),
      "replay keeps the original message id",
    );
    check(
      () =>
        assert.notEqual(
          replayedNode.source?.capturedAt,
          replayedNode.source?.at,
        ),
      "replay time and source time are separate fields",
    );

    // 13. the read projection separates "recorded", "locator known" and "host text"
    const prov = await import("../lib/provenance.js");
    const fresh = prov.provenanceOf(db, applied[0].id);
    check(
      () => assert.equal(fresh.locatorKnown, true),
      "a fresh node reports a known locator",
    );
    check(
      () => assert.equal(fresh.source.role, "user"),
      "the projection reports the source role",
    );
    check(
      () => assert.equal(fresh.source.quoteMatch, "exact"),
      "the projection reports the quote match",
    );
    check(
      () => assert.equal(fresh.source.hostText, "unavailable"),
      "the projection admits the host text cannot be re-read",
    );

    const legacyNode = store.insertNode(db, {
      type: "decision",
      name: "旧条目",
      text: "没有来源。",
    });
    const legacyProv = prov.provenanceOf(db, legacyNode);
    check(
      () => assert.equal(legacyProv.status, "missing"),
      "a node without a source reports missing",
    );
    check(
      () => assert.equal(legacyProv.source, null),
      "a missing source is null, not fabricated",
    );

    const quoteOnly = store.insertNode(db, {
      type: "decision",
      name: "只有摘录",
      text: "只有摘录。",
      source: {
        kind: "extract",
        via: "extract",
        sessionId: "s9",
        quote: "只有摘录。",
      },
    });
    const quoteOnlyProv = prov.provenanceOf(db, quoteOnly);
    check(
      () => assert.equal(quoteOnlyProv.locatorKnown, false),
      "a source without a locator says so",
    );
    check(
      () => assert.equal(quoteOnlyProv.source.quote, "只有摘录。"),
      "the quote is still displayed",
    );
    store.closeAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P50: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p66() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p66 — an empty extraction answer for a window that states a decision gets one
   * more question, and the outcome is visible either way.
   *
   * W8 live run (2026-11-02): the model answered {"candidates":[]} to
   * "这次上线按方案 A 走。" and again to "上一个方案不要了，走新的，用方案 B。", the
   * window was consumed as a success, and both decisions were lost silently.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p66-"));
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

  const turn = (text) => ({
    role: "user",
    text,
    seq: 1,
    messageId: "m-1",
    at: "2026-11-02T09:00:00.000Z",
    recorded: true,
  });
  const DECISION = "这次上线按方案 A 走。";

  /** A stub model that answers from a script and records every prompt it saw. */
  function scripted(answers) {
    const prompts = [];
    const call = async (prompt) => {
      prompts.push(prompt);
      const next = answers[Math.min(prompts.length - 1, answers.length - 1)];
      return typeof next === "function" ? next(prompt) : next;
    };
    return { call, prompts };
  }

  try {
    // 1. empty, then the fact: one extra question, and it is written
    {
      const db = await store.openWorkspaceDb(join(root, "ws-1"));
      const stub = scripted([
        JSON.stringify({ candidates: [] }),
        JSON.stringify({
          candidates: [
            {
              type: "decision",
              name: "上线方案",
              text: "按方案 A 走",
              quote: "这次上线按方案 A 走。",
            },
          ],
        }),
      ]);
      const out = await extract.distill({
        db,
        turns: [turn(DECISION)],
        sessionId: "s",
        llmCall: stub.call,
      });
      check(
        () => assert.equal(stub.prompts.length, 2),
        "the model is asked a second time",
      );
      check(
        () => assert.match(stub.prompts[1], /previous attempt/i),
        "the second question says why it is being asked",
      );
      check(
        () => assert.equal(out.applied.length, 1),
        "the decision is written after the retry",
      );
      check(
        () => assert.equal(out.emptySuspicious, false),
        "a recovered window is not reported as suspicious",
      );
      store.closeAll();
    }

    // 2. empty twice: bounded at two calls, and the loss is visible
    {
      const db = await store.openWorkspaceDb(join(root, "ws-2"));
      const stub = scripted([JSON.stringify({ candidates: [] })]);
      const out = await extract.distill({
        db,
        turns: [turn(DECISION)],
        sessionId: "s",
        llmCall: stub.call,
      });
      check(
        () => assert.equal(stub.prompts.length, 2),
        "the retry happens exactly once",
      );
      check(
        () => assert.equal(out.applied.length, 0),
        "nothing is written when the model insists",
      );
      check(
        () => assert.equal(out.emptySuspicious, true),
        "the suspicious empty window is reported",
      );
      store.closeAll();
    }

    // 3. an ordinary window is not re-asked: the gate stays cheap
    {
      const db = await store.openWorkspaceDb(join(root, "ws-3"));
      const stub = scripted([JSON.stringify({ candidates: [] })]);
      const out = await extract.distill({
        db,
        turns: [turn("今天天气不错，适合散步。")],
        sessionId: "s",
        llmCall: stub.call,
      });
      check(
        () => assert.equal(stub.prompts.length, 1),
        "a window with no decision is asked only once",
      );
      check(
        () => assert.equal(out.emptySuspicious, false),
        "and is not flagged",
      );
      store.closeAll();
    }

    // 4. a rule already wrote something, so an empty model answer is not suspicious
    {
      const db = await store.openWorkspaceDb(join(root, "ws-4"));
      const stub = scripted([JSON.stringify({ candidates: [] })]);
      const out = await extract.distill({
        db,
        turns: [turn("记住：以后都用 pnpm，别再用 npm。")],
        sessionId: "s",
        llmCall: stub.call,
      });
      const ruleWrote = out.ruleCount > 0 || out.applied.length > 0;
      check(
        () => assert.equal(ruleWrote, true),
        "the rule layer handled this window",
      );
      check(
        () => assert.equal(stub.prompts.length, 1),
        "no retry when a rule already found the fact",
      );
      store.closeAll();
    }

    // 5. a failed call (no text at all) is still a failure, not a suspicious empty
    {
      const db = await store.openWorkspaceDb(join(root, "ws-5"));
      const out = await extract.distill({
        db,
        turns: [turn(DECISION)],
        sessionId: "s",
        llmCall: async () => "",
      });
      check(
        () => assert.equal(out.llmFailed, true),
        "an empty answer is a failure so the window stays pending",
      );
      check(
        () => assert.equal(out.emptySuspicious, false),
        "a failure is not reported as a suspicious empty",
      );
      store.closeAll();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P66: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p100() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join, resolve } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "trivium-p100-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const store = await import("../lib/store.js");
  const extract = await import("../lib/extract.js");
  const source = await import("../lib/source-events.js");
  const NAME = "测试代号记忆";
  const BODY = "测试代号是 BLUE-OTTER-741";
  let count = 0, failures = 0, workspace = 0;
  const check = async (label, fn) => {
    count++;
    try { await fn(); console.log(`ok ${label}`); }
    catch (error) { failures++; console.error(`FAIL ${label}: ${error.stack || error}`); }
    finally { store.closeAll(); }
  };
  const open = async (payload = {}) => {
    const cwd = join(root, `ws-${++workspace}`);
    const db = await store.openWorkspaceDb(cwd);
    const id = store.insertNode(db, { type: "preference", name: NAME, text: BODY, ...payload });
    return { db, cwd, id };
  };
  const user = (text, seq = 11) => source.turnFromEvent({ type: "user/message", seq, time: 1794820542000,
    data: { id: `user-${seq}`, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] } });
  const tool = (name, text, seq = 24, isError = false) => source.turnFromEvent({ type: "tool/result", seq, time: 1794820543000,
    data: { turn: 1, step: 1, message: { id: `tool-${seq}`, role: "tool", source: { kind: "tool", callId: `call-${seq}` },
      isError, content: [{ type: "text", text }] } } }, { name });
  const find = (id, text = BODY, type = "preference") => tool("ctx_find", `[4.000] id=${id} type=${type}\n${text}`);
  const read = (id, payload = { type: "preference", name: NAME, text: BODY, status: "active" }) =>
    tool("ctx_read", JSON.stringify({ id, payload, edges: [], incoming: [] }), 30);
  const answer = (text = BODY) => ({ role: "assistant", text: `已查到：${text}`, seq: 34, messageId: "assistant-34" });
  const question = () => user(`在本测试工作区，请调用 ctx_find 查找“${NAME}”，准确告诉我记忆里的测试代号。`);
  const echo = (overrides = {}) => ({ type: "entity", name: NAME, text: BODY, quote: BODY, ...overrides });
  const run = async (db, turns, candidates) => {
    let prompt = "";
    const result = await extract.distill({ db, turns, sessionId: "synthetic-session", llmCall: async value => {
      prompt = value; return JSON.stringify({ candidates });
    } });
    return { ...result, prompt };
  };
  const graph = db => JSON.stringify(db.allNodeIds().sort((a, b) => a - b).map(id => db.get(id)));
  const has = (db, type, text) => db.allNodeIds().some(id => {
    const p = db.get(id)?.payload; return p?.type === type && p?.text === text;
  });

  try {
    await check("real host ctx_find echo cannot create a cross-type copy or touch the existing graph", async () => {
      const { db, id } = await open();
      const before = graph(db);
      const result = await run(db, [question(), find(id), answer()], [echo()]);
      assert.equal(result.llmFailed, false);
      assert.equal(result.applied.length, 0);
      assert.ok(result.skipped.some(row => row.reason === "memory-read-echo"));
      assert.equal(graph(db), before);
      assert.match(result.prompt, /ctx_find/);
    });
    await check("ctx_read echo is recognised even when the model omits a quote", async () => {
      const { db, id } = await open();
      const before = graph(db);
      const result = await run(db, [question(), read(id), answer()], [echo({ quote: "" })]);
      assert.equal(result.applied.length, 0);
      assert.equal(graph(db), before);
    });
    await check("multiple find results bind each body to the correct node id", async () => {
      const { db, id } = await open();
      const other = store.insertNode(db, { type: "preference", name: "other", text: "Other distinct fact." });
      const turns = [question(), tool("ctx_find", `[8.000] id=${other} type=preference\nOther distinct fact.\n\n[4.000] id=${id} type=preference\n${BODY}`), answer()];
      const before = graph(db);
      const result = await run(db, turns, [echo()]);
      assert.equal(result.applied.length, 0);
      assert.equal(graph(db), before);
    });
    await check("a recalled fact and a new user decision in the same window are handled separately", async () => {
      const { db, id } = await open();
      const newText = "决定发布窗口调整为周四。";
      const turns = [user(`请查询“${NAME}”。${newText}`), find(id), answer()];
      const result = await run(db, turns, [echo(), { type: "decision", name: "发布窗口", text: newText, quote: newText }]);
      assert.ok(result.skipped.some(row => row.reason === "memory-read-echo"));
      assert.equal(has(db, "entity", BODY), false);
      assert.equal(has(db, "decision", newText), true);
      assert.equal(db.get(id).payload.text, BODY);
    });
    await check("the user explicitly states the same fact: it is not discarded as a tool echo", async () => {
      const { db, id } = await open();
      const turns = [user(`记住：${BODY}。`), find(id), answer()];
      const result = await run(db, turns, [echo()]);
      assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
      assert.equal(has(db, "entity", BODY), true);
    });
    await check("the user explicitly asks to create an entity from the read fact", async () => {
      const { db, id } = await open();
      const turns = [user(`请查找“${NAME}”，并将这条记忆创建为实体。`), find(id), answer()];
      const result = await run(db, turns, [echo()]);
      assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
      assert.equal(has(db, "entity", BODY), true);
    });
    await check("matching information from an unrelated tool remains independent evidence", async () => {
      const { db, id } = await open();
      const turns = [question(), find(id), tool("read_file", BODY, 31), answer()];
      const result = await run(db, turns, [echo()]);
      assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
      assert.equal(has(db, "entity", BODY), true);
    });
    await check("a changed number is a new fact, not an echo", async () => {
      const { db, id } = await open();
      const next = "测试代号是 BLUE-OTTER-742";
      const result = await run(db, [user(`新的值是：${next}`), find(id), answer(next)], [echo({ text: next, quote: next })]);
      assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
      assert.equal(has(db, "entity", next), true);
      assert.equal(db.get(id).payload.text, BODY);
    });
    await check("a candidate with a new relation is retained", async () => {
      const { db, id } = await open();
      const result = await run(db, [question(), find(id), answer()], [echo({ linkName: "ReleaseGateway" })]);
      assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
      assert.ok(result.unverified.some(row => row.text === BODY && row.linkName === 'ReleaseGateway'));
    });
    await check("unknown legacy tool names and failed reads are never assumed to be memory echoes", async () => {
      for (const turn of [tool("tool", `[4.000] id=2 type=preference ${BODY}`), tool("ctx_find", `[4.000] id=2 type=preference ${BODY}`, 24, true)]) {
        const { db } = await open();
        const result = await run(db, [question(), turn, answer()], [echo()]);
        assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
        assert.ok(has(db, "entity", BODY) || result.unverified.some(row => row.text === BODY));
        store.closeAll();
      }
    });
    await check("archived or changed stored facts do not suppress a new candidate", async () => {
      for (const payload of [{ status: "archived" }, { text: "测试代号是 BLUE-OTTER-999" }]) {
        const { db, id } = await open(payload);
        const result = await run(db, [question(), find(id), answer()], [echo()]);
        assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
        assert.equal(has(db, "entity", BODY), true);
        store.closeAll();
      }
    });
    await check("echoes do not exhaust the batch budget before a genuinely new fact", async () => {
      const { db, id } = await open();
      const turns = [user(`请查询“${NAME}”。新服务端口是 9443。`), find(id)];
      const candidates = [echo()];
      for (let i = 0; i < 9; i++) {
        const name = `旧记录编号${i}`, text = `旧记录的测试值是编号${i}。`;
        const oldId = store.insertNode(db, { type: "preference", name, text });
        turns.push(tool("ctx_find", `[4.000] id=${oldId} type=preference\n${text}`, 40 + i));
        candidates.push(echo({ name, text, quote: text }));
      }
      const fresh = "新服务端口是 9443。";
      candidates.push({ type: "entity", name: "新服务", text: fresh, quote: fresh });
      turns.push(answer());
      const result = await run(db, turns, candidates);
      assert.equal(result.skipped.filter(row => row.reason === "memory-read-echo").length, 10);
      assert.equal(has(db, "entity", fresh), true);
      assert.equal(db.get(id).payload.text, BODY);
    });
    await check("changed whitespace and changed identifiers are never classed as exact echoes", async () => {
      for (const next of ["测试代号是  BLUE-OTTER-741", "测试代号是 BLUE-otter-741", "测试代号不是 BLUE-OTTER-741"]) {
        const { db, id } = await open();
        const result = await run(db, [question(), find(id), answer()], [echo({ text: next, quote: "" })]);
        assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
        assert.equal(db.get(id).payload.text, BODY);
        store.closeAll();
      }
    });
    await check("an explicit request to classify the retrieved fact is retained across clauses", async () => {
      for (const request of ["把它归类为实体。", "请将该内容存为一个实体。", "把上一条当作一个实体。", "将上面内容单独建一项记忆。", "Classify it as an entity.", "Make this an entity."]) {
        const { db, id } = await open();
        const result = await run(db, [user(`请查找“${NAME}”。${request}`), find(id), answer()], [echo()]);
        assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
        assert.equal(has(db, "entity", BODY), true);
        store.closeAll();
      }
    });
    await check("a mismatched node id, type or incomplete read cannot prove an echo", async () => {
      for (const mode of ["id", "type", "truncated"]) {
        const { db, id } = await open();
        const wrongId = store.insertNode(db, { type: "preference", name: "另一条", text: "另一条内容。" });
        const observed = mode === "id" ? find(wrongId) : mode === "type" ? find(id, BODY, "entity")
          : tool("ctx_read", `{"id":${id},"payload":{"type":"preference","name":"${NAME}","text":"测试代号是`);
        const result = await run(db, [question(), observed, answer()], [echo()]);
        assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
        assert.ok(has(db, "entity", BODY) || result.unverified.some(row => row.text === BODY));
        assert.equal(db.get(id).payload.text, BODY);
        store.closeAll();
      }
    });
    await check("reviewed or time-bounded memories are left to the normal write path", async () => {
      for (const payload of [{ review: true }, { until: "2099-01-01" }]) {
        const { db, id } = await open(payload);
        const result = await run(db, [question(), find(id), answer()], [echo()]);
        assert.equal(result.skipped.some(row => row.reason === "memory-read-echo"), false);
        assert.equal(has(db, "entity", BODY), true);
        store.closeAll();
      }
    });
    await check("pending replay retains tool identity and applies the same echo guard", async () => {
      const { db, id, cwd } = await open();
      const turns = [question(), find(id), answer()];
      await extract.savePending(cwd, { sessionId: "synthetic-session", turns });
      const replayed = extract.loadPending(cwd).turns;
      assert.equal(replayed.find(t => t.role === "tool")?.name, "ctx_find");
      const before = graph(db);
      const result = await run(db, replayed, [echo()]);
      assert.equal(result.applied.length, 0);
      assert.equal(graph(db), before);
    });
  } finally {
    store.closeAll();
    if (dirname(resolve(root)) !== resolve(tmpdir())) throw new Error("Refusing cleanup outside temp directory");
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P100: ${count - failures}/${count}`);
  if (failures) process.exitCode = 1;
}

async function p103() {
  const assert = (await import('node:assert/strict')).default;
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'trivium-source-'));
  process.env.DSH_HOME = join(root, 'home');
  process.env.DSH_TRIVIUM_SETTINGS = join(root, 'settings.json');
  const store = await import('../lib/store.js');
  const extract = await import('../lib/extract.js');
  const source = await import('../lib/source-events.js');
  try {
    const cwd = join(root, 'ws'), db = await store.openWorkspaceDb(cwd);
    const turns = [{ role: 'user', text: '导出格式是什么？', seq: 11, recorded: true, messageId: 'm1' }];
    const candidate = { type: 'decision', name: '导出格式', text: '导出格式固定为 XLSX。' };
    const run = (input, item = candidate) => extract.distill({ db, turns: input, sessionId: 'proof', llmCall: async () => JSON.stringify({ candidates: [item] }) });
    const pending = await run(turns);
    assert.equal(pending.applied.length, 0);
    assert.equal(pending.unverified.length, 1);
    assert.equal(extract.extractOutcome(pending).consume, false);
    await extract.savePending(cwd, { sessionId: 'proof', turns, unverified: pending.unverified, error: 'source-unverified' });
    await extract.savePending(cwd, { sessionId: 'proof', turns });
    assert.equal(extract.loadPending(cwd).unverified[0].text, candidate.text);
    assert.equal(extract.pendingSummary(cwd).windows[0].unverified.length, 1);
    const held = extract.loadPending(cwd).unverified;
    const recheck = input => extract.distill({ db, turns: input, sessionId: 'proof', heldCandidates: held, llmCall: async () => '{"candidates":[]}' });
    const silentReplay = await recheck(turns);
    assert.equal(silentReplay.unverified[0].text, candidate.text, 'empty model output must not lose a held candidate');
    await extract.savePending(cwd, { sessionId: 'proof', turns, unverified: silentReplay.unverified, sourceReviewKey: extract.sourceReviewKey(turns) });
    assert.equal(extract.pendingNeedsExtraction(extract.loadPending(cwd)), false, 'unchanged review must not request paid retries');
    const newTurns = [...turns, { role: 'user', text: '确认：导出格式固定为 XLSX。', seq: 12 }];
    await extract.savePending(cwd, { sessionId: 'proof', turns: newTurns });
    assert.equal(extract.pendingNeedsExtraction(extract.loadPending(cwd)), true, 'new source must reopen review');
    const confirmed = await recheck(newTurns);
    assert.equal(confirmed.unverified.length, 0);
    assert.equal(confirmed.applied.length, 1);
    assert.equal(extract.extractOutcome(confirmed).consume, true);
    assert.equal(source.candidateEvidence({ text: '超时是 45 秒。', quote: '超时是 30 秒。' }, [{ role: 'user', text: '超时是 30 秒。' }]).supported, false);
    assert.equal(source.candidateEvidence({ text: '负责人是张三。', quote: '负责人是谁' }, [{ role: 'user', text: '负责人是谁？' }]).supported, false);
    for (const [text, evidence] of [
      ['支持导出。', '不支持导出。'], ['允许写入。', '未允许写入。'],
      ['超时是 45 秒。', '超时是 45 秒吗？'], ['超时是 45 秒。', '如果超时是 45 秒会怎样？'],
      ['李四管理张三。', '张三管理李四。'], ['超时是 ４５ 秒。', '超时是 ３０ 秒。'],
      ['实例 B 的超时是 45 秒。', '实例 A 的超时是 45 秒。实例 B 的超时是 30 秒。'],
    ]) assert.equal(source.candidateEvidence({ text }, [{ role: 'user', text: evidence }]).supported, false, evidence);
    const transformed = await run([{ role: 'user', text: '保留十四日。' }], { type: 'decision', name: '留存', text: 'Retention is fourteen days.' });
    assert.equal(transformed.unverified.length, 1, 'unknown paraphrase must be retained, not silently dropped');
    const secret = await run(turns, { type: 'decision', text: 'sk-' + 'a'.repeat(40) });
    assert.equal(secret.unverified.length, 0);
    assert.ok(secret.skipped.some(row => row.reason === 'secret'));
    // Exercise the real registered host entry, queue selection and scheduler.
    const { apply } = await import('../lib/index.js');
    const handlers = new Map();
    let calls = 0, candidates = [candidate];
    const ctx = {
      llm: { async *stream() { calls++; yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidates }) }; } },
      logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
      inject(_deps, fn) { fn(ctx); }, on(name, fn) { handlers.set(name, fn); return () => {}; },
      effect(fn) { fn(); }, tools: { register() {} }, webServer: { register() {} },
    };
    apply(ctx, {});
    const hostCwd = join(root, 'host');
    const hostDb = await store.openWorkspaceDb(hostCwd);
    const start = id => handlers.get('agent/created')({ agent: {
      session: { id, header: { cwd: hostCwd }, requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }) }, inject() {},
    } });
    await extract.savePending(hostCwd, { sessionId: 'held', turns });
    await start('first');
    assert.equal(calls, 1);
    assert.equal(extract.loadPending(hostCwd).unverified[0].text, candidate.text);
    await start('second');
    assert.equal(calls, 1, 'session restart paid for unchanged source review');
    candidates = [{ type: 'decision', name: '负责人', text: '负责人是张三。' }];
    await extract.savePending(hostCwd, { sessionId: 'other', turns: [{ role: 'user', text: '负责人是张三。', seq: 21 }] });
    await start('third');
    assert.equal(calls, 2, 'source review blocked a later independent window');
    assert.ok(hostDb.allNodeIds().some(id => hostDb.getPayload(id).text === '负责人是张三。'));
    assert.equal(extract.loadPendingWindows(hostCwd).length, 1);
    candidates = [];
    await extract.savePending(hostCwd, { sessionId: 'held', turns: [...turns, { role: 'user', text: '确认：导出格式固定为 XLSX。', seq: 12 }] });
    await start('fourth');
    assert.ok(hostDb.allNodeIds().some(id => hostDb.getPayload(id).text === candidate.text));
    assert.equal(extract.loadPendingWindows(hostCwd).length, 0, 'confirmed candidate left a ghost pending window');
    console.log('P103: source-less writes stay pending, survive persistence, and accept later evidence; invented literals and secrets are refused');
  } finally { store.closeAll(); rmSync(root, { recursive: true, force: true }); }
}
