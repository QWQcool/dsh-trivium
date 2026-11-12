# Read queries while the host owns the writer

The TQL, snapshot and CLI APIs shipped in dsh-trivium 0.8.9 for issue #5.
The current-fact selector, named snapshot queries and Context-page query card
below are newer source changes, pending a subsequent release.

The host remains the single writer. Live queries borrow its already-open
instance; external analysis uses an independently captured snapshot. Both paths
report their source. TQL, named fact queries and snapshot capture do not invoke
a model or an embedding service. The independent entity-search endpoint below
can explicitly request query embeddings; it is never called by those APIs.

## Live HTTP queries

Use the existing host port and a URL-encoded workspace path. The workspace must
already be open in this host; an unknown or unopened path returns
`409 WORKSPACE_NOT_OPEN` without creating or synchronizing a database. The
existing loopback and write-request origin checks also apply to these endpoints.

```http
POST /api/dsh-trivium/query?cwd=<URL-encoded-workspace>
Content-Type: application/json

{"tql":"MATCH (n)-[:about]->(hub) RETURN n, hub","params":{},"limit":200}
```

The host runs read TQL against its current writer handle through a query-only,
read-only Console session. Bind scalar parameters (strings, finite numbers,
booleans or null) by name, for example
`{"tql":"MATCH (n) WHERE n.name == $name RETURN n.id AS id","params":{"name":"AuthGateway"}}`.
The native parser accepts supported read syntax, including joins, aggregation,
sorting, paging and graph algorithms. Results carry `ok`, `source: "live"`,
`kind: "tql"`, native `columns`, `rows`, the returned `rowCount` and `truncated`.
Each call sees the state at execution time. Use a snapshot ID to pin a series of
queries to a specific generation.

The client row limit defaults to 200 and accepts 1–1000. For an eligible read,
the native parser validates an outer page of up to `limit + 1` rows. The extra
row establishes truncation. If wide rows exceed the encoded byte budget, the
host can fetch a smaller page within the original deadline. It marks the returned
prefix with `truncated: true` and `truncationReason: "response-byte-budget"`.
Queries with existing pagination or plan inspection use their original TQL.
Every successful response contains at most `limit` rows. The native working-set
budget is 1000 rows for operators that enforce it.
Wide rows include vectors when the query selects whole nodes. Project required
properties in TQL to fit the response byte budget.

Live TQL accepts `timeoutMs` from 1–50, default 25. The native engine checks
its deadline cooperatively. The adapter also checks elapsed time before returning
the result. Node executes the native call synchronously, so other host callbacks
can wait during that interval. A deadline yields HTTP 408, an exhausted working
budget yields 422, and an oversized encoded result yields 413. An explicit TQL
`LIMIT` can override the engine's default row budget for some operators.

### Named live queries

```http
POST /api/dsh-trivium/query?cwd=<URL-encoded-workspace>
Content-Type: application/json

{"kind":"nodes","type":"entity","limit":200}
```

Other named queries:

```json
{"kind":"currentFacts","type":"decision","name":"Release window","limit":50}
```

```json
{"kind":"nodes","name":"AuthGateway","limit":20}
```

```json
{"kind":"neighbors","id":42,"direction":"both","label":"about","limit":100}
```

```json
{"kind":"orphanEntities","currentOnly":true,"name":"AuthGateway","limit":200}
```

`currentFacts` excludes workspace/session metadata, archived and expired facts,
and superseded decision history. It reuses the plugin's current-head validation;
a malformed revision chain returns `422 READ_QUERY_REVISION_INVALID`, including
self-loops. Pending replacement proposals do not retire either fact. Optional
`type` (entity/preference/decision/experience) and `name` filters are exact.

`nodes` retains its raw-list semantics and exact `type`/`name` filters.
`neighbors` examines one hop;
`direction` is `both` (default), `incoming` or `outgoing`. Its optional `label`
is one of `about`, `decided`, `broke`, `fixed`. Each returned neighbour also
contains `relationships: [{from,to,label}]` for matching business edges between
the anchor and that neighbour; endpoint IDs are decimal strings.
`orphanEntities` finds entities
without a business edge in either direction; workspace/session bookkeeping
edges do not prevent an entity from being reported as an orphan. Its optional
exact `name` filter narrows the scan; `currentOnly: true` applies the same current
fact rules. The panel sets it to true. Omitting it preserves the older raw-entity
query. `completeScan: true` means all entities in that name scope were checked,
even if the returned orphan list is truncated.

Named queries take a `kind` field. Node IDs are positive safe integers on
input. Rows contain node summaries, with decimal-string IDs; they omit vectors.
Success returns `ok`, `source`, `asOf`, `timeBasis`, `kind`, `rows`, `limit`, and `truncated`.
The default result limit is 200, maximum 1000. A result limit is separate from
execution work limits. Raw `nodes` retains its whole-workspace 1000-node gate.
The three business selectors use bounded candidates, payload-only projections
and native one-hop traversal: a small neighbourhood or exact-name lookup can
therefore succeed in a 5000-node workspace. The adapter admits at most 1000
distinct node payloads and 10000 edge/probe work units. This accounting does not
measure native internal scan work; Console queries retain a 50ms native deadline
and a 150ms total selector window. An excessive orphan candidate set, incomplete
traversal or exhausted budget returns 422 without partial rows. A truncated
output is distinct from an incomplete scan. `work` reports the adapter counters.

Live selectors use `timeBasis: "query-time"`. Named snapshot selectors use the
same implementation and budgets with `timeBasis: "snapshot-capture"` and
`asOf` equal to the publication's capture time. Expiry is assessed at that time;
viewing an old snapshot later does not silently change its historical results.
Snapshot capture does not bypass work limits.

```json
{"snapshotId":"latest","kind":"currentFacts","limit":50}
```

In the newer source UI, open **Context → Fact queries**, choose one of the three
selectors and live/snapshot source, then run. **Create and select snapshot** is
explicit capture; subsequent queries pin the returned ID. The card shows source,
reference time, generation ID, row count and truncation. Failures show the HTTP
status and code, rather than an empty result. Changing workspaces discards late
responses and the previous workspace's snapshot/node/name selection.

Request bodies are limited to 16 KiB and a 2-second body-read deadline.
Admission allows at most two requests globally and one per workspace; excess
work receives `429 READ_BUSY`. Native live-query deadlines are cooperative:
they do not provide hard real-time interruption of Node's synchronous binding.
Replies are bounded to 512 KiB. Invalid fields and operations are rejected.

## Explicit entity search (unreleased source)

```http
POST /api/dsh-trivium/entity-search?cwd=<URL-encoded-workspace>
Content-Type: application/json

{"entityId":104,"query":"How long can a report cursor be reused?","limit":5}
```

`cwd` is required explicitly and must already be open in the host. The request
does not open or synchronize a database and does not follow `activeCwd` after
admission. `entityId` is a positive safe integer; `query` is nonempty, at most
4096 UTF-8 bytes. `limit` defaults to 5 and accepts 1–20 **per channel**. Unknown
fields, caller budgets, traversal depth overrides and arbitrary TQL are rejected.

The default is `semantic: false`: no provider call. To use the configured,
enabled embedding service, add `"semantic":true`. Only the question and existing
query instruction prefix go to that service. No generation model is called.
An optional `snapshotId` selects an existing generation; `"latest"` is pinned at
request start. No failure silently switches sources or broadens the scope.

Scope is the entity and both-direction business one-hop neighbours through
`about`, `decided`, `broke`, `fixed`. Workspace/session bookkeeping edges do not
expand it. Archived, expired, dirty and replaced history are filtered. Pending
replacement proposals remain eligible and marked. A current version without a
direct scope path is omitted with `CURRENT_OUTSIDE_SCOPE` metadata, never shown
using the historical node's path. Broken revision chains fail closed.

Success has `textCandidates` and `semanticCandidates`, each separately limited
and carrying decimal-string IDs, summaries, actual relation paths, `score` and
`scoreKind` (`lexical` or `cosine`). These score scales are not interchangeable
and neither is an answer probability. There is no merged ranking. `channels`
reports execution/degradation and separate `truncated` flags. `state` is
`candidates`, `no_candidates` or `scope_anchor_only`; `answerability` is always
`not_assessed`. Nearest neighbours do not establish that a question is answerable.

`scope.complete` means the recorded one-hop scope was fully examined. It does
not claim all real-world associations are recorded; inspect `warnings` for
current-version association gaps. `scope.fingerprint` is a read-set digest,
not a global identity or a write authorization token. Cache keys must also bind
the workspace, source/generation, entity, question and channel options.

Live queries build the scope, wait without a workspace write lock, then rebuild
and compare the relevant read set before returning. Relevant body, membership,
path or current-state changes yield `409 ENTITY_SEARCH_SCOPE_CHANGED`; close or
reopen yields `409 ENTITY_SEARCH_SOURCE_CHANGED`. Embedding configuration changes
yield `409 ENTITY_SEARCH_EMBEDDING_CHANGED`. There is no automatic retry/model
call. Unrelated changes outside the read set do not invalidate it. Snapshot
queries use an immutable verified generation and assess expiry at capture time.

Budgets are shared across both validation passes and channels: 1000 distinct
examined IDs (including revision validation), 10000 edge/probe units, 512 KiB of
hydrated payload JSON, a 150ms cooperative CPU window excluding provider wait,
and a 512 KiB encoded response. `work.cpuMs` measures the active-read wall window
(`performance.now` minus provider wait), not OS CPU consumption. The HTTP
handler has a 15s deadline from admission, including body/worker/provider time;
it cannot account for client waiting before the host dispatches the handler.
Provider wait reserves time for the final
scope check and reads at most 64 KiB of embedding response. An embedding-only
timeout, provider failure, invalid query vector or disabled configuration can
return current lexical results with `degraded:true`. It does not change the scope.

Execution/work/response exhaustion returns 408/422/413 without partial candidate
lists. Invalid or unavailable anchors return 400/404/409. Request body limits and
loopback/origin checks are the same as the other read APIs. Shared admission is
two active read requests globally, one per workspace; an explicit semantic wait
can therefore make other read-API requests return `429 READ_BUSY`. Writers are
not held behind a workspace lock during this wait. Client disconnect cancels
the provider and waits for snapshot worker exit before releasing admission.

The live native call is synchronous, so its CPU deadline rejects late output
cooperatively. Snapshot verification and scoring run in a killable child with a
parent wall-clock deadline. Provider calls are brokered by the host; connection
configuration/keys are not sent through the worker protocol and common provider
credential environment variables are stripped. This endpoint writes no facts,
vectors, links, indexes, heat or delivery ledgers. It does not modify `ctx_find`,
automatic recall, existing fixed-query semantics or UI.

Stored-vector model compatibility is still the operator's responsibility after
a model change/backfill; this endpoint does not infer a model from dimension or
invent calibrated relevance thresholds. Acceptance and remaining limits are in
the [backend report](reviews/ENTITY-SEARCH-BACKEND-2026-11-12.md).

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
limit. Snapshot TQL executes on the worker's event loop.

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

- 发送 `tql`、`params` 和 `limit` 可以查询宿主已有句柄上的最新数据，支持引擎的只读查询语法。
  返回行数默认 200、最多 1000。原生截止时间默认 25ms、最多 50ms，按检查点取消。
  超时、工作集和响应字节超限均返回明确错误。节点、一跳邻居、孤立实体仍支持 `kind` 快捷查询。
- 快照由宿主按需捕获并校验，目录在 `.dsh/read-snapshots/`；源库继续写入时，
  旧快照保持捕获时刻的事实。没有每次 flush 发布 manifest 或自动刷新机制。
- 带 `snapshotId` 的 TQL 查询在独立进程中执行。任意 TQL 的工作量不会由
  最终返回行数自动约束，因此还设置原生预算、响应字节上限和父进程超时。
- `dsh-trivium-query --snapshot <目录> --tql <查询>` 用于外部分析；
  `dsh-trivium-check --snapshot <目录> --json` 用于只读体检。
- 快照占用磁盘且不自动清理。使用者退出后再清理对应代际，不要修改快照内容。
