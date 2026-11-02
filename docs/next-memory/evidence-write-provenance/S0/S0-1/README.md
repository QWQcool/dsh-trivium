# S0-1 证据：短地图热度（B2）

基线 HEAD `a0ffde9`（= 预期的 `59e8831` + 一个只加本阶段任务书的文档提交；`git diff 59e8831 HEAD -- lib scripts package.json` 为空）。
零模型调用、零费用、零外部依赖。

## 修前

- `buildShortMapReport` 只按类型配额取名字（preference 4 → decisionUntil 2 → entity 8 → …），
  节点一旦写进去，排序只受"插入顺序 + 类型"影响，**没有任何"这条被用过"的信号**。
- `ctx_find` / `ctx_read` 命中和其它读取没有区别，无从知道用户实际问过哪三条。
- 50 条事实的夹具里，最旧的 3 条永远排在配额之外（本片 p73 的第一条断言钉住这一点）。

## 修后

新增 `lib/usage.js`（旁路 sidecar，不进主库）：

| 关注点 | 实现 |
|---|---|
| 存哪 | `<workspace>/.dsh/trivium-usage.json`，`{format, version, updatedAt, updatedAtMs, nodes:{id:{count,lastUsedAt}}}` |
| 何时记 | `ctx_find` → `formatHit`（tools.js 调用点）；`ctx_read` → `listIncomingBusiness`（tools.js 是唯一不传 opts 的调用方） |
| 不记谁 | 自动召回（`structuredHit`）、预览面板（`recall-preview`）、面板列表（`listNodes`）都显式 `track:false`，否则"进过地图"会让它更热，形成自我强化 |
| 记到谁头上 | 命中已退休节点时，先 `currentHeadOf` 归到当前 head，避免热量记在一个地图永远不会列出的节点上 |
| 写盘节流 | `USAGE_WRITE_THROTTLE_MS = 60_000`／工作区：窗口内只累加内存，窗口结束由 unref 定时器补写；`closeAll()` 会强制冲刷，单次进程也不丢 |
| 失败姿态 | 文件损坏 / 不可写 → 退化为"无热度"，绝不让 `ctx_find` 失败 |
| 上限 | 2000 条，超出按"最近使用 → 次数"淘汰 |

地图侧（`lib/store.js`）：

- 热条目（`count > 0`）按 `(引用次数, 最近使用, 更新时间)` 降序**先占槽位**，其余按原类型配额补满 8 个；
  冷条目在各自桶内也按同一三键排序（此前完全依赖插入顺序）。保留类型配额是为了不让地图退化成热度榜。
- 地图对象新增 `version`（全量可见集合 + 预算的 fnv1a 指纹）、`entries`、`hidden`；`text` 的**结构没变**（同样的两行头 + 可选的 `named:` 行，同样上限 8 个名字），所以注入 token 不上升。
- 四工具名称/参数/返回、`DIM=1536`、schema 版本、node payload 全部未动：p73 断言 payload 里没有 `count/lastUsedAt/usage` 字段。

## 命令与输出摘要

```
node scripts/smoke-p73.mjs        → P73: 27/27
node scripts/run-all.mjs          → 74/74 passed（修前 73/73）
```

p73 覆盖的验收点：

| 验收条目 | 断言 |
|---|---|
| 50 条只问 3 条，3 条都在 400 token 内 | `entity:ent-000`（ctx_find）、`entity:ent-001` / `experience:x00`（ctx_read）都出现在 `named:` 行，`tokens=70 ≤ 400` |
| 注入 token 不上升 | 同一夹具 70 → 70（夹具里每个 `type:name` 都是 14 字符，长度差异被消除，只比较"显示了谁"） |
| 热度确实改变了排序 | 加引号前这 3 条都不在 `named:` 行（最旧 + 类型配额之外），加之后全部进入 |
| 反例：面板浏览不算引用 | `listNodes(db)` 后 `usageFor` 与快照逐字节相等 |
| 反例：自动召回不算引用 | `formatHit(..., {track:false})` 后计数不变 |
| 反例：退休节点 | 命中 A（已被 B 替代）→ `usage[B].count = 1`、`usage[A]` 不存在 |
| 节流 | 首次写盘 `written:true`；1 秒内第二次 `written:false, throttled:true`；61 秒后 `written:true`；被合并的引用在文件里能看到 |
| 坏文件 | 写入 `{not json` 后地图仍正常产出 |

## 未覆盖 / 已知边界

1. **跨进程并发写**：两个宿主进程同时写同一个 usage 文件时是"后写覆盖"，不做合并。热度是可再生信号，本片接受这个损失；主库写入仍由写锁保护，两者互不影响。
2. **"轮"的粒度**：`noteNodeUse` 只统计显式工具调用；模型在回复里"提到"某条事实但不读它，不算引用。
3. **热度排序与类型配额的交互**：热条目先占槽位，但**不会**突破 8 个名字的上限。50 条里热了 20 条时，仍然只有前 8 条进地图，其余靠 `ctx_find` 补——这是预算决定的，不是遗漏。
4. **sidecar 不进 git 忽略之外的机制**：`.dsh/` 本身是工作区本地目录，本片没有新增清理命令。
5. **token 比较口径**：`estimateTokens` 是 CJK/ASCII 启发式，不是模型 tokenizer；"不上升"指同一夹具下的估算值不变。
