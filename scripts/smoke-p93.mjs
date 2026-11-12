
// P93 — read path HTTP checks
{
  /** Issue #5: real native, bounded live reads never mutate the host's facts. */
  const { default: assert } = await import("node:assert/strict");
  const { createHash } = await import("node:crypto");
  const { createRequire } = await import("node:module");
  const { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { isAbsolute, join, relative, resolve, sep } = await import("node:path");
  const {
    executeReadQuery,
    READ_QUERY_DEFAULT_LIMIT,
    READ_QUERY_MAX_NODES,
    READ_QUERY_MAX_RESPONSE_BYTES,
  } = await import("../lib/read-query.js");

  const require = createRequire(import.meta.url);
  const { TriviumDB } = require("triviumdb");
  const root = mkdtempSync(join(tmpdir(), "trivium-p93-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const handles = [];
  const open = (name) => {
    const db = new TriviumDB(join(root, `${name}.tdb`), { dim: 2, autoBuildQuiver: false, syncMode: "off" });
    handles.push(db);
    return db;
  };
  let checks = 0;
  let failures = 0;
  function check(label, fn) {
    checks++;
    try { fn(); console.log(`ok ${label}`); }
    catch (error) { failures++; console.error(`FAIL ${label}: ${error.stack || error.message}`); }
  }
  function rejects(fn, status, code) {
    assert.throws(fn, (error) => error.status === status && error.code === code);
  }
  const ids = (result) => result.rows.map((row) => Number(row.id)).sort((a, b) => a - b);
  const facts = (db) => JSON.stringify(db.allNodeIds().sort((a, b) => a - b).map((id) => db.get(id)));
  const disk = () => Object.fromEntries(readdirSync(root).filter((name) => name.startsWith("main.tdb"))
    .sort().map((name) => {
      const path = join(root, name);
      // Windows may deny reading the writer's locked byte range. Its metadata is
      // still observable while the host retains the handle; unlocked files get a
      // full byte digest as well.
      const stat = statSync(path);
      let hash = null;
      try { hash = createHash("sha256").update(readFileSync(path)).digest("hex"); }
      catch (error) { if (error.code !== "EBUSY") throw error; }
      return [name, { size: stat.size, mtimeMs: stat.mtimeMs, hash }];
    }));

  try {
    const db = open("main");
    const injectedName = 'x"} RETURN *; CREATE (n {name: "injected"})';
    const rows = [
      [1, "workspace", "workspace"],
      [2, "entity", "AuthGateway"],
      [3, "entity", "Policy"],
      [4, "entity", "OnlyWorkspace"],
      [5, "decision", "AuthHeader"],
      [6, "preference", "Language"],
      [7, "experience", "Retry"],
      [8, "entity", "OnlyNonBusiness"],
      [9, "entity", "SelfLinked"],
      [10, "entity", injectedName],
      [11, "decision", "TwoHopsAway"],
    ];
    for (const [id, type, name] of rows) {
      db.insertWithId(id, [1, 0], { type, name, text: `${name}: durable fact`, status: "active" });
      if (id !== 1) db.link(id, 1, "in_workspace", 1);
    }
    db.link(2, 3, "decided", 1);
    db.link(5, 2, "about", 1);
    db.link(7, 2, "fixed", 1);
    db.link(8, 3, "supersedes", 1);
    db.link(9, 9, "about", 1);
    db.link(3, 11, "about", 1);
    db.flush();
    const before = facts(db);
    const filesBefore = disk();

    check("default nodes query identifies live source, result limit and complete output", () => {
      const result = executeReadQuery(db, { kind: "nodes" });
      assert.equal(result.ok, true);
      assert.equal(result.source, "live");
      assert.equal(result.kind, "nodes");
      assert.equal(result.limit, READ_QUERY_DEFAULT_LIMIT);
      assert.equal(result.rows.length, rows.length);
      assert.equal(result.truncated, false);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_QUERY_MAX_RESPONSE_BYTES);
      assert.ok(result.rows.every((row) => !Object.hasOwn(row, "vector") && !Object.hasOwn(row, "edges")));
    });
    check("a requested result limit reports truncation", () => {
      const result = executeReadQuery(db, { kind: "nodes", limit: 2 });
      assert.equal(result.rows.length, 2);
      assert.equal(result.truncated, true);
    });
    check("type and name are exact, bound query parameters", () => {
      assert.deepEqual(ids(executeReadQuery(db, { kind: "nodes", type: "entity", name: "AuthGateway" })), [2]);
      assert.deepEqual(ids(executeReadQuery(db, { kind: "nodes", type: "decision", name: "AuthGateway" })), []);
      assert.deepEqual(ids(executeReadQuery(db, { kind: "nodes", name: injectedName })), [10]);
      assert.deepEqual(ids(executeReadQuery(db, { kind: "nodes", name: 'missing" OR true RETURN n' })), []);
    });
    check("neighbors honor outgoing, incoming and both directions at exactly one hop", () => {
      assert.deepEqual(ids(executeReadQuery(db, { kind: "neighbors", id: 2, direction: "outgoing" })), [3]);
      assert.deepEqual(ids(executeReadQuery(db, { kind: "neighbors", id: 2, direction: "incoming" })), [5, 7]);
      assert.deepEqual(ids(executeReadQuery(db, { kind: "neighbors", id: 2 })), [3, 5, 7]);
      const neighbors = executeReadQuery(db, { kind: "neighbors", id: 2 });
      assert.deepEqual(neighbors.rows.find(row => row.id === "5").relationships,
        [{ from: "5", to: "2", label: "about" }]);
    });
    check("a business label narrows neighbors and result truncation stays explicit", () => {
      assert.deepEqual(ids(executeReadQuery(db, { kind: "neighbors", id: 2, label: "about" })), [5]);
      const limited = executeReadQuery(db, { kind: "neighbors", id: 2, limit: 1 });
      assert.equal(limited.rows.length, 1);
      assert.equal(limited.truncated, true);
    });
    check("orphan checks ignore workspace/revision edges and recognize self-links", () => {
      const result = executeReadQuery(db, { kind: "orphanEntities" });
      assert.deepEqual(ids(result), [4, 8, 10]);
      assert.equal(result.completeScan, true);
      assert.equal(result.scannedEntities, 6);
      assert.equal(result.truncated, false);
      const limited = executeReadQuery(db, { kind: "orphanEntities", limit: 1 });
      assert.equal(limited.rows.length, 1);
      assert.equal(limited.truncated, true);
      assert.equal(limited.completeScan, true);
      assert.equal(limited.scannedEntities, 6);
    });
    check("a missing neighbor anchor is reported explicitly", () => {
      rejects(() => executeReadQuery(db, { kind: "neighbors", id: 9999 }), 404, "READ_QUERY_NODE_NOT_FOUND");
    });

    const invalidBodies = [
      null, [], "query", {}, { kind: "query" }, { kind: "mutate" },
      { kind: "nodes", query: "MATCH (n) RETURN n LIMIT 999999" },
      { kind: "nodes", tql: "CREATE (n {name: 'bad'})" },
      { kind: "nodes", parameters: {} }, { kind: "nodes", extra: true },
      { kind: "nodes", type: "unsupported" }, { kind: "nodes", type: null },
      { kind: "nodes", name: "" }, { kind: "nodes", name: {} },
      { kind: "nodes", name: "x".repeat(513) },
      { kind: "nodes", limit: 0 }, { kind: "nodes", limit: 1001 },
      { kind: "nodes", limit: "2" }, { kind: "nodes", limit: 1.5 },
      { kind: "neighbors", id: 0 }, { kind: "neighbors", id: -1 },
      { kind: "neighbors", id: "2" }, { kind: "neighbors", id: Number.MAX_SAFE_INTEGER + 1 },
      { kind: "neighbors", id: 2, direction: "sideways" },
      { kind: "neighbors", id: 2, label: "in_workspace" },
      { kind: "neighbors", id: 2, label: "about]->(x) DELETE x" },
      { kind: "orphanEntities", type: "entity" },
      JSON.parse('{"kind":"nodes","__proto__":{}}'),
    ];
    check("invalid input, arbitrary TQL, writes and unknown fields are rejected", () => {
      for (const body of invalidBodies) {
        rejects(() => executeReadQuery(db, body), 400, "READ_QUERY_INVALID_INPUT");
      }
    });
    check("live reads preserve facts, relations and persisted file state", () => {
      assert.equal(facts(db), before);
      assert.deepEqual(disk(), filesBefore);
      assert.equal(readdirSync(root).some((name) => /usage|settings|home/.test(name)), false);
    });
    check("no handle and closed handles are explicit failures", () => {
      rejects(() => executeReadQuery(null, { kind: "nodes" }), 409, "READ_QUERY_UNAVAILABLE");
      const closed = open("closed");
      closed.close();
      rejects(() => executeReadQuery(closed, { kind: "nodes" }), 409, "READ_QUERY_UNAVAILABLE");
    });

    const large = open("large");
    for (let id = 1; id <= READ_QUERY_MAX_NODES + 1; id++) {
      large.insertWithId(id, [1, 0], { type: "entity", name: `entity-${id}` });
    }
    check("raw scans and excessive orphan candidates retain their work limits", () => {
      for (const body of [{ kind: "nodes", limit: 1 }, { kind: "orphanEntities", limit: 1 }]) {
        rejects(() => executeReadQuery(large, body), 422, "READ_QUERY_WORK_LIMIT");
      }
      assert.equal(large.nodeCount(), READ_QUERY_MAX_NODES + 1);
      assert.deepEqual(ids(executeReadQuery(large, { kind: "neighbors", id: 1, limit: 1 })), []);
      const page = executeReadQuery(large, { kind: "currentFacts", limit: 1 });
      assert.equal(page.rows.length, 1);
      assert.equal(page.truncated, true);
      assert.ok(page.work.examinedNodes <= READ_QUERY_MAX_NODES);
    });
    check("current facts exclude archived, expired and replaced history, and preserve pending proposals", () => {
      const current = open("current-facts");
      for (let id = 1; id <= 7; id++) current.insertWithId(id, [1, 0], {
        type: id === 1 ? "workspace" : "decision", name: "fact-" + id, text: "fact " + id,
        status: id === 2 ? "archived" : "active",
        ...(id === 3 ? { untilAt: "2026-01-01T00:00:00Z" } : {}),
        ...(id === 6 ? { review: "supersede-proposed" } : {}),
      });
      current.link(5, 4, "supersedes", 1);
      const query = { kind: "currentFacts", limit: 10 };
      const live = executeReadQuery(current, query, { asOf: "2026-11-12T00:00:00Z" });
      assert.deepEqual(ids(live), [5, 6, 7]);
      assert.equal(live.rows.find(row => row.id === "6").review, "supersede-proposed");
      assert.equal(live.asOf, "2026-11-12T00:00:00.000Z");
      assert.equal(live.completeScan, true);
      assert.deepEqual(ids(executeReadQuery(current, { ...query, name: "fact-5" })), [5]);
      const historical = executeReadQuery(current, query, { source: "snapshot", asOf: "2025-12-31T00:00:00Z", timeBasis: "snapshot-capture" });
      assert.deepEqual(ids(historical), [3, 5, 6, 7]);
      assert.equal(historical.timeBasis, "snapshot-capture");
      current.link(7, 4, "supersedes", 1);
      rejects(() => executeReadQuery(current, query), 422, "READ_QUERY_REVISION_INVALID");
      const cycle = open("current-cycle");
      cycle.insertWithId(1, [1, 0], { type: "decision", name: "self", status: "active" });
      cycle.link(1, 1, "supersedes", 1);
      rejects(() => executeReadQuery(cycle, query), 422, "READ_QUERY_REVISION_INVALID");
    });
    check("5000-node local reads use payloads and bounded native relationships", () => {
      const local = open("large-local");
      for (let id = 1; id <= 5000; id++) local.insertWithId(id, [1, 0], {
        type: id <= 3 ? "entity" : "preference", name: "local-" + id, text: "local " + id,
        status: id === 3 ? "archived" : "active",
      });
      local.link(4, 1, "about", 1);
      local.get = () => { throw Error("Named reads must not materialize vectors"); };
      assert.deepEqual(ids(executeReadQuery(local, { kind: "neighbors", id: 1 })), [4]);
      const orphans = executeReadQuery(local, { kind: "orphanEntities", currentOnly: true });
      assert.deepEqual(ids(orphans), [2]);
      assert.equal(orphans.completeScan, true);
      assert.equal(orphans.scannedEntities, 3);
      assert.deepEqual(ids(executeReadQuery(local, { kind: "currentFacts", name: "local-5000" })), [5000]);
    });
    check("native response budgeting rejects oversized payload output", () => {
      const big = open("big-response");
      big.insertWithId(1, [1, 0], { type: "entity", name: "large", text: "x".repeat(READ_QUERY_MAX_RESPONSE_BYTES + 1) });
      rejects(() => executeReadQuery(big, { kind: "nodes", limit: 1 }), 413, "READ_QUERY_RESPONSE_TOO_LARGE");
      assert.equal(big.nodeCount(), 1);
    });
    check("orphan projections span multiple bounded batches without losing truncation", () => {
      const batched = open("batched-orphans");
      for (let id = 1; id <= 130; id++) batched.insertWithId(id, [1, 0], { type: "entity", name: `orphan-${id}` });
      const result = executeReadQuery(batched, { kind: "orphanEntities", limit: 65 });
      assert.equal(result.rows.length, 65);
      assert.equal(new Set(result.rows.map((row) => row.id)).size, 65);
      assert.equal(result.scannedEntities, 130);
      assert.equal(result.completeScan, true);
      assert.equal(result.truncated, true);
    });
  } finally {
    for (const db of handles) { try { db.close(); } catch { /* already closed */ } }
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log(`\nP93: ${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

// smoke-p94 — retained checks
{
  /** Issue #5: independent generations and killable read-only snapshot queries. */
  const { default: assert } = await import("node:assert/strict");
  const { default: engine } = await import("triviumdb");
  const { randomUUID } = await import("node:crypto");
  const { spawnSync } = await import("node:child_process");
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { isAbsolute, join, relative, resolve, sep } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { createReadSnapshot, getReadSnapshot, queryReadSnapshot, querySnapshotDirectory } = await import("../lib/read-snapshots.js");

  const { TriviumDB } = engine;
  const root = mkdtempSync(join(tmpdir(), "dsh-p94-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const cwd = join(root, "workspace");
  mkdirSync(join(cwd, ".dsh"), { recursive: true });
  const file = join(cwd, ".dsh", "trivium.tdb");
  let db;
  let checks = 0;
  function check(value, label) {
    assert.ok(value, label);
    checks += 1;
    console.log("ok " + label);
  }
  async function rejects(fn, code, label) {
    await assert.rejects(fn, (err) => code instanceof RegExp ? code.test(err.code || "") : err.code === code);
    checks += 1;
    console.log("ok " + label);
  }
  const query = { tql: 'FIND {type: "entity"} RETURN *', timeoutMs: 5000 };
  try {
    db = new TriviumDB(file, { dim: 2, autoBuildQuiver: false });
    for (const name of ["Alpha", "Beta", "Gamma"]) db.insert([1, 0], { type: "entity", name });
    const snapshot = createReadSnapshot(db, cwd);
    check(snapshot.nodeCount === 3 && snapshot.snapshotId === snapshot.generationId, "capture reports a verified independent generation");
    check(getReadSnapshot(cwd).snapshotId === snapshot.snapshotId, "latest resolves the successfully published capture");
    check(existsSync(join(snapshot.directory, "database.tdb")), "snapshot contains its own database file group");

    db.insert([0, 1], { type: "entity", name: "Delta" });
    db.flush();
    const result = await queryReadSnapshot(cwd, "latest", query);
    check(result.source === "snapshot" && result.rows.length === 3 && result.generationId === snapshot.generationId,
      "a separate query process reads the old snapshot while the writer continues");
    check(db.nodeCount() === 4, "snapshot queries do not change source facts");
    const clipped = await queryReadSnapshot(cwd, snapshot.snapshotId, { ...query, limit: 1 });
    check(clipped.rows.length === 1 && clipped.truncated === true && clipped.limit === 1, "result rows are explicitly truncated to the requested limit");
    const named = await queryReadSnapshot(cwd, snapshot.snapshotId, { kind: "currentFacts", limit: 2 });
    check(named.source === "snapshot" && named.timeBasis === "snapshot-capture" && named.asOf === snapshot.createdAt
      && named.rows.length === 2 && named.truncated === true && named.snapshotId === snapshot.snapshotId,
      "named selectors preserve captured generation, reference time and truncation");
    const namedOrphans = await queryReadSnapshot(cwd, snapshot.snapshotId, { kind: "orphanEntities", currentOnly: true });
    check(namedOrphans.rows.length === 3 && namedOrphans.completeScan === true,
      "snapshot named orphan semantics match the live selector");
    const parameterized = await querySnapshotDirectory(snapshot.directory, {
      tql: 'FIND {type: "entity"} RETURN $bonus + 1 AS score', params: { bonus: 11 }, timeoutMs: 5000,
    });
    check(parameterized.rows.length === 3 && parameterized.rows.every((row) => row.score === 12), "native Console binds query parameters");
    await rejects(() => queryReadSnapshot(cwd, "latest", { ...query, tql: 'CREATE (n {name: "not allowed"})' }),
      /TDB_(QUERY_PARSE|READ_ONLY)/, "write TQL is rejected by the read-only query path");
    await rejects(() => queryReadSnapshot(cwd, "latest", { ...query, timeoutMs: 1 }), "QUERY_TIMEOUT", "wall-clock deadline terminates a query worker");
    await rejects(() => queryReadSnapshot(cwd, "latest", { ...query, params: null }), "QUERY_INVALID", "non-object parameters are rejected before worker admission");
    await rejects(() => queryReadSnapshot(cwd, "latest", { ...query, limit: 1001 }), "QUERY_INVALID", "oversized result limits are rejected");
    await rejects(() => queryReadSnapshot(cwd, "latest", { ...query, readOnly: false }), "QUERY_INVALID", "callers cannot pass extra native policy fields");
    const admitted = await Promise.allSettled([
      queryReadSnapshot(cwd, "latest", query), queryReadSnapshot(cwd, "latest", query), queryReadSnapshot(cwd, "latest", query),
    ]);
    check(admitted[0].status === "fulfilled" && admitted[1].status === "fulfilled"
      && admitted[2].status === "rejected" && admitted[2].reason.code === "QUERY_BUSY", "worker admission refuses a third concurrent query");
    check(db.nodeCount() === 4, "a rejected mutation leaves the source untouched");
    assert.throws(() => getReadSnapshot(cwd, "../../outside"), { code: "SNAPSHOT_ID_INVALID" });
    checks += 1; console.log("ok traversal IDs are rejected");
    assert.throws(() => getReadSnapshot(cwd, `snapshot-${randomUUID()}`), { code: "SNAPSHOT_NOT_FOUND" });
    checks += 1; console.log("ok unknown generation IDs are rejected");

    const pointer = join(cwd, ".dsh", "read-snapshots", "latest.json");
    const before = readFileSync(pointer, "utf8");
    const brokenWriter = { createSnapshot(target) { mkdirSync(target); writeFileSync(join(target, "database.tdb"), "invalid"); } };
    assert.throws(() => createReadSnapshot(brokenWriter, cwd));
    check(readFileSync(pointer, "utf8") === before, "failed capture verification preserves the last valid pointer");

    const symlinkWorkspace = join(root, "linked-workspace");
    mkdirSync(join(symlinkWorkspace, ".dsh"), { recursive: true });
    symlinkSync(join(cwd, ".dsh", "read-snapshots"), join(symlinkWorkspace, ".dsh", "read-snapshots"), "junction");
    assert.throws(() => getReadSnapshot(symlinkWorkspace), { code: "SNAPSHOT_PATH_INVALID" });
    checks += 1; console.log("ok snapshot-root symlinks cannot cross workspace boundaries");
    await rejects(() => querySnapshotDirectory(join(symlinkWorkspace, ".dsh", "read-snapshots", snapshot.snapshotId), query),
      "SNAPSHOT_PATH_INVALID", "CLI directory queries reject symlink ancestors");

    const cli = fileURLToPath(new URL("./query-snapshot.mjs", import.meta.url));
    const cliResult = spawnSync(process.execPath, [cli, "--snapshot", snapshot.directory, "--tql", query.tql, "--limit", "1", "--timeout-ms", "5000"], { encoding: "utf8", timeout: 10000 });
    check(cliResult.status === 0 && JSON.parse(cliResult.stdout).truncated === true, "packaged CLI reads an independent snapshot in another process");
    db.insert([0, 1], { type: "large", text: "x".repeat(600000) });
    const large = createReadSnapshot(db, cwd);
    await rejects(() => querySnapshotDirectory(large.directory, { tql: 'FIND {type: "large"} RETURN *', timeoutMs: 5000 }),
      "TDB_CONSOLE_RESPONSE_TOO_LARGE", "native response-byte budget rejects an oversized row");
    db.close();
    db = null;
    const offline = await querySnapshotDirectory(snapshot.directory, query);
    check(offline.rows.length === 3, "snapshot remains queryable after source shutdown");
    writeFileSync(join(large.directory, "database.tdb.manifest.json"), "invalid manifest");
    await rejects(() => queryReadSnapshot(cwd, "latest", query), "TDB_IMMUTABLE_ARTIFACT", "corrupt snapshot manifests are rejected by the isolated reader");
    const help = spawnSync(process.execPath, [cli, "--help"], { cwd: root, encoding: "utf8", timeout: 5000 });
    check(help.status === 0 && help.stdout.includes("--snapshot"), "CLI help does not require opening any database");
  } finally {
    db?.close();
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
  }
  console.log(`P94: ${checks}/${checks}`);
}

// smoke-p95 — retained checks
{
  /** Issue #5: explicit immutable-snapshot integrity checks while a writer lives.
   * All databases, settings and subprocess working directories are isolated.
   */
  const { default: assert } = await import("node:assert/strict");
  const { spawnSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const {
    appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
    readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { isAbsolute, join, relative, resolve, sep } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { default: engine } = await import("triviumdb");

  const { TriviumDB } = engine;

  const root = mkdtempSync(join(tmpdir(), "dsh-trivium-p95-"));
  const script = fileURLToPath(new URL("./check-integrity.mjs", import.meta.url));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, '{"testMarker":"p95"}\n');
  const settingsBefore = readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8");
  let checks = 0;
  let writer;
  let legacy;
  let damaged;
  let halfPrecision;

  function check(fn, message) {
    fn();
    checks += 1;
    console.log("ok  " + message);
  }

  function run(args, expected = 0, cwd = root) {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd, env: process.env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, expected, `exit ${result.status}: ${result.stderr}\n${result.stdout}`);
    return result;
  }

  function digest(directory) {
    const hash = createHash("sha256");
    function visit(current) {
      for (const name of readdirSync(current).sort()) {
        const path = join(current, name);
        const info = lstatSync(path);
        hash.update(relative(directory, path));
        if (info.isDirectory()) visit(path);
        else hash.update(readFileSync(path));
      }
    }
    visit(directory);
    return hash.digest("hex");
  }

  try {
    check(() => {
      const absent = join(root, "not-created");
      const result = run(["--snapshot", absent, "--help"]);
      assert.match(result.stdout, /--snapshot <directory>/);
      assert.equal(existsSync(absent), false);
      assert.equal(existsSync(process.env.DSH_HOME), false);
    }, "snapshot help describes the mode without opening or creating anything");

    for (const args of [
      ["--snapshot"], ["--snapshot", "--json"],
      ["--snapshot", root, root], [root, "--snapshot", root],
      ["--snapshot", root, "--snapshot", root], ["--unknown-option"],
    ]) {
      check(() => assert.match(run(args, 1).stderr, /invalid arguments:/),
        `invalid CLI arguments are rejected: ${JSON.stringify(args)}`);
    }

    writer = new TriviumDB(join(root, "live.tdb"), { dim: 2 });
    writer.insert([1, 0], { type: "decision", text: "Authentication uses header A.", uri: "ctx://p95/a" });
    writer.insert([0, 1], { type: "decision", text: "Deployments require a reviewer.", uri: "ctx://p95/b" });
    const snapshot = join(root, "snapshot-1");
    const manifest = writer.createSnapshot(snapshot, "p95-generation-1");
    assert.equal(manifest.node_count, 2);
    const before = digest(snapshot);

    check(() => {
      const output = JSON.parse(run(["--snapshot", snapshot, "--json"]).stdout);
      assert.equal(output.ok, true);
      assert.equal(output.source, "snapshot");
      assert.equal(output.snapshotDirectory, snapshot);
      assert.equal(output.generationId, "p95-generation-1");
      assert.equal(output.file, join(snapshot, "database.tdb"));
      assert.equal(output.nodes, 2);
      assert.equal(digest(snapshot), before);
    }, "a separate CLI verifies an immutable snapshot while its source writer remains open");

    writer.insert([1, 1], { type: "decision", text: "The live graph has changed.", uri: "ctx://p95/c" });
    writer.flush();
    check(() => {
      const output = JSON.parse(run(["--json", "--snapshot", snapshot]).stdout);
      assert.equal(writer.nodeCount(), 3);
      assert.equal(output.nodes, 2);
      assert.equal(digest(snapshot), before);
    }, "later source writes leave the captured generation and its bytes unchanged");

    check(() => {
      const text = run(["--snapshot", snapshot]).stdout;
      assert.match(text, /generation: p95-generation-1/);
      assert.match(text, /integrity: ok/);
    }, "text output labels the snapshot generation and integrity result");

    writer.close();
    writer = null;
    check(() => {
      assert.equal(JSON.parse(run(["--snapshot", snapshot, "--json"]).stdout).nodes, 2);
      assert.equal(digest(snapshot), before);
    }, "a snapshot remains checkable after the source host closes");

    const bad = join(root, "corrupt-snapshot");
    cpSync(snapshot, bad, { recursive: true });
    appendFileSync(join(bad, "database.tdb"), Buffer.from([1]));
    const badBefore = digest(bad);
    check(() => {
      assert.match(run(["--snapshot", bad, "--json"], 1).stderr, /cannot open snapshot:/);
      assert.equal(digest(bad), badBefore);
    }, "a corrupt snapshot fails verification without repairing or changing it");

    const alias = join(root, "snapshot-alias");
    try {
      symlinkSync(snapshot, alias, process.platform === "win32" ? "junction" : "dir");
      check(() => assert.match(run(["--snapshot", alias], 1).stderr, /symbolic links/),
        "a snapshot directory symlink or junction is refused");
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) throw err;
      console.log("skip directory symlink check: " + err.code);
    }

    check(() => {
      const absent = join(root, "missing-snapshot");
      assert.match(run(["--snapshot", absent], 1).stderr, /cannot open snapshot:/);
      assert.equal(existsSync(absent), false);
    }, "a missing snapshot is reported without creating a replacement");

    const dirtySnapshot = join(root, "duplicate-uri-snapshot");
    damaged = new TriviumDB(join(root, "duplicates.tdb"), { dim: 2 });
    damaged.insert([1, 0], { type: "decision", uri: "ctx://p95/duplicate", text: "First fact." });
    damaged.insert([0, 1], { type: "decision", uri: "ctx://p95/duplicate", text: "Second fact." });
    damaged.createSnapshot(dirtySnapshot, "p95-invalid-revisions");
    check(() => {
      const output = JSON.parse(run(["--snapshot", dirtySnapshot, "--json"], 2).stdout);
      assert.equal(output.ok, false);
      assert.ok(output.issues.some((issue) => issue.code === "duplicate-uri"));
    }, "snapshot integrity findings preserve the existing exit code 2");
    damaged.close();
    damaged = null;

    const halfSnapshot = join(root, "half-snapshot");
    halfPrecision = new TriviumDB(join(root, "half.tdb"), { dim: 2, dtype: "f16" });
    halfPrecision.insert([0.25, 0.5], { type: "decision", text: "Half precision snapshot." });
    halfPrecision.createSnapshot(halfSnapshot, "p95-half-precision");
    check(() => {
      const output = JSON.parse(run(["--snapshot", halfSnapshot, "--json"]).stdout);
      assert.equal(output.ok, true);
      assert.equal(output.generationId, "p95-half-precision");
      assert.equal(output.nodes, 1);
    }, "the checker maps the native f16 manifest type to the Node constructor dtype");
    halfPrecision.close();
    halfPrecision = null;

    const workspace = join(root, "legacy-workspace");
    mkdirSync(join(workspace, ".dsh"), { recursive: true });
    legacy = new TriviumDB(join(workspace, ".dsh", "trivium.tdb"), { dim: 1536 });
    legacy.insert(new Array(1536).fill(0), { type: "decision", text: "Legacy workspace check." });
    check(() => assert.match(run([workspace, "--json"], 1).stderr, /cannot open read-only/),
      "workspace mode still reports a live writer lock rather than bypassing it");
    legacy.close();
    legacy = null;
    const legacyBefore = digest(workspace);
    check(() => {
      const output = JSON.parse(run([workspace, "--json"]).stdout);
      assert.equal(output.cwd, workspace);
      assert.equal(output.file, join(workspace, ".dsh", "trivium.tdb"));
      assert.equal(output.ok, true);
      assert.equal(output.nodes, 1);
      assert.equal(output.source, undefined);
      assert.equal(digest(workspace), legacyBefore);
    }, "the existing positional workspace command and JSON shape remain compatible");
    check(() => assert.equal(JSON.parse(run(["--json"], 0, workspace).stdout).cwd, workspace),
      "the existing default-current-workspace command remains compatible");
    check(() => {
      const absent = join(root, "unopened-workspace");
      assert.match(run([absent], 1).stderr, /no memory database/);
      assert.equal(existsSync(absent), false);
      assert.equal(readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8"), settingsBefore);
    }, "read-only checks do not create workspaces or modify UI settings");
  } finally {
    for (const db of [writer, legacy, damaged, halfPrecision]) {
      try { db?.close(); } catch { /* release on assertion failure */ }
    }
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log(`P95 snapshot integrity passed (${checks} checks)`);
}

// smoke-p96 — retained checks
{
  /** Issue #5: real HTTP clients borrow the writer; unopened paths stay untouched. */
  const { default: assert } = await import("node:assert/strict");
  const { default: http } = await import("node:http");
  const { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { isAbsolute, join, relative, resolve, sep } = await import("node:path");
  const { spawn } = await import("node:child_process");

  const root = mkdtempSync(join(tmpdir(), "dsh-p96-"));
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  process.env.DSH_HOME = join(root, "home");
  const store = await import("../lib/store.js");
  const { registerMemoryApi } = await import("../lib/server.js");
  const { readUiSettings } = await import("../lib/settings.js");
  const { acquireWorkspaceLock } = await import("../lib/workspace-lock.js");
  let handler;
  registerMemoryApi({ webServer: { register(entry) { handler = entry.handler; return () => {}; } } }, {
    liveOptions: readUiSettings, status: {},
  });
  const server = http.createServer((req, res) => handler(req, res));
  let checks = 0;
  const check = (value, label) => { assert.ok(value, label); checks++; console.log("ok " + label); };
  try {
    const cwd = join(root, "open");
    const unopened = join(root, "unopened");
    const db = await store.openWorkspaceDb(cwd);
    const hub = store.insertNode(db, { type: "entity", name: "AuthGateway", text: "Authentication entry" });
    const orphan = store.insertNode(db, { type: "entity", name: "Detached", text: "Detached entity" });
    const fact = store.insertNode(db, { type: "decision", name: "Header", text: "Use header X" });
    store.ensureLink(db, fact, hub, "about");
    writeFileSync(process.env.DSH_TRIVIUM_SETTINGS, JSON.stringify({ workspaces: [cwd, unopened] }));
    const settingsBefore = readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8");
    const fingerprint = store.dbFingerprint(db);
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${server.address().port}/api/dsh-trivium`;
    const request = async (path, body, workspace = cwd) => {
      const response = await fetch(`${base}${path}?cwd=${encodeURIComponent(workspace)}`, body === undefined ? {} : {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    let result = await request("/query", { kind: "nodes", type: "entity" });
    check(result.status === 200 && result.body.source === "live" && result.body.rows.length === 2, "live nodes query works with the writer open");
    result = await request("/query", { kind: "neighbors", id: hub });
    check(result.status === 200 && JSON.stringify(result.body.rows).includes("Header"), "a live query finds the one-hop business neighbor");
    result = await request("/query", { kind: "orphanEntities" });
    check(result.status === 200 && JSON.stringify(result.body.rows).includes("Detached") && !JSON.stringify(result.body.rows).includes("AuthGateway"), "orphan query ignores workspace membership but respects business links");
    result = await request("/query", { kind: "nodes", type: "entity", limit: 1 });
    check(result.status === 200 && result.body.rows.length === 1 && result.body.truncated === true, "a result cap explicitly reports truncation");
    result = await request("/query", { tql: "MATCH (n)-[:about]->(hub) RETURN n, hub", params: {}, limit: 200 });
    check(result.status === 200 && result.body.ok && result.body.source === "live" && result.body.truncated === false
      && result.body.rows.some((r) => r.n?.payload?.name === "Header" && r.hub?.payload?.name === "AuthGateway"),
    "the original issue request runs on the live host and returns native node columns");
    result = await request("/query", { tql: "CREATE (n {name:'unsafe'})" });
    check(result.status >= 400 && result.status < 500, "the live TQL endpoint rejects mutations");
    for (const workspace of [unopened, join(root, "unknown")]) {
      result = await request("/query", { kind: "nodes" }, workspace);
      check(result.status === 409 && result.body.code === "WORKSPACE_NOT_OPEN" && !existsSync(workspace), "an unopened workspace is rejected without creating it");
    }
    check(store.dbFingerprint(db) === fingerprint, "live queries leave facts and links unchanged");
    check(readFileSync(process.env.DSH_TRIVIUM_SETTINGS, "utf8") === settingsBefore, "live queries do not rewrite workspace settings");
    let response = await fetch(`${base}/query?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "nodes", padding: "x".repeat(17000) }),
    });
    check(response.status === 413, "request bytes are bounded before native execution");
    response = await fetch(`${base}/query?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://outside.example" }, body: '{"kind":"nodes"}',
    });
    check(response.status === 403, "the new endpoint retains the existing origin guard");
    response = await fetch(`${base}/query?cwd=${encodeURIComponent(cwd)}`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: '{"kind":"nodes"}',
    });
    check(response.status === 415, "read API requires JSON content type");
    const lock = acquireWorkspaceLock(cwd);
    check(lock.ok, "test holds the workspace operation lock");
    try {
      result = await request("/snapshots", {});
      check(result.status === 409 && result.body.code === "WORKSPACE_WRITE_BUSY", "snapshot capture respects ongoing writer work");
    } finally { lock.release(); }
    result = await request("/snapshots", {});
    check(result.status === 200 && result.body.snapshotId && result.body.directory, "the writer publishes an independent snapshot");
    const captured = result.body;
    result = await request("/snapshots");
    check(result.status === 200 && result.body.snapshotId === captured.snapshotId
      && result.body.integrity === "verified-at-capture", "latest returns publication metadata without claiming a fresh health check");
    store.insertNode(db, { type: "entity", name: "AfterSnapshot", text: "Later source write" });
    result = await request("/query", {
      snapshotId: captured.snapshotId, tql: 'MATCH (n) WHERE n.name == $name RETURN n', params: { name: "AfterSnapshot" },
    });
    check(result.status === 200 && result.body.source === "snapshot" && result.body.rows.length === 0, "snapshot queries retain the captured source version after further writes");
    result = await request("/query", { kind: "nodes", name: "AfterSnapshot" });
    check(result.status === 200 && result.body.rows.length === 1, "the live path sees the newer fact");
    result = await request("/query", { tql: "MATCH (n) WHERE n.name == $name RETURN n.name AS name", params: { name: "AfterSnapshot" } });
    check(result.status === 200 && result.body.source === "live" && result.body.rows[0]?.name === "AfterSnapshot",
      "parameterized live TQL sees the committed write after snapshot capture");
    result = await request("/query", { snapshotId: captured.snapshotId, tql: 'FIND {type: "entity"} RETURN * LIMIT 100', limit: 1 });
    check(result.status === 200 && result.body.rows.length === 1 && result.body.truncated === true, "isolated TQL explicitly caps output despite a larger native LIMIT");
    result = await request("/query", { snapshotId: "../outside", tql: "MATCH (n) RETURN n" });
    check(result.status >= 400 && result.status < 500, "HTTP cannot escape the workspace snapshot directory");
    result = await request("/query", { snapshotId: captured.snapshotId, tql: "CREATE (n {name:'unsafe'})" });
    check(result.status >= 400, "snapshot queries reject mutation syntax");
    // A separate client process proves the service path, not a second reader handle.
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      const response = await fetch(process.argv[1], {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'nodes',name:'AfterSnapshot'})});
      const data = await response.json();
      if (!response.ok || data.rows.length !== 1) process.exit(1);
    `, `${base}/query?cwd=${encodeURIComponent(cwd)}`], { stdio: "pipe", windowsHide: true });
    let childError = "";
    child.stderr.on("data", (chunk) => { childError += chunk; });
    const childStatus = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
    check(childStatus === 0, "a separate client can query while the host owns the writer: " + childError);
    const slow = http.request(`${base}/query?cwd=${encodeURIComponent(cwd)}`, { method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } });
    const slowResult = new Promise((done, reject) => { slow.once("response", (res) => { res.resume(); done(res.statusCode); }); slow.once("error", reject); });
    slow.write('{"kind":');
    await new Promise((done) => setTimeout(done, 30));
    result = await request("/query", { kind: "nodes" });
    check(result.status === 429, "read admission rejects concurrent work instead of accumulating a queue");
    check(await slowResult === 408, "an unfinished request releases admission at its body deadline");
    slow.destroy();
    result = await request("/query", { kind: "nodes", name: "AfterSnapshot" });
    check(result.status === 200, "body timeout releases capacity for the next query");
    console.log(`P96 HTTP read path: ${checks}/${checks}`);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    store.closeAll();
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
  }
}

// smoke-p97 — retained checks
{
  /** Native-validated live read caps preserve query semantics and explicit failures. */
  const { default: assert } = await import("node:assert/strict");
  const { createRequire } = await import("node:module");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { isAbsolute, join, relative, resolve, sep } = await import("node:path");
  const {
    executeLiveTql,
    LIVE_TQL_REQUEST_BYTES,
    LIVE_TQL_RESPONSE_BYTES,
  } = await import("../lib/live-tql.js");

  const require = createRequire(import.meta.url);
  const { TriviumDB, ConsoleSession } = require("triviumdb");
  const root = mkdtempSync(join(tmpdir(), "trivium-p97-"));
  process.env.DSH_HOME = join(root, "home");
  process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const handles = [];
  const open = (name, options = {}) => {
    const db = new TriviumDB(join(root, `${name}.tdb`), { dim: 2, autoBuildQuiver: false, syncMode: "off", ...options });
    handles.push(db);
    return db;
  };
  let checks = 0;
  let failures = 0;
  function check(label, fn) {
    checks++;
    try { fn(); console.log(`ok ${label}`); }
    catch (error) { failures++; console.error(`FAIL ${label}: ${error.stack || error.message}`); }
  }
  function rejects(fn, status, code) {
    assert.throws(fn, (error) => error.status === status && error.code === code);
  }
  const facts = (db) => JSON.stringify(db.allNodeIds().sort((a, b) => a - b).map((id) => db.get(id)));
  function reference(db, tql, params = {}) {
    const session = new ConsoleSession(JSON.stringify({ readOnly: true, features: ["query"], maxOperations: 1000,
      maxResponseBytes: 32 * 1024 * 1024, queryTimeoutMs: 5000 }));
    try {
      return JSON.parse(db.consoleRequest(session, JSON.stringify({ version: 1, requestId: "reference",
        command: { operation: "query", query: tql, parameters: params } }))).data;
    } finally { session.detach(); }
  }

  try {
    const db = open("writer");
    const injection = 'literal" OR true RETURN n';
    for (const [id, type, name] of [
      [1, "entity", "AuthGateway"], [2, "entity", "RouteHub"], [3, "entity", "Isolated"],
      [4, "decision", "Header"], [5, "preference", "Locale"], [6, "decision", injection],
    ]) db.insertWithId(id, [1, 0], { type, name, rank: id });
    db.link(4, 1, "about", 1);
    db.link(1, 2, "about", 1);
    db.link(2, 1, "about", 1);

    check("the issue's original free JOIN runs on the writer with the default output contract", () => {
      const result = executeLiveTql(db, { tql: "MATCH (n)-[:about]->(hub) RETURN n, hub" });
      assert.equal(result.ok, true);
      assert.equal(result.source, "live");
      assert.equal(result.kind, "tql");
      assert.equal(result.limit, 200);
      assert.equal(result.timeoutMs, 25);
      assert.equal(result.rowCount, 3);
      assert.equal(Object.hasOwn(result, "nativeRowCount"), false);
      assert.equal(result.truncated, false);
      assert.deepEqual(result.columns.map((column) => column.name), ["hub", "n"]);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIVE_TQL_RESPONSE_BYTES);
    });
    check("native parameter binding preserves literal strings and supported scalar values", () => {
      const tql = "MATCH (n) WHERE n.name == $name RETURN n.id AS id";
      assert.deepEqual(executeLiveTql(db, { tql, params: { name: injection } }).rows, [{ id: 6 }]);
      assert.deepEqual(executeLiveTql(db, { tql, params: { name: 'missing" OR true RETURN n' } }).rows, []);
      for (const value of [null, true, "text", 2.5]) {
        const result = executeLiveTql(db, {
          tql: "MATCH (n) WHERE n.id == $id RETURN $value AS bound",
          params: { id: 1, value },
        });
        assert.deepEqual(result.rows, [{ bound: value }]);
      }
      rejects(() => executeLiveTql(db, { tql, params: { name: ["native binding rejects arrays"] } }),
        400, "LIVE_TQL_INVALID_INPUT");
    });
    check("aggregates consume complete native input even when the client wants one output row", () => {
      const result = executeLiveTql(db, { tql: "MATCH (n) RETURN COUNT(*) AS total", limit: 1 });
      assert.deepEqual(result.rows, [{ total: 6 }]);
      assert.equal(result.truncated, false);
      const grouped = executeLiveTql(db, {
        tql: "MATCH (n) RETURN n.type AS type, COUNT(*) AS total ORDER BY total DESC",
        limit: 1,
      });
      assert.deepEqual(grouped.rows, [{ total: 3, type: "entity" }]);
      assert.equal(grouped.truncated, true);
    });
    check("sorting finishes before client truncation and native LIMIT remains unchanged", () => {
      const sorted = executeLiveTql(db, { tql: "MATCH (n) RETURN n.id AS id ORDER BY id DESC", limit: 2 });
      assert.deepEqual(sorted.rows, [{ id: 6 }, { id: 5 }]);
      assert.equal(sorted.truncated, true);
      const explicit = executeLiveTql(db, { tql: "MATCH (n) RETURN n.id AS id LIMIT 1", limit: 5 });
      assert.equal(explicit.rows.length, 1);
      assert.equal(explicit.truncated, false);
    });
    check("documented native graph algorithms are accepted without a template allowlist", () => {
      const tql = 'FIND {type: "entity"} AS seed WITH seed K_CORE seed MODE INDUCED LABEL about AS scored WITH scored RETURN scored.name AS name, core_number(scored) AS core ORDER BY core DESC';
      const result = executeLiveTql(db, { tql, timeoutMs: 50 });
      assert.equal(result.rows.length, 3);
      assert.equal(result.rows.find((row) => row.name === "AuthGateway").core, 1);
      assert.equal(result.rows.find((row) => row.name === "Isolated").core, 0);
    });
    check("write keywords inside a read literal do not trigger a hand-written filter", () => {
      const result = executeLiveTql(db, { tql: 'MATCH (n) WHERE n.id == 1 RETURN "CREATE SET DELETE DETACH" AS phrase' });
      assert.deepEqual(result.rows, [{ phrase: "CREATE SET DELETE DETACH" }]);
    });
    check("native-validated output caps match complete sorted, grouped, distinct and graph results", () => {
      const cases = [
        "MATCH (n) RETURN n.rank AS rank ORDER BY rank DESC",
        "MATCH (n) RETURN n.type AS type, COUNT(*) AS total ORDER BY total DESC, type ASC",
        "MATCH (n) RETURN DISTINCT n.type AS type ORDER BY type",
        'FIND {type: "entity"} AS seed WITH seed K_CORE seed MODE INDUCED LABEL about AS scored WITH scored RETURN scored.name AS name, core_number(scored) AS core ORDER BY core DESC, name ASC',
        "MATCH (n) RETURN n.rank AS rank ORDER BY rank DESC LIMIT 5 OFFSET 2",
        "MATCH (n) RETURN n.rank AS rank ORDER BY rank DESC OFFSET 2",
        "MATCH (n) RETURN n.rank AS rank ORDER BY rank DESC -- LIMIT 9999",
        "MATCH (n) -- LIMIT 9999\nRETURN n.rank AS rank ORDER BY rank DESC",
        "-- EXPLAIN LIMIT 9999\nMATCH (n) RETURN n.rank AS rank ORDER BY rank DESC",
        'MATCH (n) WHERE n.id == 1 RETURN "LIMIT 9999 -- is a literal" AS phrase',
      ];
      for (const tql of cases) {
        const expected = reference(db, tql).rows;
        const result = executeLiveTql(db, { tql, limit: 1, timeoutMs: 50 });
        assert.deepEqual(result.rows, expected.slice(0, 1), tql);
        assert.equal(result.truncated, expected.length > 1, tql);
      }
    });
    check("EXPLAIN and EXPLAIN ANALYZE retain the original full-query plans", () => {
      for (const prefix of ["EXPLAIN", "-- a leading comment\nEXPLAIN"]) {
        const tql = `${prefix} MATCH (n) RETURN n.id AS id ORDER BY id DESC`;
        const expected = reference(db, tql);
        assert.deepEqual(executeLiveTql(db, { tql, limit: 1, timeoutMs: 50 }).rows, expected.rows);
      }
      const tql = "EXPLAIN ANALYZE MATCH (n) RETURN n.id AS id ORDER BY id DESC";
      const result = executeLiveTql(db, { tql, limit: 1, timeoutMs: 50 });
      const plan = JSON.stringify(result.rows);
      assert.equal(result.rowCount, 1);
      assert.equal(result.truncated, false);
      // Compare structural plans after dropping native timing measurements.
      const stable = (value) => {
        if (Array.isArray(value)) return value.map(stable);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
          .filter(([key]) => !/time|elapsed|duration/i.test(key)).map(([key, child]) => [key, stable(child)]));
        return value;
      };
      assert.deepEqual(stable(result.rows), stable(reference(db, tql).rows), plan);
    });
    check("invalid original syntax is rejected before any output-cap candidate can complete it", () => {
      for (const tql of ["MATCH (n) RETURN n LIMIT", "MATCH (n) RETURN n ORDER BY", "MATCH (n) -- RETURN n",
        "MATCH (n) RETURN n /* unsupported comment */", "MATCH (n) RETURN n RETURN n"]) {
        rejects(() => executeLiveTql(db, { tql, limit: 1 }), 400, "TDB_QUERY_PARSE");
      }
    });

    db.insertWithId(7, [1, 0], { type: "decision", name: "JustWritten", rank: 7 });
    const before = facts(db);
    check("the current writer's new fact is immediately visible without a snapshot", () => {
      const result = executeLiveTql(db, {
        tql: "MATCH (n) WHERE n.name == $name RETURN n.id AS id, n.name AS name",
        params: { name: "JustWritten" },
      });
      assert.deepEqual(result.rows, [{ id: 7, name: "JustWritten" }]);
    });
    check("native mutation syntax is rejected and the writer remains usable", () => {
      for (const tql of [
        'CREATE (n {name: "forbidden"})',
        'MATCH (n) SET n.name == "changed"',
        "MATCH (n) DELETE n",
        "MATCH (n) DETACH DELETE n",
        'MATCH (n) RETURN n; CREATE (m {name: "forbidden"})',
      ]) rejects(() => executeLiveTql(db, { tql }), 400, "TDB_QUERY_PARSE");
      assert.equal(facts(db), before);
      assert.equal(db.nodeCount(), 7);
    });
    check("unsupported request fields and invalid limits, deadlines and params fail explicitly", () => {
      const tql = "MATCH (n) RETURN n.id AS id";
      const circular = {}; circular.self = circular;
      for (const body of [
        null, [], {}, { tql: " " }, { tql: 5 }, { tql, kind: "nodes" }, { tql, query: "other" },
        { tql, operation: "mutate" }, { tql, params: [] }, { tql, params: null },
        { tql, params: { x: undefined } }, { tql, params: { x: NaN } },
        { tql, params: { x: Infinity } }, { tql, params: { x() {} } },
        { tql, params: { x: new Date() } }, { tql, params: circular },
        { tql, limit: 0 }, { tql, limit: 1001 }, { tql, limit: 1.5 }, { tql, limit: "1" },
        { tql, timeoutMs: 0 }, { tql, timeoutMs: 51 }, { tql, timeoutMs: 1.5 }, { tql, timeoutMs: "5" },
        JSON.parse('{"tql":"MATCH (n) RETURN n","__proto__":{}}'),
      ]) rejects(() => executeLiveTql(db, body), 400, "LIVE_TQL_INVALID_INPUT");
      const max = executeLiveTql(db, { tql, limit: 1000, timeoutMs: 50 });
      assert.equal(max.limit, 1000);
      assert.equal(max.timeoutMs, 50);
    });
    check("the entire JSON request has an inclusive 16 KiB byte cap", () => {
      const base = "MATCH (n) WHERE n.id == 1 RETURN n.id AS id";
      const spare = LIVE_TQL_REQUEST_BYTES - Buffer.byteLength(JSON.stringify({ tql: base }));
      const exact = { tql: base + " ".repeat(spare), timeoutMs: 50 };
      // The optional timeout also belongs to the cap.
      exact.tql = exact.tql.slice(0, exact.tql.length - (Buffer.byteLength(JSON.stringify(exact)) - LIVE_TQL_REQUEST_BYTES));
      assert.equal(Buffer.byteLength(JSON.stringify(exact)), LIVE_TQL_REQUEST_BYTES);
      assert.deepEqual(executeLiveTql(db, exact).rows, [{ id: 1 }]);
      rejects(() => executeLiveTql(db, { ...exact, tql: exact.tql + " " }), 413, "LIVE_TQL_REQUEST_TOO_LARGE");
    });
    check("read execution and rejected requests leave all facts and edges unchanged", () => {
      assert.equal(facts(db), before);
    });
    check("missing and closed writers return explicit availability errors", () => {
      rejects(() => executeLiveTql(null, { tql: "MATCH (n) RETURN n" }), 409, "LIVE_TQL_UNAVAILABLE");
      const closed = open("closed"); closed.close();
      rejects(() => executeLiveTql(closed, { tql: "MATCH (n) RETURN n" }), 409, "TDB_DATABASE_CLOSED");
    });

    const large = open("large");
    for (let id = 1; id <= 2000; id++) large.insertWithId(id, [1, 0], { type: "entity", name: `node-${id}`, rank: id });
    check("native lookahead avoids the default row budget for a 2000-row unpaged read", () => {
      const result = executeLiveTql(large, { tql: "MATCH (n) RETURN n.id AS id", limit: 1, timeoutMs: 50 });
      assert.deepEqual(result.rows, [{ id: 1 }]);
      assert.equal(result.truncated, true);
    });
    check("a store over 1000 nodes has no admission gate and still supports bound point reads", () => {
      const result = executeLiveTql(large, {
        tql: "MATCH (n) WHERE n.name == $name RETURN n.id AS id",
        params: { name: "node-1100" },
        timeoutMs: 50,
      });
      assert.deepEqual(result.rows, [{ id: 1100 }]);
    });
    check("explicit native LIMIT cannot bypass the client's maximum 1000 returned rows", () => {
      const result = executeLiveTql(large, { tql: "MATCH (n) RETURN n.id AS id LIMIT 2000", limit: 1000, timeoutMs: 50 });
      assert.equal(result.rows.length, 1000);
      assert.equal(result.truncated, true);
    });
    check("a large full-input aggregate fails its native budget instead of returning a partial count", () => {
      rejects(() => executeLiveTql(large, {
        tql: "MATCH (n) RETURN COUNT(*) AS total LIMIT 1", limit: 1, timeoutMs: 50,
      }), 422, "TDB_QUERY_BUDGET");
      const result = executeLiveTql(large, {
        tql: "MATCH (n) WHERE n.rank > $min RETURN n.id AS id ORDER BY id DESC",
        params: { min: 1997 }, limit: 1, timeoutMs: 50,
      });
      assert.deepEqual(result.rows, [{ id: 2000 }]);
    });
    check("the native cooperative deadline is surfaced as an HTTP timeout", () => {
      const condition = Array.from({ length: 120 }, (_, index) => `n.rank == ${10000 + index}`).join(" OR ");
      assert.throws(() => executeLiveTql(large, { tql: `MATCH (n) WHERE ${condition} RETURN n.id AS id`, timeoutMs: 1 }),
        (error) => error.status === 408 && ["TDB_QUERY_CANCELLED", "LIVE_TQL_TIMEOUT"].includes(error.code));
    });
    check("completion checks reject a late synchronous result without pretending to interrupt it", () => {
      let returned = false;
      const slow = {
        prepareTql() {},
        consoleRequest() {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          returned = true;
          return JSON.stringify({ version: 1, requestId: "live-tql", data: { rows: [], columns: [], rowCount: 0 } });
        },
      };
      rejects(() => executeLiveTql(slow, { tql: "MATCH (n) RETURN n", timeoutMs: 1 }), 408, "LIVE_TQL_TIMEOUT");
      assert.equal(returned, true, "the completion check runs after the synchronous operation returns");
    });
    check("native preparation time belongs to the total deadline", () => {
      let executed = false;
      const slowPrepare = {
        prepareTql() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); },
        consoleRequest() { executed = true; },
      };
      rejects(() => executeLiveTql(slowPrepare, { tql: "MATCH (n) RETURN n", timeoutMs: 1 }), 408, "LIVE_TQL_TIMEOUT");
      assert.equal(executed, false);
    });
    check("only a candidate parse failure may fall back, not resource or closed-instance errors", () => {
      for (const [code, status] of [["QueueFull", 429], ["TDB_DATABASE_CLOSED", 409]]) {
        let preparations = 0, executed = false;
        const unavailable = {
          prepareTql() { if (++preparations === 2) throw Object.assign(new Error(code), { code }); },
          consoleRequest() { executed = true; },
        };
        rejects(() => executeLiveTql(unavailable, { tql: "MATCH (n) RETURN n", timeoutMs: 50 }), status, code);
        assert.equal(executed, false);
      }
    });
    check("response-size retries are finite and other native errors are never retried", () => {
      for (const [code, status] of [["TDB_CONSOLE_RESPONSE_TOO_LARGE", 413], ["QueueFull", 429]]) {
        let executions = 0;
        const refused = {
          prepareTql() {},
          consoleRequest() { executions++; throw Object.assign(new Error(code), { code }); },
        };
        rejects(() => executeLiveTql(refused, { tql: "MATCH (n) RETURN n", limit: 1000, timeoutMs: 50 }), status, code);
        assert.ok(executions >= 1 && executions <= 6);
        if (code !== "TDB_CONSOLE_RESPONSE_TOO_LARGE") assert.equal(executions, 1);
      }
    });
    check("wide 585-node, 1536-dimension Issue JOIN works for small and default display limits", () => {
      const wide = open("wide", { dim: 1536 });
      const vector = new Array(1536).fill(0); vector[0] = 1;
      const hubs = [];
      for (let i = 0; i < 17; i++) hubs.push(wide.insert(vector, { type: "entity", name: `hub-${i}` }));
      for (let i = 0; i < 568; i++) {
        const id = wide.insert(vector, { type: "decision", name: `memory-${i}` });
        wide.link(id, hubs[i % hubs.length], "about");
      }
      const tql = "MATCH (n)-[:about]->(hub) RETURN n, hub";
      const expected = reference(wide, tql).rows;
      assert.equal(expected.length, 568);
      const small = executeLiveTql(wide, { tql, limit: 1, timeoutMs: 50 });
      assert.deepEqual(small.rows, expected.slice(0, 1));
      assert.equal(small.truncated, true);
      const usual = executeLiveTql(wide, { tql, limit: 200 });
      assert.ok(usual.rowCount > 0 && usual.rowCount <= 200);
      assert.deepEqual(usual.rows, expected.slice(0, usual.rowCount));
      assert.equal(usual.limit, 200);
      assert.equal(usual.truncated, true);
      assert.equal(usual.truncationReason, "response-byte-budget");
      const bytes = Buffer.byteLength(JSON.stringify(usual));
      assert.ok(bytes <= LIVE_TQL_RESPONSE_BYTES);
      console.log(`wide Issue JOIN: ${usual.rowCount} returned rows, ${bytes} bytes, limit ${usual.limit}`);
      assert.equal(wide.nodeCount(), 585);
    });

    check("native encoded-response budgeting rejects oversize results before any client slice", () => {
      const big = open("big-response");
      big.insertWithId(1, [1, 0], { type: "entity", text: "x".repeat(300000) });
      big.insertWithId(2, [1, 0], { type: "entity", text: "y".repeat(300000) });
      rejects(() => executeLiveTql(big, {
        tql: "MATCH (n) RETURN n.text AS text LIMIT 100", limit: 1, timeoutMs: 50,
      }), 413, "TDB_CONSOLE_RESPONSE_TOO_LARGE");
      const single = executeLiveTql(big, {
        tql: "MATCH (n) WHERE n.id == 1 RETURN n.text AS text", limit: 1, timeoutMs: 50,
      });
      assert.equal(single.rows[0].text.length, 300000);
      assert.ok(Buffer.byteLength(JSON.stringify(single)) <= LIVE_TQL_RESPONSE_BYTES);
      assert.equal(big.nodeCount(), 2);
    });
  } finally {
    for (const db of handles) { try { db.close(); } catch { /* already closed */ } }
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) rmSync(root, { recursive: true, force: true });
  }

  console.log(`\nP97: ${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}

// Entity-search backend: consolidated correctness and HTTP protocol checks.
{
  const { default: assert } = await import("node:assert/strict");
  const { default: http } = await import("node:http");
  const { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve, relative, isAbsolute, sep } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { default: engine } = await import("triviumdb");
  const root = mkdtempSync(join(tmpdir(), "dsh-entity-search-"));
  process.env.DSH_HOME = join(root, "home"); process.env.DSH_TRIVIUM_SETTINGS = join(root, "settings.json");
  const store = await import("../lib/store.js"), embed = await import("../lib/embed.js");
  const { searchEntity, validateEntitySearch, entityQueryEmbedding } = await import("../lib/entity-search.js");
  const { searchEntitySnapshot } = await import("../lib/entity-search-snapshot.js");
  const { createReadSnapshot } = await import("../lib/read-snapshots.js");
  const { registerMemoryApi } = await import("../lib/server.js");
  const { readUiSettings } = await import("../lib/settings.js");
  const unit = axis => Array.from({length:1536},(_,i)=>i===axis?1:0), zero=Array(1536).fill(0);
  const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}};
  const ids=rows=>rows.map(row=>Number(row.id));
  const errorIs=(status,code)=>error=>error.status===status&&(!code||error.code===code);
  let checks=0,server,db;const nativeHandles=[];const cwd=join(root,"A");
  const check=async(label,fn)=>{await fn();checks++;console.log("ok entity-search "+label)};
  const vectorReply=async()=>({status:"ran",vector:unit(0),calls:1});
  try{
    embed.setTestEmbed(null);embed.configureEmbedding({embeddingEnabled:false,embeddingApiKey:""});
    db=await store.openWorkspaceDb(cwd);
    for(const[id,type,name,text,extra]of[
      [101,"entity","ServiceA","Authentication service"],[102,"entity","ServiceB","Other service"],[103,"entity","Empty",""],
      [201,"decision","Retry","Retry three times."],[202,"decision","Other retry","Retry five times."],
      [203,"preference","Audit","Retain audit records."],[204,"decision","Archived","Archived retry",{status:"archived"}],
      [205,"decision","Expired","Expired retry",{untilAt:"2020-01-01T00:00:00Z"}],
      [206,"decision","Old policy","Old checkpoint."],[207,"decision","Current policy","New checkpoint."],
      [208,"decision","Old archive","Old release archive."],[209,"decision","New archive","Replacement archive outside scope."],
      [210,"decision","Existing plan","Manual approval."],[211,"decision","Proposed plan","Automatic approval.",{review:"supersede-proposed"}],
      [212,"decision","Loose retry","Retry retry retry three times."]])db.insertWithId(id,id===103?zero:unit(id===202?1:0),{type,name,text,status:"active",createdAt:"2026-11-01T00:00:00Z",...extra});
    for(const id of[201,203,204,205,206,207,208,210,211])db.link(id,101,"about",1);
    db.link(202,102,"about",1);db.link(203,102,"fixed",1);db.link(212,101,"in_workspace",1);db.link(212,103,"from_session",1);
    db.link(207,206,"supersedes",1);db.link(209,208,"supersedes",1);db.flush();
    const disk=()=>Object.fromEntries(readdirSync(join(cwd,".dsh")).filter(n=>n.startsWith("trivium.tdb")&&!n.endsWith(".lock")).map(n=>[n,createHash("sha256").update(readFileSync(join(cwd,".dsh",n))).digest("hex")]));
    const before=disk();
    await check("strict input and opt-in",async()=>{
      for(const body of[null,[],{},{entityId:"101",query:"retry"},{entityId:0,query:"retry"},{entityId:101,query:""},{entityId:101,query:"x".repeat(4097)},
        {entityId:101,query:"x",limit:0},{entityId:101,query:"x",semantic:"true"},{entityId:101,query:"x",budget:99999},{entityId:101,query:"x",depth:2}])assert.throws(()=>validateEntitySearch(body),errorIs(400));
      let calls=0;const r=await searchEntity(db,{entityId:101,query:"retry"},{embedding:async()=>{calls++;return vectorReply()}});
      assert.equal(calls,0);assert.equal(r.channels.semantic.status,"not_requested");assert.deepEqual(ids(r.textCandidates),[201]);
    });
    await check("one-hop current scope, gaps, proposals and typed channels",async()=>{
      const r=await searchEntity(db,{entityId:101,query:"retry",semantic:true,limit:20},{embedding:vectorReply});
      assert.equal(r.scope.eligibleCount,6);assert.equal(r.scope.complete,true);assert.equal(r.expanded,false);assert.equal(r.answerability,"not_assessed");
      assert.deepEqual(ids(r.semanticCandidates).sort((a,b)=>a-b),[101,201,203,207,210,211]);
      assert.ok(r.warnings.some(w=>w.matchedId==="208"&&w.currentId==="209"));assert.equal(r.semanticCandidates.find(x=>x.id==="211").review,"supersede-proposed");
      for(const row of[...r.textCandidates,...r.semanticCandidates])assert.ok(row.path.nodes.includes(row.id));
      assert.equal(r.textCandidates[0].scoreKind,"lexical");assert.equal(r.semanticCandidates[0].scoreKind,"cosine");
      const clipped=await searchEntity(db,{entityId:101,query:"retry",semantic:true,limit:1},{embedding:vectorReply});
      assert.equal(clipped.channels.semantic.truncated,true);assert.equal(clipped.channels.text.truncated,false);assert.ok(!Object.hasOwn(clipped,"rows"));
    });
    await check("provider disabled, exceptions and invalid native vectors degrade",async()=>{
      assert.equal((await searchEntity(db,{entityId:101,query:"retry",semantic:true})).channels.semantic.status,"disabled");
      for(const vector of[[1,2],zero,Array(1536).fill(NaN),Array(1536).fill(1e300),Array(1536).fill(1e-300)]){
        const r=await searchEntity(db,{entityId:101,query:"retry",semantic:true},{embedding:async()=>({status:"ran",vector,calls:1})});
        assert.equal(r.degraded,true);assert.deepEqual(ids(r.textCandidates),[201]);assert.deepEqual(r.semanticCandidates,[]);
      }
      const r=await searchEntity(db,{entityId:101,query:"retry",semantic:true},{embedding:async()=>{throw Error("provider failed")}});
      assert.equal(r.channels.semantic.status,"failed");assert.deepEqual(ids(r.textCandidates),[201]);
    });
    await check("module-level config binding begins before provider scheduling",async()=>{
      let calls=0;embed.setTestEmbed(async()=>{calls++;return unit(0)});
      const pending=searchEntity(db,{entityId:101,query:"retry",semantic:true});embed.configureEmbedding({embeddingModel:"new-before-provider"});
      try{await assert.rejects(()=>pending,errorIs(409,"ENTITY_SEARCH_EMBEDDING_CHANGED"));assert.equal(calls,0)}finally{embed.setTestEmbed(null);embed.configureEmbedding({embeddingEnabled:false,embeddingApiKey:""})}
    });
    await check("anchor-only and invalid anchors spend no provider calls",async()=>{
      let calls=0;const options={embedding:async()=>{calls++;return vectorReply()}};
      const r=await searchEntity(db,{entityId:103,query:"retry",semantic:true},options);assert.equal(r.state,"scope_anchor_only");assert.equal(r.channels.semantic.status,"skipped");
      await assert.rejects(()=>searchEntity(db,{entityId:999,query:"retry",semantic:true},options),errorIs(404));
      await assert.rejects(()=>searchEntity(db,{entityId:201,query:"retry",semantic:true},options),errorIs(400));assert.equal(calls,0);
    });
    await check("shared nodes, edges, payload, CPU and response budgets",async()=>{
      for(const limits of[{nodes:1},{edges:1},{payloadBytes:20}])await assert.rejects(()=>searchEntity(db,{entityId:101,query:"retry"},{limits}),e=>errorIs(422)(e)&&Boolean(e.work));
      await assert.rejects(()=>searchEntity(db,{entityId:101,query:"retry"},{limits:{responseBytes:200}}),errorIs(413));
      let time=0;const original=db.getPayload;try{db.getPayload=id=>{time+=100;return original.call(db,id)};
        await assert.rejects(()=>searchEntity(db,{entityId:101,query:"retry"},{clock:()=>time}),errorIs(408));}finally{db.getPayload=original}
    });
    await check("provider timeout preserves lexical results",async()=>{
      const r=await searchEntity(db,{entityId:101,query:"retry",semantic:true},{remainingMs:500,embedding:async()=>new Promise(()=>{})});
      assert.equal(r.channels.semantic.status,"timeout");assert.equal(r.degraded,true);assert.deepEqual(ids(r.textCandidates),[201]);
    });
    await check("successful queries preserve persisted bytes",async()=>assert.deepEqual(disk(),before));
    const mutated=async mutate=>{
      const entered=deferred(),reply=deferred();const pending=searchEntity(db,{entityId:101,query:"retry",semantic:true},{embedding:async()=>{entered.resolve();return reply.promise}});
      await entered.promise;const restore=mutate();reply.resolve({status:"ran",vector:unit(0),calls:1});
      try{await assert.rejects(()=>pending,errorIs(409,"ENTITY_SEARCH_SCOPE_CHANGED"))}finally{restore()}
    };
    await check("changed body rejects late semantic results",async()=>mutated(()=>{const old=db.getPayload(201);db.updatePayload(201,{...old,text:"Retry seven times."});return()=>db.updatePayload(201,old)}));
    await check("removed business edge rejects late semantic results",async()=>mutated(()=>{db.unlink(201,101,"about");return()=>db.link(201,101,"about",1)}));
    await check("new business membership rejects late semantic results",async()=>mutated(()=>{db.link(212,101,"fixed",1);return()=>db.unlink(212,101,"fixed")}));
    await check("entity deletion during embedding is a conflict, not a fresh missing-entity lookup",async()=>mutated(()=>{
      const old=db.get(101),incoming=db.getIncomingEdges(101);db.delete(101);
      return()=>{db.insertWithId(101,old.vector,old.payload);for(const edge of incoming)db.link(edge.sourceId,101,edge.label,edge.weight)};
    }));
    await check("deleted/reused IDs cannot restore earlier identity",async()=>mutated(()=>{
      const old=db.get(201);db.delete(201);db.insertWithId(201,old.vector,{...old.payload,text:"New identity",createdAt:"2026-11-12T01:00:00Z"});db.link(201,101,"about",1);
      return()=>{db.delete(201);db.insertWithId(201,old.vector,old.payload);db.link(201,101,"about",1)};
    }));
    await check("replacement binding rejects in-flight result",async()=>{
      let current=true;const entered=deferred(),reply=deferred();const pending=searchEntity(db,{entityId:101,query:"retry",semantic:true},{isCurrent:()=>current,embedding:async()=>{entered.resolve();return reply.promise}});
      await entered.promise;current=false;reply.resolve({status:"ran",vector:unit(0),calls:1});await assert.rejects(()=>pending,errorIs(409,"ENTITY_SEARCH_SOURCE_CHANGED"));
    });
    await check("cancel settles a provider ignoring its signal",async()=>{
      const controller=new AbortController(),entered=deferred();const pending=searchEntity(db,{entityId:101,query:"retry",semantic:true},{signal:controller.signal,embedding:async()=>{entered.resolve();return new Promise(()=>{})}});
      await entered.promise;controller.abort();await assert.rejects(()=>pending,errorIs(499));
    });
    await check("unrelated edits preserve an unchanged scope",async()=>{
      const entered=deferred(),reply=deferred(),old=db.getPayload(202);const pending=searchEntity(db,{entityId:101,query:"retry",semantic:true},{embedding:async()=>{entered.resolve();return reply.promise}});
      await entered.promise;db.updatePayload(202,{...old,text:"Unrelated edit"});reply.resolve({status:"ran",vector:unit(0),calls:1});
      try{assert.deepEqual(ids((await pending).textCandidates),[201])}finally{db.updatePayload(202,old)}
    });
    await check("expiry during embedding changes live scope but snapshot time stays fixed",async()=>{
      const old=db.getPayload(201);db.updatePayload(201,{...old,untilAt:"2026-11-12T00:00:01Z"});
      let at=new Date("2026-11-12T00:00:00Z");const entered=deferred(),reply=deferred();
      const pending=searchEntity(db,{entityId:101,query:"retry",semantic:true},{timeNow:()=>at,embedding:async()=>{entered.resolve();return reply.promise}});
      await entered.promise;at=new Date("2026-11-12T00:00:02Z");reply.resolve({status:"ran",vector:unit(0),calls:1});
      try{await assert.rejects(()=>pending,errorIs(409,"ENTITY_SEARCH_SCOPE_CHANGED"));const historical=await searchEntity(db,{entityId:101,query:"retry"},{source:"snapshot",asOf:"2026-11-12T00:00:00Z"});assert.deepEqual(ids(historical.textCandidates),[201])}finally{db.updatePayload(201,old)}
    });
    await check("revision self-cycle fails closed",async()=>{
      db.link(201,201,"supersedes",1);try{await assert.rejects(()=>searchEntity(db,{entityId:101,query:"retry"}),errorIs(422,"ENTITY_SEARCH_REVISION_INVALID"))}finally{db.unlink(201,201,"supersedes")}
    });
    await check("large store uses only bounded payload and native relationships",async()=>{
      const large=new engine.TriviumDB(join(root,"large.tdb"),{dim:1536,autoBuildQuiver:false});nativeHandles.push(large);
      large.insertWithId(1,zero,{type:"entity",name:"Hub"});for(let id=2;id<=1200;id++)large.insertWithId(id,unit(0),{type:"decision",text:"Retry fact"});large.link(2,1,"about",1);
      large.get=()=>{throw Error("vector materialization")};large.allNodeIds=()=>{throw Error("full scan")};assert.deepEqual(ids((await searchEntity(large,{entityId:1,query:"retry"})).textCandidates),[2]);
    });
    const snapshot=createReadSnapshot(db,cwd);
    await check("snapshot returns captured time and separate candidates",async()=>{
      const r=await searchEntitySnapshot(cwd,snapshot.snapshotId,{entityId:101,query:"retry",semantic:true},{embedding:vectorReply});
      assert.equal(r.source,"snapshot");assert.equal(r.asOf,snapshot.createdAt);assert.equal(r.generationId,snapshot.generationId);assert.deepEqual(ids(r.textCandidates),[201]);assert.ok(ids(r.semanticCandidates).includes(201));
    });
    await check("latest snapshot stays pinned across live edits and recapture",async()=>{
      const entered=deferred(),reply=deferred(),old=db.getPayload(201);const pending=searchEntitySnapshot(cwd,"latest",{entityId:101,query:"retry",semantic:true},{embedding:async()=>{entered.resolve();return reply.promise}});
      await entered.promise;db.updatePayload(201,{...old,text:"Retry nine times."});db.flush();createReadSnapshot(db,cwd);reply.resolve({status:"ran",vector:unit(0),calls:1});
      try{const r=await pending;assert.equal(r.snapshotId,snapshot.snapshotId);assert.equal(r.textCandidates[0].text,old.text)}finally{db.updatePayload(201,old);db.flush()}
    });
    await check("snapshot wall deadline kills before provider",async()=>{
      let calls=0;await assert.rejects(()=>searchEntitySnapshot(cwd,snapshot.snapshotId,{entityId:101,query:"retry",semantic:true},{remainingMs:1,embedding:async()=>{calls++;return vectorReply()}}),errorIs(408));assert.equal(calls,0);
    });
    await check("snapshot cancellation aborts its provider and releases the worker",async()=>{
      const entered=deferred(),reply=deferred(),controller=new AbortController();let providerSignal;
      const pending=searchEntitySnapshot(cwd,snapshot.snapshotId,{entityId:101,query:"retry",semantic:true},{signal:controller.signal,embedding:async(_query,context)=>{providerSignal=context.signal;entered.resolve();return reply.promise}});
      await entered.promise;controller.abort();await assert.rejects(()=>pending,errorIs(499));assert.equal(providerSignal.aborted,true);reply.resolve({status:"ran",vector:unit(0),calls:1});
      const next=await searchEntitySnapshot(cwd,snapshot.snapshotId,{entityId:101,query:"retry"});assert.deepEqual(ids(next.textCandidates),[201]);
    });
    await check("corrupt artifact refuses provider work",async()=>{
      const broken=createReadSnapshot(db,cwd);writeFileSync(join(broken.directory,"database.tdb.manifest.json"),"broken");let calls=0;
      await assert.rejects(()=>searchEntitySnapshot(cwd,broken.snapshotId,{entityId:101,query:"retry",semantic:true},{embedding:async()=>{calls++;return vectorReply()}}));assert.equal(calls,0);
    });
    await check("snapshot UTF-8 crosses pipe chunk boundaries intact",async()=>{
      const old=db.getPayload(201),text="中文".repeat(20000);db.updatePayload(201,{...old,text});db.flush();const s=createReadSnapshot(db,cwd);
      try{const r=await searchEntitySnapshot(cwd,s.snapshotId,{entityId:101,query:"中文",limit:1});assert.equal(r.textCandidates[0].text,text)}finally{db.updatePayload(201,old);db.flush()}
    });
    let handler;registerMemoryApi({webServer:{register(entry){handler=entry.handler;return()=>{}}}},{liveOptions:readUiSettings,status:{}});
    server=http.createServer((req,res)=>handler(req,res));await new Promise(done=>server.listen(0,"127.0.0.1",done));
    const base=`http://127.0.0.1:${server.address().port}/api/dsh-trivium`;
    const request=async(body,mode="",options={})=>{const response=await fetch(base+"/entity-search"+(mode==="no-cwd"?"":"?cwd="+encodeURIComponent(cwd)),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),...options});return{status:response.status,body:await response.json()}};
    await check("HTTP explicit workspace, body schema and no lazy open",async()=>{
      assert.equal((await request({entityId:101,query:"retry"},"no-cwd")).status,400);assert.equal((await request({entityId:101,query:"retry",scope:"global"})).status,400);
      const response=await fetch(base+"/entity-search?cwd="+encodeURIComponent(join(root,"unopened")),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({entityId:101,query:"retry"})});assert.equal(response.status,409);assert.equal(existsSync(join(root,"unopened")),false);
      const r=await request({entityId:101,query:"retry"});assert.equal(r.status,200);assert.equal(r.body.cwd,resolve(cwd));
    });
    await check("HTTP disabled semantic mode clearly degrades",async()=>{const r=await request({entityId:101,query:"retry",semantic:true});assert.equal(r.status,200);assert.equal(r.body.degraded,true);assert.equal(r.body.channels.semantic.status,"disabled")});
    await check("HTTP active-workspace change cannot redirect explicit request",async()=>{
      const other=await store.openWorkspaceDb(join(root,"B"));other.insertWithId(101,zero,{type:"entity",name:"PrivateB"});
      const entered=deferred(),reply=deferred();embed.setTestEmbed(async()=>{entered.resolve();return reply.promise});const pending=request({entityId:101,query:"retry",semantic:true});
      await entered.promise;store.setActiveCwd(join(root,"B"));reply.resolve(unit(0));try{const r=await pending;assert.equal(r.status,200);assert.equal(r.body.scope.name,"ServiceA");assert.equal(JSON.stringify(r.body).includes("PrivateB"),false)}finally{embed.setTestEmbed(null);store.setActiveCwd(cwd)}
    });
    await check("HTTP concurrent edit returns 409 without partial candidates",async()=>{
      const entered=deferred(),reply=deferred(),old=db.getPayload(201);embed.setTestEmbed(async()=>{entered.resolve();return reply.promise});const pending=request({entityId:101,query:"retry",semantic:true});
      await entered.promise;db.updatePayload(201,{...old,text:"Concurrent body"});reply.resolve(unit(0));try{const r=await pending;assert.equal(r.status,409);assert.equal(r.body.code,"ENTITY_SEARCH_SCOPE_CHANGED");assert.ok(!Object.hasOwn(r.body,"textCandidates"))}finally{embed.setTestEmbed(null);db.updatePayload(201,old)}
    });
    await check("HTTP configuration switch invalidates query vector",async()=>{
      const entered=deferred(),reply=deferred();embed.setTestEmbed(async()=>{entered.resolve();return reply.promise});const pending=request({entityId:101,query:"retry",semantic:true});
      await entered.promise;embed.configureEmbedding({embeddingModel:"changed"});reply.resolve(unit(0));const r=await pending;assert.equal(r.status,409);assert.equal(r.body.code,"ENTITY_SEARCH_EMBEDDING_CHANGED");embed.setTestEmbed(null);
    });
    await check("HTTP snapshot broker returns pinned channels through the real transport",async()=>{
      let calls=0;embed.setTestEmbed(async()=>{calls++;return unit(0)});
      try{const r=await request({entityId:101,query:"retry",semantic:true,snapshotId:snapshot.snapshotId});assert.equal(r.status,200);assert.equal(r.body.snapshotId,snapshot.snapshotId);assert.equal(r.body.asOf,snapshot.createdAt);assert.ok(ids(r.body.semanticCandidates).includes(201));assert.equal(calls,1)}finally{embed.setTestEmbed(null)}
    });
    await check("HTTP cancellation releases bounded admission",async()=>{
      const entered=deferred(),reply=deferred();embed.setTestEmbed(async()=>{entered.resolve();return reply.promise});const controller=new AbortController();const pending=request({entityId:101,query:"retry",semantic:true},"",{signal:controller.signal}).catch(e=>e);
      await entered.promise;assert.equal((await request({entityId:101,query:"retry"})).status,429);controller.abort();await pending;reply.resolve(unit(0));
      let next;for(let i=0;i<30;i++){await new Promise(done=>setImmediate(done));next=await request({entityId:101,query:"retry"});if(next.status!==429)break}assert.equal(next.status,200);embed.setTestEmbed(null);
    });
    await check("HTTP origin fence is retained",async()=>{const r=await fetch(base+"/entity-search?cwd="+encodeURIComponent(cwd),{method:"POST",headers:{"content-type":"application/json",origin:"https://foreign.invalid"},body:JSON.stringify({entityId:101,query:"retry"})});assert.equal(r.status,403)});
    await check("actual provider failures, response byte limit and cancellation are bounded",async()=>{
      let mode="error";const entered=deferred(),disconnected=deferred();
      const provider=http.createServer((req,res)=>{req.resume();if(mode==="hang"){entered.resolve();res.once("close",()=>disconnected.resolve());return}res.writeHead(mode==="error"?503:200,{"content-type":"application/json"});res.end(mode==="large"?JSON.stringify({padding:"x".repeat(100000),data:[{embedding:unit(0)}]}):JSON.stringify({data:[{embedding:[1,2]}]}))});
      await new Promise(done=>provider.listen(0,"127.0.0.1",done));const endpoint=`http://127.0.0.1:${provider.address().port}/v1/embeddings`;
      const settings=existsSync(process.env.DSH_TRIVIUM_SETTINGS)?readFileSync(process.env.DSH_TRIVIUM_SETTINGS,"utf8"):"{}";
      writeFileSync(process.env.DSH_TRIVIUM_SETTINGS,JSON.stringify({embeddingEnabled:true,embeddingUrl:endpoint,embeddingApiKey:"",embeddingModel:"controlled"}));
      try{
        for(mode of["error","invalid","large"]){const r=await request({entityId:101,query:"retry",semantic:true});assert.equal(r.status,200);assert.equal(r.body.degraded,true);assert.deepEqual(ids(r.body.textCandidates),[201]);assert.equal(r.body.channels.semantic.status,"failed")}
        mode="hang";const controller=new AbortController();const pending=request({entityId:101,query:"retry",semantic:true},"",{signal:controller.signal}).catch(e=>e);await entered.promise;controller.abort();await pending;
        await Promise.race([disconnected.promise,new Promise((_,reject)=>setTimeout(()=>reject(Error("provider connection was not aborted")),1000))]);
        let next;for(let i=0;i<30;i++){next=await request({entityId:101,query:"retry"});if(next.status===200)break;await new Promise(done=>setImmediate(done))}assert.equal(next.status,200);
        const timed=await entityQueryEmbedding("retry",{timeoutMs:30});assert.equal(timed.status,"timeout");
      }finally{provider.closeAllConnections();await new Promise(done=>provider.close(done));writeFileSync(process.env.DSH_TRIVIUM_SETTINGS,settings);embed.configureEmbedding({embeddingEnabled:false,embeddingApiKey:""})}
    });
    await check("HTTP close and reopen rejects the old handle",async()=>{
      const entered=deferred(),reply=deferred();embed.setTestEmbed(async()=>{entered.resolve();return reply.promise});const pending=request({entityId:101,query:"retry",semantic:true});
      await entered.promise;store.closeAll();db=await store.openWorkspaceDb(cwd);reply.resolve(unit(0));const r=await pending;assert.equal(r.status,409);embed.setTestEmbed(null);
    });
  }finally{
    embed.setTestEmbed(null);embed.configureEmbedding({embeddingEnabled:false,embeddingApiKey:""});if(server)await new Promise(done=>server.close(done));
    store.closeAll();for(const handle of nativeHandles){try{handle.close()}catch{}}
    const rel=relative(resolve(tmpdir()),resolve(root));if(rel&&rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel))rmSync(root,{recursive:true,force:true});
  }
  console.log(`Entity search: ${checks}/${checks} contract checks`);
}
