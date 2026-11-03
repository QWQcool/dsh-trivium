# 阶段 1 验收：三个 Worker 并行同一个仓库（2026-11-03）

基线 `main` @ `fdcb3dc`。零模型调用、零费用。
复现：`node scripts/smoke-p84.mjs`（3 个子进程，各自一个 work-item 目录，父库由 Router 独占）。

## 场景

```
repo/                     ← 仓库，父库 .dsh/trivium.tdb（预置 2 条事实）
  item-1/ item-2/ item-3/ ← 三个 Worker 的目录，各自不建库
```

每个 Worker：读继承地图 → 通过 Router 提交 2 条候选（1 条三条相同的「发布窗口」，1 条自己独有的）。

## 结果

| 路线图验收条目 | 结果 |
|---|---|
| **事实不重复** | 三条相同的「发布窗口」→ 库里 **1 条**，另外两次是 `merge`（`actions` 里 2 merge / 4 insert） |
| **不丢** | 4 条不同事实全部落库（1 共享 + 3 独有），种子事实没有重复 |
| **短地图不串味** | 每个 Worker 的继承地图都是父库的（51/51/63 token，含种子事实「鉴权」）；无关目录读到 `no-parent-db` |
| **Worker 不建库** | 三个 `item-*` 目录都没有 `.dsh/trivium.tdb` |

## 两个实现层面的发现

### 1. `inherit` 的只读打开在多 Worker 形态下**必然失败**

三个 Worker 全部拿到 `unreadable`：

```
inherit path (before fallback): [{"ok":false,"reason":"unreadable"} ×3]
```

原因就是 `S1/CONCURRENCY` 里那条：引擎拒绝同一库的第二个句柄，"另一个进程只读"也不行。
所以只读继承**只在没有写者时成立**——单进程、或父库没被 Router 打开。

### 2. 因此继承改成"有 Router 就问 Router"

`readInheritedMap` 在只读打开失败后，会尝试连父库的 Router，用 `map` 操作拿同一份短地图：

```
inherit path (after fallback): [{"ok":true,"via":"router"} ×3]
```

- `via` 字段明确写出来源（`file` / `router`），调用方不会误以为读到的是本地文件；
- 没有 Router 时仍然返回原来的 `unreadable`，**不发明成功**；
- Router 新增 `map` 与 `apply` 两个操作：`apply` 把候选交给 Router 去重/合并（去重必须发生在持有数据库的进程里，Worker 只 `insert` 会存成两份），`map` 让 Worker 不必开第二个句柄。

## 契约变化

| 位置 | 变化 |
|---|---|
| `readInheritedMap` 返回值 | 新增 `via: "file" \| "router"`；失败分支不变（`no-parent` / `no-parent-db` / `unreadable`） |
| `createRouterClient()` | 新增 `apply(candidates, opts)` 与 `map(budget)`；`writer` 的四个方法不变，仍是 `MemoryWriter` 端口 |
| Router 协议 | 新增 `apply` / `map` 两个 op，错误仍带 code（未知 op 是 `ROUTER_UNKNOWN_OP`） |

## 没做的

1. **没有真 Super-agent**：Worker 目录与父库是本地搭的，不是它的 work item 生命周期（创建/回收）。
2. **没有多机器**：命名管道仅同机；跨机需要 TCP + 鉴权，未做。
3. **Router 仍然没有常驻场所**：本测试里它是测试进程自己起的；接进宿主仍取决于"谁常驻"。
4. **Worker 的本地库没有测**：本场景假设 Worker 不落本地库；如果以后要"本地临时记忆 + 上游共享记忆"，那是另一种作用域语义，未设计。
5. **没有测 Worker 崩溃**：Router 侧只有 `queued` 计数与 flush-后-回包，没有请求超时/重试。
