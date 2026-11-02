# S0-2 证据：增量地图注入（B3）

基线：S0-1 之后（`d0bea13`）。零模型调用、零费用。

## 修前

- 短地图每个会话**只在启动时注入一次全文**，之后 `ensureShortMap` 被 `mapInjected` 挡住；
  会话内记忆变化了，模型看不到，只能靠自己想起来调 `ctx_find`。
- 没有任何版本概念：要"知道地图变了"只能重建全文并覆写，代价是每次都付一遍全文 token。
- 压缩后 `mapInjected` 被清掉，下一轮重新注入全文（这条行为保留，见下）。

## 修后

`lib/index.js`：

| 关注点 | 实现 |
|---|---|
| 版本 | `buildShortMapReport` 产出 `version = mapv-fnv1a-<指纹>-<可见条数>-<预算>`；指纹覆盖**全部可见条目**（id/桶/标签/updatedAt）+ 预算，所以第 9 条事实也会改变版本 |
| 会话状态 | `mapStateBySession`：`{version, entries, text, turnKey, turnsSince}` |
| 何时刷新 | 每个"用户轮"第一次 `agent/pre-step`（`turnKey` 变化才算一轮；工具循环里的重复 pre-step 不计） |
| 三种动作 | `full`（首轮 / 距上次全量 ≥ N 轮 / 版本算不出来）、`diff`（版本变了且有条目增删改）、`skip`（版本没变，或只变了正文/更新时间） |
| `N` | `MAP_FULL_REFRESH_TURNS = 6`（注释说明了取值理由，不是实测值） |
| 差异格式 | 首行 `dsh-trivium memory map changed: +a new, -r retired, ~c relabeled; H more entries stay unexpanded (ctx_find to read them).`，随后 `+`/`~`/`-` 行（每类最多 6 行） |
| 注入通道 | `agent.inject`（与启动地图同一条通道），不占 pins/recall/corrections 的 300 token 轮预算，也不会被当成用户原文 |
| 状态 | `/status` 新增 `lastMapInjection`（mode/reason/tokens/turnsSince/version）与 `mapInjections` 计数 |
| 压缩 | `compaction/end` 同时清 `mapStateBySession`，下一轮必为 full（旧地图已不在上下文里，不能拿它做 diff） |

为什么 diff 不带版本号进正文：版本是给状态机用的，写进提示词只会多花 token，模型不需要它。

## 命令与输出摘要

```
node scripts/smoke-p74.mjs    → P74: 29/29
node scripts/run-all.mjs      → 75/75 passed（S0-1 后 74/74）
```

关键实测数字（p74 夹具：8 条可见事实，全文地图 75 token）：

| 场景 | 结果 |
|---|---|
| 会话首轮 | `mode=full`，1 条注入，含全部 3 条关键事实 |
| 连续 3 轮无新事实 | 3 × `mode=skip`，注入 token **225 → 0**（相对"每轮都发全文"下降 100%，要求 ≥50%） |
| 同一轮重复 pre-step | 返回 `null`，注入数不变（工具循环不会推高轮数） |
| 新增 1 条事实 | `mode=diff`，37 token，含 `+decision:release-train` 与 `1 more entries stay unexpanded` |
| 归档 1 条事实 | `mode=diff`，含 `-decision:release-train` 与 `-1 retired` |
| 第 N 轮（N=6） | `mode=full, reason=refresh`；第 N-1 轮仍 `skip` |
| 版本不可计算 | `mode=full, reason=no-version`（不拿未知基线做 diff） |
| 只改正文/更新时间 | `mode=skip, reason=version-only`（不买一条"0 new, 0 retired"的废话） |
| 预算参与版本 | 400 与 300 产出的 version 不同 |

"该提到的事实仍被提到"的测法：把会话里**已经注入过的文本**拼起来看，3 条事实在首轮全文里仍可见——
这正是不重复注入成立的前提（地图留在宿主上下文里，直到压缩）。

## 未覆盖 / 已知边界

1. **真宿主未验证**：刷新走 `agent.inject`，本片只用假 agent（p74）与 p25 的假宿主驱动。真实 DSH 在会话中途接受 `inject` 的行为没有实机证据；如果它拒绝，`lastMapInjection.error` 会记录，状态机会继续前进而不是每个 pre-step 重试（避免刷屏）。
2. **"轮"的定义**：按 `turnKeyOf`（宿主 messageId/seq）变化计数，不是按模型步数。同一用户消息触发的多次 pre-step 只算一轮。
3. **diff 行数上限**：每类 6 行。一次导入 30 条事实时正文只有计数 + 前 6 行，其余靠 `ctx_find`；摘要里的 `H` 是"没进地图的条数"，不是"没列出的差异条数"。
4. **压缩后必然全量**：`compaction/end` 清空会话地图状态，代价是压缩后的第一轮付一次全文。
5. **版本碰撞**：fnv1a 32 位，理论上存在碰撞；碰撞的后果是"该发 diff 时发了 skip"，不会写错事实。预算与条数也进版本串，降低误判面。
