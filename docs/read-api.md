# Read queries while the host owns the writer

Source implementation for issue #5; not yet part of a published npm release.

The host remains the single writer. Live queries borrow its already-open
instance; external analysis uses an independently captured snapshot. Both paths
report their source. These APIs do not invoke a model or an embedding service.

## Live HTTP queries

Use the existing host port and a URL-encoded workspace path. The workspace must
already be open in this host; an unknown or unopened path returns
`409 WORKSPACE_NOT_OPEN` without creating or synchronizing a database. The
existing loopback and write-request origin checks also apply to these endpoints.

```http
POST /api/dsh-trivium/query?cwd=<URL-encoded-workspace>
Content-Type: application/json

{"kind":"nodes","type":"entity","limit":200}
```

Other named queries:

```json
{"kind":"nodes","name":"AuthGateway","limit":20}
```

```json
{"kind":"neighbors","id":42,"direction":"both","label":"about","limit":100}
```

```json
{"kind":"orphanEntities","limit":200}
```

`nodes` accepts exact `type` and `name` filters. `neighbors` examines one hop;
`direction` is `both` (default), `incoming` or `outgoing`. Its optional `label`
is one of `about`, `decided`, `broke`, `fixed`. `orphanEntities` finds entities
without a business edge in either direction; workspace/session bookkeeping
edges do not prevent an entity from being reported as an orphan.

Live requests accept no arbitrary TQL. Node IDs are positive safe integers on
input. Rows contain node summaries, with decimal-string IDs; they omit vectors.
Success returns `ok`, `source: "live"`, `kind`, `rows`, `limit`, and `truncated`.
The default result limit is 200, maximum 1000. A result limit is separate from
execution work limits: a live workspace above 1000 nodes, or an exhausted graph
work budget, returns a budget error and should be audited through a snapshot.
It never presents an incomplete orphan scan as a complete result.

Request bodies are limited to 16 KiB and a 2-second body-read deadline.
Admission allows at most two requests globally and one per workspace; excess
work receives `429 READ_BUSY`. Native live-query deadlines are cooperative:
they do not provide hard real-time interruption of Node's synchronous binding.
Replies are bounded to 512 KiB. Invalid fields and operations are rejected.

## Capturing a stable snapshot

```http
POST /api/dsh-trivium/snapshots?cwd=<URL-encoded-workspace>
Content-Type: application/json

{}
```

The host generates the destination and generation ID, takes the workspace
operation lock, calls `createSnapshot()`, verifies the result, and publishes its
metadata and latest pointer. A busy writer operation returns
`409 WORKSPACE_WRITE_BUSY`; retry later. Capture is synchronous maintenance work
and may briefly pause host requests while it copies the file group.

Success identifies `snapshotId`, `generationId`, `directory`, `createdAt`,
`nodeCount`, `dim` and `dtype`. Files live under
`<workspace>/.dsh/read-snapshots/`. `GET /api/dsh-trivium/snapshots?cwd=...`
returns the latest publication; add `snapshotId=...` for a specific generation.
The HTTP path still requires this workspace to be open in the host.
This GET reads publication metadata, with `integrity: "verified-at-capture"`;
it does not recompute file CRCs or certify that external tools have left the
files intact. Each actual snapshot query verifies the file group in its worker
and rejects a missing, incomplete or damaged artifact before executing TQL.

The snapshot reflects the capture time and remains readable after source writes
and host shutdown. It copies files and consumes disk space. Capture is explicit;
there is no background timer or automatic deletion. Keep published generation
directories immutable, retain snapshots while readers use them, and remove
unneeded generations only after those readers exit. Removing a latest snapshot
requires capturing another generation or removing its now-stale latest pointer.
A missing, incomplete or invalid artifact is an error when queried or checked,
never a silent fallback to the live database. Publishing a manifest on mutable
live files is not used.

## Arbitrary read TQL on a snapshot

```http
POST /api/dsh-trivium/query?cwd=<URL-encoded-workspace>
Content-Type: application/json

{"snapshotId":"latest","tql":"MATCH (n) WHERE n.name == $name RETURN n","params":{"name":"AuthGateway"},"limit":200,"timeoutMs":2000}
```

Use a returned snapshot ID to pin a generation; `latest` resolves the pointer at
request start. Snapshot query rows retain the native TQL column structure.
Success reports `source: "snapshot"`, the generation, rows, columns, limit and
truncation. `params` is a JSON object and is passed as native bound parameters.

Arbitrary TQL runs in a separate process against an `immutable` reader with a
read-only Console session. Mutation syntax is rejected by the engine. The worker
has native resource/response budgets and a parent-enforced wall-clock timeout
that includes startup, verification and execution. Output is capped at 512 KiB;
`limit` defaults to 200 (maximum 1000), and `timeoutMs` defaults to 2000 (maximum
10000). A large result can exceed the native response budget before the output
row cap is applied; that returns an explicit error instead of a partial success.
Node and native memory budgets are not an OS process sandbox or a complete RSS
limit. No user TQL executes on the host's event loop.

TriviumDB 0.9.0 lets explicit TQL `LIMIT` override its default row budget. The
separate process, native budgets and bounded output remain necessary; slicing
rows after execution alone is not a work budget.

## CLI and integrity checks

The CLI can run after the host stops, without knowing its HTTP port:

```sh
dsh-trivium-query --snapshot /path/to/read-snapshots/snapshot-ID \
  --tql 'MATCH (n) WHERE n.name == $name RETURN n' \
  --params '{"name":"AuthGateway"}' --limit 200 --timeout-ms 2000
dsh-trivium-check --snapshot /path/to/read-snapshots/snapshot-ID --json
```

Before installation, use `node scripts/query-snapshot.mjs ...` and
`node scripts/check-integrity.mjs ...`. `dsh-trivium-query` outputs JSON and exits
1 on failure. Integrity checking retains exit codes 0 (clean), 2 (issues), and 1
(invalid input or unable to open). The existing workspace check remains a
`readOnly` open and can still conflict with an active writer; select a captured
snapshot explicitly for concurrent checking. Help commands do not open a store.

## 中文速览

- 在线查询复用宿主已有句柄，仅开放节点筛选、一跳邻居和孤立实体三类操作。
  大库或复杂审计改用快照；查询不会为任意路径创建或修复库。
- 快照由宿主按需捕获并校验，目录在 `.dsh/read-snapshots/`；源库继续写入时，
  旧快照保持捕获时刻的事实。没有每次 flush 发布 manifest 或自动刷新机制。
- 带 `snapshotId` 的 TQL 查询在独立进程中执行。任意 TQL 的工作量不会由
  最终返回行数自动约束，因此还设置原生预算、响应字节上限和父进程超时。
- `dsh-trivium-query --snapshot <目录> --tql <查询>` 用于外部分析；
  `dsh-trivium-check --snapshot <目录> --json` 用于只读体检。
- 快照占用磁盘且不自动清理。使用者退出后再清理对应代际，不要修改快照内容。
