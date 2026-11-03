# 真实会话复测：B1 的两种结局都出现了（2026-11-03）

基线 `main` @ `e5e77b4`。本机 DSH web 宿主 + 真实模型（`DeepSeek-V4.1-Flash`）。
两段会话、共 3 次成功发送，花费约 **¥1**（远低于 ¥3 的单次预算）。

## 会话 A：确认窗口被工具证据救回

| 轮 | 消息 | lastExtract | gate | lastMapInjection |
|---|---|---|---|---|
| 1 | 「记住：这个项目用 npm，全量测试是 node scripts/run-all.mjs。」 | applied 2，screenedCounts `{scored2:1}` | `skipped:false, reason:"tool-evidence"` | skip / 0 token |
| 2 | 「继续。」 | applied 2，screenedCounts `{scored2:1}` | `skipped:false, reason:"tool-evidence"` | **full / 147 token** |
| 3–6 | 「ok」「记住：发布前…」「继续。」「好」 | **没发出去**：生成中发送按钮不存在，脚本找不到 `发送消息` 而跳过 | — | — |

第 1 轮耗时 76 s（模型调用了工具），第 2 轮 5.7 s。

## 会话 B：整窗被筛掉，抽取没调用模型

新建会话，只发一条「ok」：

```
skippedBy: "screen"
applied: 0
screenedOut: 2
screenedCounts: { scored0: 1, scored1: 0, scored2: 0 }
gate: { skipped: true, reason: "screen-empty" }
mapMode: "skip", mapTokens: 0
```

**这是 B1 第一次在真实会话里被证实有效**：用户那句话 0 分，模型的回复没有工具调用，
整个窗口留在 0 分被丢弃，`runExtract` 在取锁开库之前就返回，**没有发生抽取模型调用**。
之前所有证据都来自夹具。

## 两个机制在真机上都成立

| 情形 | 结果 | 说明 |
|---|---|---|
| 0 分 + 该轮有工具调用 | 升到 1 分 → 内容门 `tool-evidence` | 「继续。」没有因为"看起来像填充句"被丢掉 |
| 0 分 + 无任何工具 | 整窗丢弃 → `skipBy: "screen"` | 真的省了一次模型调用 |

## 一处没解释清楚的地方（照实记）

第 2 轮的 `lastMapInjection` 是 `mode: "full", tokens: 147`。按设计此时 `turnsSince` 只有 2，
远未到 `MAP_FULL_REFRESH_TURNS = 6`，本应是 `skip`。可能的原因有：版本串为空（走了 `no-version` 分支）、
或其他会话在同一时刻刷新过工作区级状态。**我没有记录 `reason` 字段，无法判定**，
所以这里只报告现象，不下结论，也不修改代码。下次复测应把 `lastMapInjection.reason` 一起记下来。

另外，工作区的 `mapInjections` 计数（full 1 / diff 2 / skip 8）是**按工作区累计**的，
跨会话累加，不能当作单轮证据使用。

## 副作用与清理

- 会话 A 写入的 3 个节点（id 22–24，内容都是真实的仓库事实：npm + `run-all`）已通过
  `POST /nodes/<id>/delete` 删除，删除后列表恢复为原有 8 条可见节点。
- `trivium-pending.json` 里没有窗口（只有 acknowledged 键），是正常运行状态，未动。
- 变更记录（`trivium-changes.jsonl`）里保留着这几次写入/删除的审计行——它是追加日志，本次没有裁剪。
- 跑前备份在 `.tmp/s0b-db-backup/`。

## 未覆盖

1. **只有 3 次成功发送**：脚本在模型生成期间找不到发送按钮，后半段消息没发出去。
   要测"调用降幅"需要一段连续的、每轮都成功的会话，本次没做到。
2. **没有统计真实调用数**：宿主的模型调用计数无法从插件侧读到；能证明的是"这一次没有调用抽取"，
   不是"调用了 N 次中的 M 次"。
3. **只有一种模型**，且都是短消息；长会话里的工具密度可能完全不同。
4. **`full/147` 的原因未定位**（见上）。
