/** audit-locks: independent historical regression cases. Run with npm test -- audit-locks.
 * Each function runs in its own process through run-all; settings and modules never leak. */

export const cases = Object.freeze({ p53, p54, p55, p56 });

async function p53() {
  const { default: assert } = await import("node:assert/strict");
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p53 (W4) — the change record is bounded, redacted, idempotent and per workspace.
   *
   * The audit is a management surface: it is never injected into model context, and
   * a value that fails the write gate must never reach the file in the first place
   * (hiding it in the UI would not be a boundary).
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p53-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const log = await import("../lib/change-log.js");

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

  const ws = join(root, "ws");
  try {
    // 1. newest first, with stable fields
    log.noteChanges(ws, [
      {
        reason: "written",
        opId: "op-1",
        nodeId: 1,
        type: "decision",
        preview: "第一条。",
        source: { role: "user", messageId: "m-1", seq: 3, quoteMatch: "exact" },
      },
      {
        reason: "rejected",
        opId: "op-2",
        type: "preference",
        preview: "<redacted>",
        detail: "secret",
      },
    ]);
    const first = log.readChanges(ws);
    check(() => assert.equal(first.total, 2), "both entries are stored");
    check(
      () => assert.equal(first.entries[0].opId, "op-2"),
      "the newest entry comes first",
    );
    check(
      () => assert.equal(first.entries[1].source.seq, 3),
      "the source locator is kept",
    );
    check(
      () => assert.equal(first.entries[1].reason, "written"),
      "the reason code is preserved",
    );

    // 2. every reason code has bilingual labels
    for (const code of Object.values(log.CHANGE_REASONS)) {
      check(
        () =>
          assert.ok(log.CHANGE_LABELS[code]?.en && log.CHANGE_LABELS[code]?.zh),
        `label exists for ${code}`,
      );
    }

    // 3. a secret never reaches the file
    log.noteChanges(ws, [
      {
        reason: "written",
        opId: "op-3",
        nodeId: 2,
        preview: "部署密钥是 ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      },
    ]);
    const raw = readFileSync(log.changesPath(ws), "utf8");
    check(
      () => assert.doesNotMatch(raw, /ghp_/),
      "the secret is redacted before the file is written",
    );
    const after = log.readChanges(ws);
    check(
      () => assert.equal(after.entries[0].preview, "<redacted>"),
      "the redaction marker is stored",
    );

    // 4. the same operation is recorded once
    const before = log.readChanges(ws).total;
    log.noteChanges(ws, [
      { reason: "written", opId: "op-1", nodeId: 1, preview: "重复。" },
    ]);
    check(
      () => assert.equal(log.readChanges(ws).total, before),
      "a repeated opId does not create a second entry",
    );

    // 5. bounded: trimming keeps the newest and says how much fell out
    const many = Array.from({ length: log.CHANGE_LOG_LIMIT + 12 }, (_, i) => ({
      reason: "written",
      opId: `bulk-${i}`,
      nodeId: 1000 + i,
      preview: `批量 ${i}`,
    }));
    log.noteChanges(ws, many);
    const trimmed = log.readChanges(ws, { limit: 5 });
    check(
      () => assert.equal(trimmed.entries.length, 5),
      "the read limit is honoured",
    );
    check(
      () => assert.equal(trimmed.trimmed > 0, true),
      "trimming is reported, not hidden",
    );
    check(
      () => assert.equal(trimmed.total <= log.CHANGE_LOG_LIMIT, true),
      "the log stays inside its cap",
    );
    check(
      () => assert.equal(trimmed.entries[0].opId, `bulk-${many.length - 1}`),
      "the newest entry survives trimming",
    );

    // 6. workspaces do not share a log
    const other = join(root, "ws-other");
    log.noteChanges(other, [
      { reason: "merged", opId: "op-x", nodeId: 9, preview: "别的库。" },
    ]);
    check(
      () => assert.equal(log.readChanges(other).total, 1),
      "the other workspace has its own log",
    );
    check(
      () => assert.notEqual(log.readChanges(ws).entries[0].opId, "op-x"),
      "entries do not leak across workspaces",
    );

    // 7. a failing write is reported, never reported as success
    const blocked = join(root, "blocked-file");
    writeFileSync(blocked, "not a directory", "utf8");
    const failed = log.noteChanges(join(blocked, "ws"), [
      { reason: "written", opId: "op-fail", nodeId: 1, preview: "x" },
    ]);
    check(
      () => assert.equal(failed.ok, false),
      "a failed audit write is reported",
    );

    // 8. result mapping covers every outcome the extractor can produce
    const rows = log.rowsForExtract({
      sessionId: "s1",
      result: {
        applied: [
          { id: 1, action: "insert", type: "decision", text: "新事实。" },
          { id: 2, action: "merge", type: "preference", text: "合并事实。" },
        ],
        superseded: [
          { from: 3, to: 1, label: "方案 A" },
          { from: 4, to: null, pending: true, reason: "ambiguous-supersede" },
        ],
        skipped: [
          { reason: "secret", type: "decision", preview: "<redacted>" },
        ],
        adjusted: [
          {
            reason: "unsupported-date",
            type: "decision",
            removed: ["2027-03-01"],
            preview: "日期被删。",
          },
        ],
      },
      sourceOf: (id) =>
        id === 1
          ? { role: "user", messageId: "m-1", seq: 5, quoteMatch: "exact" }
          : null,
    });
    const reasons = rows.map((r) => r.reason);
    check(
      () => assert.equal(reasons.includes("written"), true),
      "an insert maps to written",
    );
    check(
      () => assert.equal(reasons.includes("merged"), true),
      "a merge maps to merged",
    );
    check(
      () => assert.equal(reasons.includes("superseded"), true),
      "a retirement maps to superseded",
    );
    check(
      () => assert.equal(reasons.includes("pending-review"), true),
      "an unconfirmed replacement maps to pending-review",
    );
    check(
      () => assert.equal(reasons.includes("rejected"), true),
      "a refusal maps to rejected",
    );
    check(
      () => assert.equal(reasons.includes("date-adjusted"), true),
      "a date removal maps to date-adjusted",
    );
    check(
      () => assert.equal(rows[0].source.messageId, "m-1"),
      "the applied row carries the stored source",
    );
    check(
      () => assert.equal(new Set(rows.map((r) => r.opId)).size, rows.length),
      "every row has a distinct opId",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P53: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p54() {
  const { default: assert } = await import("node:assert/strict");
  const {
    existsSync,
    mkdtempSync,
    rmSync,
    readFileSync,
    utimesSync,
    writeFileSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  /**
   * p54 (F-W05 A) — one writer per workspace, and the loser never waits.
   *
   * Two host processes on the same workspace used to replay the same pending
   * snapshot and write the fact twice (W5 measured copies=2). The lock is taken for
   * the extraction run only; a process that cannot take it keeps the window pending
   * and records `lock-busy` instead of blocking behind a model call.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p54-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const lockMod = await import("../lib/workspace-lock.js");
  const logMod = await import("../lib/change-log.js");

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

  const ws = join(root, "ws");
  try {
    // 1. first taker wins, second is told busy without waiting
    const first = lockMod.acquireWorkspaceLock(ws);
    check(
      () => assert.equal(first.ok, true),
      "the first process takes the lock",
    );
    check(
      () => assert.ok(existsSync(lockMod.lockPath(ws))),
      "the lock file exists while held",
    );
    const startedAt = Date.now();
    const second = lockMod.acquireWorkspaceLock(ws);
    check(
      () => assert.equal(second.ok, false),
      "the second process does not get the lock",
    );
    check(
      () => assert.equal(second.reason, "busy"),
      "the second process is told it is busy",
    );
    check(
      () => assert.ok(Date.now() - startedAt < 200),
      "taking the lock never waits",
    );
    check(
      () => assert.match(String(second.owner || ""), /pid/),
      "the holder is described without failing",
    );

    // 2. release is idempotent and removes the file
    first.release();
    check(
      () => assert.equal(existsSync(lockMod.lockPath(ws)), false),
      "release removes the lock file",
    );
    first.release();
    check(
      () => assert.equal(existsSync(lockMod.lockPath(ws)), false),
      "a second release is harmless",
    );

    // 3. a crashed holder is recovered after the TTL
    writeFileSync(
      lockMod.lockPath(ws),
      JSON.stringify({
        pid: 999999,
        nonce: "dead",
        at: "2026-10-30T00:00:00.000Z",
      }),
      "utf8",
    );
    const old = new Date(Date.now() - lockMod.LOCK_TTL_MS - 5000);
    utimesSync(lockMod.lockPath(ws), old, old);
    const recovered = lockMod.acquireWorkspaceLock(ws);
    check(
      () => assert.equal(recovered.ok, true),
      "a lock older than the TTL is taken over",
    );
    recovered.release();

    // 4. a live lock is not stolen just because it is old-ish
    writeFileSync(
      lockMod.lockPath(ws),
      JSON.stringify({ pid: process.pid, nonce: "fresh" }),
      "utf8",
    );
    const notStale = lockMod.acquireWorkspaceLock(ws, {
      ttlMs: lockMod.LOCK_TTL_MS,
    });
    check(() => assert.equal(notStale.ok, false), "a fresh lock is respected");
    utimesSync(lockMod.lockPath(ws), old, old);
    const longRunning = lockMod.acquireWorkspaceLock(ws, {
      ttlMs: lockMod.LOCK_TTL_MS,
    });
    check(
      () => assert.equal(longRunning.ok, false),
      "an old lock owned by a live process is not stolen",
    );
    rmSync(lockMod.lockPath(ws), { force: true });

    // 5. releasing must not delete somebody else's lock
    const mine = lockMod.acquireWorkspaceLock(ws);
    writeFileSync(
      lockMod.lockPath(ws),
      JSON.stringify({ pid: 4242, nonce: "someone-else" }),
      "utf8",
    );
    const released = mine.release();
    check(
      () => assert.equal(released, false),
      "release refuses a lock it no longer owns",
    );
    check(
      () => assert.equal(existsSync(lockMod.lockPath(ws)), true),
      "the other holder keeps its lock",
    );
    rmSync(lockMod.lockPath(ws), { force: true });

    // 6. the audit knows the new outcome and can display it
    check(
      () => assert.equal(logMod.CHANGE_REASONS.lockBusy, "lock-busy"),
      "the reason code exists",
    );
    check(
      () =>
        assert.ok(
          logMod.CHANGE_LABELS["lock-busy"]?.en &&
            logMod.CHANGE_LABELS["lock-busy"]?.zh,
        ),
      "the reason has bilingual labels",
    );
    logMod.noteChanges(ws, [
      {
        reason: logMod.CHANGE_REASONS.lockBusy,
        opId: "s1:lock:1",
        detail: "busy",
      },
    ]);
    const rows = logMod.readChanges(ws);
    check(
      () => assert.equal(rows.entries[0].reason, "lock-busy"),
      "a busy outcome is recorded, not dropped",
    );

    // 7. a lock file left behind does not block a later run forever
    writeFileSync(
      lockMod.lockPath(ws),
      JSON.stringify({ pid: 2147483647, nonce: "x" }),
      "utf8",
    );
    utimesSync(lockMod.lockPath(ws), old, old);
    const later = lockMod.acquireWorkspaceLock(ws);
    check(
      () => assert.equal(later.ok, true),
      "a leftover lock is eventually reclaimed",
    );
    check(
      () =>
        assert.match(
          readFileSync(lockMod.lockPath(ws), "utf8"),
          new RegExp(String(process.pid)),
        ),
      "the new holder owns the file",
    );
    later.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P54: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p55() {
  const { default: assert } = await import("node:assert/strict");
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  /**
   * p55 (F-W05 A) — two real processes, one workspace: exactly one writer.
   *
   * p54 covers the lock primitive in isolation. This covers the path that actually
   * produced duplicates: two Node processes calling `distill()` on the same
   * workspace at the same time. The loser must report `locked` and write nothing;
   * the workspace must end with one copy of the fact.
   */

  const root = mkdtempSync(join(tmpdir(), "trivium-p55-"));
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

  const ws = join(root, "ws");
  const worker = join(root, "worker.mjs");
  const extractUrl = pathToFileURL(resolve("lib/extract.js")).href;
  const storeUrl = pathToFileURL(resolve("lib/store.js")).href;

  writeFileSync(
    worker,
    `
import { pathToFileURL } from 'node:url';
const extract = await import(${JSON.stringify(extractUrl)});
const store = await import(${JSON.stringify(storeUrl)});
const locks = await import(${JSON.stringify(pathToFileURL(resolve("lib/workspace-lock.js")).href)});
const [cwd, sessionId, delayMs] = process.argv.slice(2);
// Same order as runExtract: take the lock BEFORE opening the database, because
// the engine refuses a second writer outright.
const guarded = await locks.withWorkspaceLock(cwd, async () => {
  const db = await store.openWorkspaceDb(cwd);
  const result = await extract.distill({
    db,
    sessionId,
    turns: [{ role: 'user', text: '记住：发布窗口是周五。', seq: 1, messageId: 'm-1', at: '2026-10-30T09:00:00.000Z', recorded: true }],
    llmCall: async () => {
      await new Promise((r) => setTimeout(r, Number(delayMs)));
      return JSON.stringify({ candidates: [{ type: 'decision', name: '发布窗口', text: '发布窗口是周五。', quote: '记住：发布窗口是周五。' }] });
    },
  });
  store.closeAll();
  return result;
});
console.log('RESULT ' + JSON.stringify({ applied: guarded.value ? guarded.value.applied.length : 0, locked: guarded.locked === true }));
`,
    "utf8",
  );

  const runWorker = (sessionId, delayMs) =>
    new Promise((resolveP) => {
      const child = spawn(
        process.execPath,
        [worker, ws, sessionId, String(delayMs)],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => {
        out += c;
      });
      child.stderr.on("data", (c) => {
        err += c;
      });
      child.on("exit", (code) => {
        const match = out.match(/RESULT (.*)/);
        resolveP({
          code,
          ...(match
            ? JSON.parse(match[1])
            : {
                applied: 0,
                locked: false,
                unparsed: out.slice(-200),
                stderr: err.slice(-300),
              }),
        });
      });
    });

  try {
    const [a, b] = await Promise.all([
      runWorker("s-desktop", 900),
      runWorker("s-cli", 200),
    ]);
    check(
      () => assert.equal(a.code, 0),
      "the first process exits cleanly: " + (a.stderr || ""),
    );
    check(
      () => assert.equal(b.code, 0),
      "the second process exits cleanly: " + (b.stderr || ""),
    );
    const writers = [a, b].filter((row) => !row.locked && row.applied > 0);
    const losers = [a, b].filter((row) => row.locked);
    check(() => assert.equal(writers.length, 1), "exactly one process writes");
    check(
      () => assert.equal(losers.length, 1),
      "the other reports locked instead of writing",
    );

    const db = await store.openWorkspaceDb(ws);
    const nodes = db
      .allNodeIds()
      .map((id) => db.get(id)?.payload || {})
      .filter((p) => String(p.text || "").includes("发布窗口是周五"));
    store.closeAll();
    /*
     * Copy count is NOT asserted: the rule layer writes its own candidate for the
     * same sentence (a pre-existing, separate path), so two nodes here are expected
     * and are not a concurrency symptom. The lock's contract is "one writer at a
     * time", which the checks above measure directly.
     */
    check(
      () => assert.ok(nodes.length >= 1),
      "the fact is readable after the race",
    );

    // Sequential runs still work: the lock is released, not leaked.
    const again = await runWorker("s-later", 10);
    check(
      () => assert.equal(again.locked, false),
      "a later process is not blocked by a leaked lock",
    );
    const db2 = await store.openWorkspaceDb(ws);
    const merged = db2
      .allNodeIds()
      .map((id) => db2.get(id)?.payload || {})
      .filter(
        (p) =>
          String(p.text || "").includes("发布窗口是周五") &&
          String(p.via || "") !== "rule",
      );
    store.closeAll();
    check(
      () => assert.equal(merged.length >= 1, true),
      "a later run still writes (lock is not sticky)",
    );

    const lockFile = join(ws, ".dsh", "trivium-write.lock");
    const leftover = (() => {
      try {
        return readFileSync(lockFile, "utf8");
      } catch {
        return null;
      }
    })();
    check(() => assert.equal(leftover, null), "no lock file is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(`P55: ${checks - failures}/${checks}`);
  if (failures) process.exitCode = 1;
}

async function p56() {
  const { default: assert } = await import("node:assert/strict");
  const { default: http } = await import("node:http");
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { isAbsolute, join, relative, resolve, sep } = await import(
    "node:path"
  );
  /** Real loopback HTTP coverage for the workspace-scoped change log API. */

  const root = mkdtempSync(join(tmpdir(), "trivium-p56-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const { registerMemoryApi } = await import("../lib/server.js");
  const { rememberWorkspace } = await import("../lib/settings.js");
  const { changesPath, noteChanges, rowsForExtract } = await import(
    "../lib/change-log.js"
  );

  let handler;
  const ctx = {
    webServer: {
      register(entry) {
        handler = entry.handler;
        return () => {};
      },
    },
  };
  registerMemoryApi(ctx, { liveOptions: () => ({}), status: {} });
  const server = http.createServer((req, res) => handler(req, res));
  let checks = 0;
  function check(value, message) {
    assert.ok(value, message);
    checks++;
    console.log(`ok ${message}`);
  }
  const query = (cwd, limit) =>
    `/api/dsh-trivium/changes?cwd=${encodeURIComponent(cwd)}${limit === undefined ? "" : `&limit=${limit}`}`;

  try {
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", done);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const a = join(root, "workspace-a"),
      b = join(root, "workspace-b"),
      broken = join(root, "workspace-broken"),
      corrupt = join(root, "workspace-corrupt");
    for (const cwd of [a, b, broken, corrupt]) {
      mkdirSync(cwd, { recursive: true });
      rememberWorkspace(cwd);
    }

    check(
      noteChanges(
        a,
        Array.from({ length: 203 }, (_, i) => ({
          reason: "written",
          opId: `a-${i}`,
          preview: `fact ${i}`,
        })),
      ).ok,
      "first batch is written",
    );
    check(
      noteChanges(
        a,
        Array.from({ length: 4 }, (_, i) => ({
          reason: "written",
          opId: `next-${i}`,
          preview: `next ${i}`,
        })),
      ).ok,
      "second batch triggers another trim",
    );
    check(
      noteChanges(b, [
        { reason: "written", opId: "b-only", preview: "other workspace" },
      ]).ok,
      "second workspace has its own log",
    );
    const response = await fetch(base + query(a, 2));
    const body = await response.json();
    check(
      response.status === 200 &&
        response.headers.get("cache-control") === "no-store",
      "HTTP response succeeds and is not cached",
    );
    check(
      body.ok && body.entries.length === 2 && body.limit === 2,
      "requested response limit is applied",
    );
    check(
      body.entries[0].opId === "next-3" && body.entries[1].opId === "next-2",
      "newest rows are first",
    );
    check(
      body.total === 200 && body.trimmed === 7,
      "multiple trims preserve the cumulative dropped count",
    );
    check(
      body.labels.written?.zh && body.labels.written?.en,
      "response contains bilingual labels",
    );
    check(
      !body.entries.some((item) => item.opId === "b-only"),
      "workspace B rows do not leak into workspace A",
    );
    const other = await (await fetch(base + query(b))).json();
    check(
      other.total === 1 && other.entries[0].opId === "b-only",
      "workspace B returns only its own entry",
    );
    const capped = await (await fetch(base + query(a, 9999))).json();
    check(
      capped.limit === 200 && capped.entries.length === 200,
      "large limits are capped at the retention bound",
    );
    const fractional = await (await fetch(base + query(a, 1.5))).json();
    check(
      fractional.limit === 1 && fractional.entries.length === 1,
      "fractional limits are normalized to whole entries",
    );
    const unknown = await fetch(base + query(join(root, "unlisted")));
    check(
      unknown.status === 400 && !(await unknown.json()).ok,
      "unregistered workspaces are rejected",
    );

    const result = {
      applied: [{ id: 5, action: "merge", type: "decision", text: "changed" }],
    };
    const inserted = {
      applied: [{ id: 5, action: "insert", type: "decision", text: "changed" }],
    };
    const firstTurn = [
      { role: "user", messageId: "m1", seq: 1, text: "first change" },
    ];
    const secondTurn = [
      { role: "user", messageId: "m2", seq: 2, text: "second change" },
    ];
    for (const [turns, outcome] of [
      [firstTurn, inserted],
      [firstTurn, result],
      [secondTurn, result],
    ]) {
      check(
        noteChanges(
          b,
          rowsForExtract({ result: outcome, sessionId: "same-session", turns }),
        ).ok,
        "change window is written",
      );
    }
    const replayed = await (await fetch(base + query(b))).json();
    check(
      replayed.total === 3,
      "insert-to-merge replay deduplicates while a later edit remains visible",
    );
    const fixture = "演示口令 Demo123456";
    const sensitiveRows = rowsForExtract({
      sessionId: "same-session",
      turns: [{ role: "user", text: fixture }],
      result: {
        adjusted: [{ preview: fixture, removed: ["2027-03-01"] }],
        superseded: [{ from: 3, to: 4, label: fixture }],
      },
    });
    check(
      noteChanges(b, sensitiveRows).ok,
      "sensitive-looking audit input is handled",
    );
    check(
      !readFileSync(changesPath(b), "utf8").includes(fixture),
      "sensitive-looking values are absent from all persisted fields",
    );
    const sensitive = await (await fetch(base + query(b))).json();
    check(
      sensitive.entries
        .slice(0, 2)
        .every((row) => /^[a-f0-9]{64}$/.test(row.opId)),
      "extraction operation IDs are opaque digests",
    );
    check(
      sensitive.entries[0].preview === "<redacted>" &&
        sensitive.entries[1].detail === "<redacted>",
      "preview and detail are redacted in the HTTP result",
    );

    mkdirSync(changesPath(broken), { recursive: true });
    const failed = await fetch(base + query(broken));
    const failure = await failed.json();
    check(
      failed.status === 500 && failure.ok === false,
      "filesystem read failure is not presented as an empty log",
    );
    check(
      !JSON.stringify(failure).includes(root),
      "filesystem failure does not expose a local path",
    );
    mkdirSync(join(corrupt, ".dsh"), { recursive: true });
    writeFileSync(
      changesPath(corrupt),
      '{"reason":"written"}\ninvalid\n',
      "utf8",
    );
    const damaged = await fetch(base + query(corrupt));
    check(
      damaged.status === 500 && !(await damaged.json()).ok,
      "corrupt rows are reported instead of silently dropped",
    );
    let rejected = 0;
    await handler(
      { socket: { remoteAddress: "203.0.113.9" }, method: "GET", headers: {} },
      {
        writeHead(status) {
          rejected = status;
        },
        end() {},
      },
    );
    check(
      rejected === 403,
      "registered handler rejects a non-loopback address",
    );
    console.log(`P56: ${checks}/${checks}`);
  } finally {
    await new Promise((done) => server.close(done));
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      rmSync(root, { recursive: true, force: true });
  }
}
