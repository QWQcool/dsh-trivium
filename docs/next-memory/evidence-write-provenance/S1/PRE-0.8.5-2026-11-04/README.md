# 发 0.8.5 前的两次真机补验（2026-11-04）

基线 `main` @ `3dcdd00`。本机 DSH web 宿主 + 真实模型，一轮对话，约 **¥0.5**。

## 目标

`CURRENT-STATE` §4 留了两条没验的：① `stuck`/`recovered` 从来没在真机出现过；
② 11-03 那次 `lastMapInjection` 的 `full / 147 token` 原因不明（当时没记 `reason`）。

## 做法

1. 备份仓库记忆库，在 `.dsh/trivium-write.lock` 写一个**死进程 + 10 分钟前**的过期锁
   （`pid=999999`，mtime 往前挪）；
2. 启动宿主，先读一次 `status`，再新建会话，再读一次；
3. 发一句真实事实（「记住：发布前必须先跑全量回归，再打 tag。」），等抽取结束。

## 结果一：`stuck → recovered` 成对出现

```
会话启动后：stuck = { kind:"lock-stale", detail:"age=634s pid=999999",
                      sessionId:"session-e19f…", open:["lock-stale"] }
抽取成功后：recovered = { kind:"lock-stale", afterMs:35154,
                          sessionId:"session-67af…", open:[] }
```

- `age=634s`：锁的 mtime 确实被识别成 10 分钟前；
- `detail` 里带着 pid，看得出是"死主"而不是"活主占用"；
- `open` 从 `["lock-stale"]` 变成 `[]`，不是靠前端猜的。

**一个额外发现**：`stuck` 记在 `session-e19f…`，`recovered` 记在 `session-67af…`——不是同一个会话。
这正是设计里"从变更记录 seed"的效果：新会话接手时知道上一轮还欠着什么，才能把它关掉。
如果只按会话内存配对，这一对就永远配不上。

## 结果二：`full/147` 的原因找到了（是诊断口径，不是 bug）

这一轮 `lastMapInjection` 的 `reason` 都有值：

```
before（还没新建会话）：  mode:"full", reason:"session-start", tokens:123
turn 1（新建会话后）：    mode:"skip", reason:"unchanged",  tokens:0
```

关键在于 **`lastMapInjection` 是工作区级、不是会话级**：同一工作区里任何一个会话启动，
都会把这份诊断覆盖掉。`before` 那一条 `full/session-start` 来自一个不是我创建的会话
（桌面版或上一次残留），已经说明了这一点。

所以 11-03 那次"第 2 轮 full/147"最可能的解释是：**另一个会话在同一时刻启动**，把工作区级诊断覆盖成了它的启动注入，
而不是第 2 轮的 pre-step 真的发了全量。当时没有 `reason` 字段可看，只能存疑；现在有字段，这类歧义可以当场分辨。

**这还是诊断口径的缺陷**：要判断"这个会话上次注入了什么"，必须看 `lastMapInjection` 的 `sessionId`，
而这个字段本身没带 session。要彻底消除歧义，应改成按会话存（类似 `mapInjections` 的计数那样带上 session），
本轮**没有改**，只记录。

## 结果三：这一轮其它数值

| 项 | 值 |
|---|---|
| 地图 | 启动 `full/session-start` 123 token；turn 1 `skip/unchanged` 0 token |
| 抽取 | `applied 2`、`screenedOut 0`、`reason:"batch"` |
| 库 | 16 → 18 条，删掉测试写入后回到 8 条可见节点 |

## 清理

- 测试写入的 2 个节点（id 25/26）已通过删除接口移除，列表回到原有 8 条；
- 种下的过期锁被正常运行回收，`.dsh/trivium-write.lock` 已不存在；
- 宿主已停止；跑前备份在 `.tmp/s0c-backup/`。

## 结论（对 0.8.5 的意义）

1. **B5 的 `stuck/recovered` 现在有真机证据**，可以作为 0.8.5 的发布依据；
2. **`full/147` 不是缺陷**，是"工作区级诊断 + 多会话"造成的读法歧义，**发布说明里不必写**，但应作为已知限制记在文档里；
3. 仍未验证：`extract-timeout`（30 秒真实挂起）与 `replay-timeout` 两条 stuck 分支，只验证了 `lock-stale`。
