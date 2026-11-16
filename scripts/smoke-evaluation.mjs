/** evaluation: independent historical regression cases. Run with npm test -- evaluation.
 * Each function runs in its own process through run-all; settings and modules never leak. */

export const cases = Object.freeze({ p33, p39 });

async function p33() {
  const { default: assert } = await import("node:assert/strict");
  const { grade, scenarios } = await import("./quality-fixtures.mjs");
  const { scoreExtraction } = await import("./extraction-rubric.mjs");
  /**
   * Scoring rubrics: the offline quality fixtures (p33) and the extraction rubric
   * (p40, merged here 2026-11-11 to stay under the scripts/ cap).
   *
   * Both answer the same question — "does this answer count as correct?" — so they
   * share a file. Nothing was dropped: each block keeps its own assertions.
   */

  /* ---- quality fixtures: gold, negation, generic, missing/extra fields ---- */
  const cases = scenarios();
  for (const sc of cases)
    assert.equal(grade(JSON.stringify(sc.gold), sc.gold).pass, true, sc.id);
  const s02 = cases.find((sc) => sc.id === "S02"),
    s07 = cases.find((sc) => sc.id === "S07"),
    s10 = cases.find((sc) => sc.id === "S10");
  for (const answer of [
    "教程与实际演示并非都可以，仍然只推教程",
    JSON.stringify({ ...s02.gold, old_allowed: true }),
    JSON.stringify({ ...s02.gold, contradiction: "旧标签仍生效" }),
  ])
    assert.equal(grade(answer, s02.gold).pass, false);
  for (const answer of [
    "建议先跑基线",
    '{"codes":["基线"]}',
    JSON.stringify({ codes: s07.gold.codes.slice(0, 5) }),
    JSON.stringify({ codes: [...s07.gold.codes, s07.gold.codes[0]] }),
  ])
    assert.equal(grade(answer, s07.gold).pass, false);
  assert.equal(grade('{"reason":"增量失效"}', s10.gold).pass, false);
  assert.equal(
    grade(JSON.stringify({ codes: s07.gold.codes.toReversed() }), s07.gold)
      .pass,
    true,
  );
  assert.equal(grade("null", { owner: null }).pass, false);
  assert.equal(grade('{"owner":"不知道"}', { owner: null }).pass, false);
  assert.equal(grade('{"owner":null}', { owner: null }).pass, true);
  console.log(
    "P33 rubric passed: all gold, negation, generic answer, missing/extra/duplicate fields, unknown and order-independent set",
  );

  /* ---- extraction rubric: body-only, subject/value/polarity/time ---- */
  const facts = ["重试次数上限为 3 次。", "生产端口是 9443。"];
  const row = (text) => ({ type: "decision", text });
  assert.equal(scoreExtraction(facts.map(row), facts).pass, true);
  assert.equal(scoreExtraction([row(facts.join(""))], facts).pass, true);
  for (const c of [
    row("重试次数上限为 30 次。"),
    row("重试次数上限不是 3 次。"),
    row("测试端口是 9443。"),
    row("生产端口曾是 9443，现在是 8443。"),
    { ...row("未知"), quote: facts.join(""), name: "3 / 9443" },
  ]) {
    assert.equal(scoreExtraction([c], facts).pass, false);
  }
  assert.equal(
    scoreExtraction([row("重试最多三次。")], [facts[0]]).needsSemanticReview,
    true,
  );
  assert.equal(
    scoreExtraction([row(facts[0]), row(facts[0])], [facts[0]]).duplicates
      .length,
    1,
  );
  assert.equal(scoreExtraction([row(facts[0])], facts).missing.length, 1);
  assert.equal(
    scoreExtraction([row(facts.join("")), row("额外臆测")], facts).pass,
    false,
  );
  console.log(
    "P40 extraction rubric passed: body-only, whole facts, subject/value/polarity/time, missing, duplicate, extra and manual-review cases",
  );
}

async function p39() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { cellIdentity, prepareCell, assertInside, fixtureReceipt } =
    await import("./experiment-support.mjs");
  const { createModelLedger, validUsage } = await import("./model-ledger.mjs");
  const root = mkdtempSync(join(tmpdir(), "trivium-r2-"));
  try {
    assert.equal(
      validUsage({
        prompt_tokens: 1,
        completion_tokens: 1,
        prompt_cache_hit_tokens: 2,
      }),
      false,
    );
    assert.equal(validUsage({ prompt_tokens: 1 }), false);
    const paths = [
      "trivium-inject",
      "trivium-tools",
      "goodmemory-256",
      "goodmemory-300",
      "dsmmemory-800",
      "dsmmemory-800-min0",
    ].flatMap((a) =>
      [0, 1].flatMap((r) =>
        ["S01", "S07"].map((s) => cellIdentity(root, a, r, s)),
      ),
    );
    assert.equal(new Set(paths.map((x) => x.cell)).size, 24);
    assert.equal(new Set(paths.map((x) => x.sessionId)).size, 24);
    prepareCell(root, "a", 0, "S01");
    assert.throws(() => prepareCell(root, "a", 0, "S01"));
    assert.throws(() => assertInside(root, root + "-escape"));
    assert.throws(() => cellIdentity(root, "../escape", 0, "S01"));
    const f = [{ text: "事实甲" }, { text: "事实乙" }];
    assert.equal(fixtureReceipt(f, ["事实乙", "事实甲"]).count, 2);
    assert.throws(() => fixtureReceipt(f, ["事实甲", "事实甲"]));
    for (const mode of ["success", "missing", "http", "timeout", "price"]) {
      const report = { calls: [] };
      let network = 0,
        savedBefore = false;
      const req = createModelLedger({
        report,
        save: () => {},
        budget: 1,
        model: "deepseek-flash",
        fetchImpl: async () => {
          network++;
          savedBefore =
            report.calls[0].state === "reserved" &&
            report.reservedOrChargedCny > 0;
          if (mode === "timeout") throw Error("timeout");
          return {
            ok: mode !== "http",
            status: 500,
            json: async () => ({
              model: mode === "price" ? "unknown" : "deepseek-flash",
              usage:
                mode === "missing"
                  ? undefined
                  : { prompt_tokens: 100, completion_tokens: 4 },
              choices: [{ message: { content: "{}" } }],
            }),
          };
        },
      });
      const body = { model: "deepseek-flash", messages: [], max_tokens: 400 };
      if (mode === "success") {
        await req(body, "a");
        assert.equal(report.calls[0].state, "complete");
      } else {
        await assert.rejects(req(body, "a"));
        assert.equal(report.reservedOrChargedCny, report.calls[0].reservedCny);
        await assert.rejects(req(body, "b"));
        assert.equal(network, 1);
      }
      assert.equal(savedBefore, true);
    }
    let called = false;
    const noBudget = createModelLedger({
      report: {},
      save: () => {},
      budget: 0.00001,
      model: "deepseek-flash",
      fetchImpl: async () => {
        called = true;
      },
    });
    await assert.rejects(
      noBudget({ model: "deepseek-flash", messages: [], max_tokens: 600 }, "x"),
    );
    assert.equal(called, false);
    console.log(
      "P39 passed: isolated identities, fixture checks, pre-request reservation, failure latch, unknown usage/price and budget stop",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
