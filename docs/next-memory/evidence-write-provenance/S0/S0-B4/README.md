# S0-B4 证据：记忆写入端口（`MemoryWriter`）

基线：`main` @ `a66d1a1`。零模型调用、零费用。

## 修前

`applyCandidates` 在 `lib/extract.js` 里直接调用 store：

```
mergeInto(db, existing, payload)      // 合并
insertNode(db, payload)               // 新增（两处）
ensureLink(db, id, target, label)     // 业务边
updateNode(db, id, { review })        // 标记待复核
```

`distill({db, ...})` 把 `db` 一路传下去。要改成"Router 单点写"，就得在 `extract.js` 里逐个替换调用点，
而这些调用点分散在 `applyCandidates`、`linkReplacementDecision`、`markForReview` 三个函数里。

## 修后

新增 `lib/memory-writer.js`：

| 名字 | 作用 |
|---|---|
| `MEMORY_WRITER_METHODS` | `["insert", "merge", "link", "update"]`，端口形状即数据 |
| `localMemoryWriter(db)` | 进程内实现，逐个委托给 store 的同名函数 |
| `memoryWriterFor(db, writer)` | 有 writer 用它（先校验四个方法齐全，缺一个抛 `WRITER_INCOMPLETE`），没有就退回本地 |

`extract.js` 的改动只在写路径：

- `applyCandidates(db, candidates, {…, writer})` 开头解析出 `const sink = memoryWriterFor(db, writer)`；
- 四处写调用改成 `sink.merge / sink.insert / sink.link / sink.update`；
- `markForReview` 与 `linkReplacementDecision` 接收 `sink`（后者保留 `db` 做读）；
- `distill({db, writer, …})` 把 `writer` 透传下去。

**读路径没有动**：重复检测（`findDuplicateWrite`）、合并目标（`findMergeTarget`）、替代候选扫描
仍然读 `db`。这是一个**写边界**，不是数据库抽象——把它做成读写全隔离会把这次改动放大成重构，
而阶段 1 真正需要的只是"写能换实现"。

## 命令与输出摘要

```
node scripts/smoke-p63.mjs   → 14/14（工单指定回归）
node scripts/smoke-p65.mjs   → 16/16（工单指定回归）
node scripts/smoke-p69.mjs   → 18/18（工单指定回归）
node scripts/smoke-p79.mjs   → 16/16（新增）
node scripts/run-all.mjs     → 80/80（改前 79/79）
```

p79 覆盖的契约：

| 断言 | 说明 |
|---|---|
| 四个方法齐全、`kind: "local"` | 端口形状 |
| 缺方法的 writer 抛 `WRITER_INCOMPLETE` | 在**任何写入之前**拒绝 |
| 不传 writer 时退回本地 | 既有调用方零改动 |
| `applyCandidates` 的 insert 经过 writer | 记录型 writer 收到调用，且真的落库 |
| 重复句走 `writer.merge` | 合并也走端口 |
| 命名邻居走 `writer.link` | 业务边也走端口 |
| 纯桩 writer：`applied` 有值、库不动 | 证明写路径真的可替换 |
| 不带 writer 的 `distill` 仍然落库 | 默认路径零变化 |
| writer 抛出的错误不被吞 | 拒绝语义保留 |

## 未覆盖 / 已知边界

1. **没有 Router 实现**：端口只有本地实现。阶段 1 的"集中写"要另写一个把四个方法转成 RPC/队列的 writer。
2. **`lib/index.js` 没有注入 writer**：`runExtract` 仍走默认。注入点是 `distill({writer})`，等 Router 真出现再接。
3. **其它写路径未纳入**：`markdown.js`（外部导入）、`pins.js`（芯片新增）、`revisions.js`（替代/撤销）、
   `server.js` 的编辑/归档/删除仍直接写库。它们不在抽取管线里，本单只承诺"抽取的写路径"。
4. **端口没有事务语义**：本地实现每个方法各自落库；将来 Router 版需要自己决定"一次 apply 是否一个事务"。
5. **读仍然依赖 `db`**：桩 writer 只能证明"写可替换"，不能证明"整条管线可远程化"。
