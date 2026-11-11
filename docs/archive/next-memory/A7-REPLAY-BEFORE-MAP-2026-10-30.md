# A-7：先重放 pending，再建短地图（修 “地图说 decisions=0” 的取用缺口）

日期：2026-10-30。分支 `codex/r1-r2-reliability`。真实模型复验 5 次、**¥0.051572**。未发布、未推送。

前置：[A-6 改口退休](A6-DECISION-SUPERSEDE-2026-10-30.md)（CORRECTION 4/5，唯一失败是“声称记忆为 0”）。

## 1. 证据（复用已有报文，零费用）

把 A-6 三轮 15 个 CORRECTION 运行里**提问会话实际收到的短地图**逐条抽出来：

```text
05:31 r1 decisions=4     05:31 r2 decisions=4     05:31 r3 decisions=2
05:31 r4 decisions=4     05:31 r5 decisions=0  ←
05:34 r1 decisions=3     05:34 r2 decisions=2     ...
05:36 r1 decisions=4     05:36 r2 decisions=0  ←  05:36 r3 decisions=2
05:36 r4 decisions=0  ←  05:36 r5 decisions=4
```

**3/15 次新的会话拿到的是全零地图**（`entities=0 preferences=0 decisions=0`），而同一轮结束时数据库里明明有事实。模型回答“记忆里没有相关记录”因此是**正确读到了错误的地图**，不是幻觉。

## 2. 机制

`onAgentStart` 的顺序是：

1. `ensureShortMap()` —— 用当前库内容生成并注入短地图；
2. 然后才 fire-and-forget 地调度 **pending replay**（把上一轮遗留的窗口送去抽取）。

单轮 headless 进程在回答完就退出，重放是异步的：它可能在退出前写完，也可能没写完。没写完时，**下一个会话先看到空库、建了空地图**，而在它自己的重放中才把事实写进去——事实就晚了这一步。

## 3. 改法

`lib/index.js` 的 `onAgentStart` 改成：

```text
打开库 → 若有 pending：并进缓冲 → savePending → await 抽取（pending-replay）
        → 再 ensureShortMap（此时地图必然包含刚写入的事实）
```

- 重放从“发出去就不管”改成 **await**；
- 仍用 `replayClaims` 防止同一工作区重复认领；
- 重放失败只 warn（`pending replay skipped`），不会阻断会话启动——失败时 pending 保留，等下一次事件。

## 4. 验收

**桩模式**（确定性，零费用）：同一句“先别动方案 A” → “更正：改用方案 B”，问句会话收到的地图：

```text
entities=1 preferences=0 decisions=1 experiences=0
named: entity:方案 A; decision:方案 B
```

修复前同一检查可能拿到 `decisions=0`。

**真实模型**（CORRECTION ×5，¥0.051572）：

| 轮 | 注入地图 | 回答 |
|---|---|---|
| r1–r4 | `decisions=1` | B |
| r5 | `decisions=1`（多一条 preference） | B |

- 5/5 的提问会话都拿到非零地图（修复前 3/15 为零）；
- **回答 5/5**（同一夹具：修前 3/5 → A-6 后 4/5 → 本轮 5/5）。

全量回归：`node scripts/run-all.mjs` → **49/49 passed**。

## 5. 成本

| 项 | 运行 | 费用 |
|---|---|---|
| 真实复验（CORRECTION ×5） | 5 | **¥0.051572** |
| 桩模式顺序检查 | 3 | ¥0 |

## 6. 代价与残留

1. **首步延迟增加，但已加上限**：会话启动最多等 **8 秒**（`PENDING_REPLAY_WAIT_MS`），超时就打一条 warn 继续走，抽取在后台继续、pending 仍留在磁盘。桩模式实测：把抽取人为拖到 20 秒，提问轮的**首个模型请求仍在 +10.9 秒发出**（8 秒上限 + 启动开销），没有被那次卡住的抽取拖住。
   - 仍有一个**只影响一次性进程**的现象：那次后台抽取的 HTTP 连接会让 headless 进程直到响应返回才退出（实测 22.7 秒）。长效宿主不受影响；一次性脚本会多等一个请求的时间。没有为此加 abort（抽取不持 AbortSignal）。
2. **n=5 仍然小**：5/5 只能说明这条夹具上稳定，不能外推。
3. **同一机制的其它路径未改**：`turn/end` 保存 pending、`compaction/end` 调度抽取仍是异步；压缩后的重放是否也有同样的“先建图后重放”风险，未验证（A-5b 压缩实验因工具循环中止）。
4. **地图里的实体标签**：`entity:方案 A` 仍在（实体不是决策），本轮未动。
