# 阶段 1 前半：只读继承（2026-11-03）

基线 `main` @ `d806283`。零模型调用、零费用、不碰 `~/.dsh`。

## 修前

`resolveScope(cwd, "inherit")` 返回 `implemented: false`、`path: null`，
`dbPathFor` / `openWorkspaceDb` / `openWorkspaceDbReadOnly` 三条路径都抛 `SCOPE_NOT_IMPLEMENTED`。
也就是说：一个 work item 目录里的 Worker **没有任何办法读到上级库**。

## 修后

`inherit` 变成可实现的作用域，语义写死为 **读父库、写自己**：

| 字段 | 值 |
|---|---|
| `implemented` | `true` |
| `mode` | `"read-parent"` |
| `path`（写目标） | `<cwd>/.dsh/trivium.tdb` —— **位置不变** |
| `parentCwd` / `parentPath` | 上一级目录及其库文件（磁盘根目录时 `parentPath: null`） |

新增 `lib/inherit.js`：

- `inheritedParent(cwd)` — 只探测不打开，`available` 说的是"父库文件在不在"，不是"布局对不对"；
- `readInheritedMap(cwd, { budget, openReadOnly })` — 以**只读**方式打开父库，用同一套
  `buildShortMapReport` 生成父库短地图，读完立即 `close()`。

返回 `{ ok, parentCwd, text, tokens, entries, version }`，失败时 `reason` 只有三种：
`no-parent`（磁盘根）、`no-parent-db`（上级没存过东西）、`unreadable`（文件存在但打不开）。
**三种都不抛异常**：Worker 这一轮就是没有继承上下文，不能因此失败自己的回合。

### 为什么是只读

并发实测（`S1/CONCURRENCY-2026-11-03`）显示：真实抽取延迟下 3 个 Worker 有 78% 的抽取抢不到锁。
"推迟"在长命会话里没问题，但 work item 目录是短命的——推迟到没人再开这个库，就是**静默丢事实**。
所以"写回上级"这一半必须等 Router（后半 B），本片只做读。

## 验收

```
node scripts/smoke-p80.mjs   → 22/22（新增）
node scripts/smoke-p77.mjs   → 21/21（其中 3 条断言按新语义更新，见下）
node scripts/run-all.mjs     → 81/81（改前 80/80）
```

p80 覆盖：

| 断言 | 说明 |
|---|---|
| 解析字段齐全 | `mode: read-parent`、写路径是自己的库、`parentPath` 指向上一级 |
| `dbPathFor(inherit)` = 自己的路径 | 继承不搬家 |
| `parent` 仍然抛错 | 它需要 Router |
| 父库不存在 → `no-parent-db`，且**没有建出** `<parent>/.dsh` | 读不产生副作用 |
| 父库有事实 → `ok`，文本里出现 `deploy-window`，token ≤ 400 | 真读到了 |
| 读后父库 **字节级一致、mtime 不动** | 只读 |
| 读后子目录 `.dsh` 也没被创建 | 读不建库 |
| 子库写入后父库节点数不变 | 写落本地 |
| 父库已在本进程以读写打开时 → `unreadable` 而不是抛错 | 真实冲突也走降级 |
| 注入一个会抛的 opener → `unreadable` | 打开失败降级 |
| 预算 40 → 只付表头下限（实测 41 token），条目数不增加 | 预算有下限，不伪造 |

`p77` 的三处更新（**不是放宽，是语义变更**）：

1. `resolveScope('inherit').implemented` 由 `false` 改为 `true`，并断言 `mode/path/parentPath`；
2. `openWorkspaceDb(cwd, 'inherit')` 不再抛错，改为断言"打开的是本地库"；
3. `openWorkspaceDbReadOnly(cwd, {scope:'inherit'})` 的"拒绝"用例换成 `parent`（仍在拒绝的那一个）。

## 未覆盖 / 已知边界

1. **没有任何调用方**：`inherit` 与 `readInheritedMap` 都是 opt-in 管道，默认路径零变化。
   真正接上要等 Worker profile 出现（或后半个 Router）。
2. **同一进程内先读写打开父库、再只读打开会失败**（引擎拒绝第二个句柄）；`readInheritedMap`
   把这种情况降级成 `unreadable`。生产形态里 Worker 只读父库、读写自己，不会撞上；
   但如果将来一个进程同时需要读写父库，必须先关句柄或改由 Router 代劳。
3. **继承的地图没有标注来源**：返回的是父库原样的短地图，调用方若要注入，应自己加一行
   "以下来自上级工作区"，否则模型会以为是本地记忆。
4. **只继承一层**：`parentCwd` 只看上一级，没有向上递归（多级 work item 目录要等阶段 1 后半再定）。
5. **预算下限**：`budget` 低于表头开销时仍输出表头（40 → 41 token），这不是预算失控，是"表头不可省"。
6. **只读打开父库时若父库正被另一个进程写**，`triviumdb` 是否允许只读并发未实测；
   失败会走 `unreadable`，不会写坏。
