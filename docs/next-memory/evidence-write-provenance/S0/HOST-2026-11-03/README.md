# 阶段 0 真机观测（DSH web 宿主，2026-11-03）

基线：`main` @ `ba05544`（本地 symlink 安装，宿主直接加载仓库代码）。模型：`DeepSeek-V4.1-Flash`。
花费：3 轮对话，宿主计量合计约 500K token（含一次失控的长回答），按峰价估算 **< ¥3**。

## 怎么跑的

`dsh --profile web --no-open --port 5199`（Node 用桌面版自带运行时），CDP 驱动无头 Chrome：
新建会话 → 输入并发送 → 轮询 `GET /api/dsh-trivium/status`。

第一轮试图在仓库工作区跑，插件的 `ctx_remember` 直接失败：

```
Memory write failed: the workspace memory DB is locked by another DSH instance
```

——桌面版宿主同时开着同一个库，单写者锁按设计拒绝了写入（**不是**插件崩溃）。因此改用临时工作区
（`DSH_HOME` 不变，只在 `workspace.json` 里临时登记一个 `.tmp/s0-ws`，跑完恢复原文件并删目录）。

## 观测到的（原始值）

| 事件 | status 里的值 |
|---|---|
| 会话启动 | `lastMapInjection = {mode:"full", reason:"session-start", tokens:131, turnsSince:0, version:"mapv-fnv1a-7e213504-9-400"}` |
| 跑完 3 轮后计数 | `mapInjections = {full:1, diff:2, skip:5}` |
| 事实变化后再进一轮 | 实际发生了 2 次 `diff`（对应两次抽取写入），安静轮为 `skip` |
| 安静轮 | `{mode:"skip", reason:"unchanged", tokens:0, turnsSince:2, version:"mapv-fnv1a-6c09607b-12-400"}` |
| 抽取 | `{applied:2, screenedOut:0, screenedCounts:{scored0:0,scored1:0,scored2:1}, llmFailed:false, reason:"batch"}` |
| 只发「继续。」的一轮 | `screenedCounts:{scored0:0, scored1:1, scored2:0}`；`gate:{skipped:false, reason:"tool-evidence"}` |
| `stuck` / `recovered` | `null`（本轮没有触发，未验证） |

## 这组数据说明了什么

1. **B3 的三条分支都在真宿主里跑到了**：`full`（启动 131 token）→ 事实变化时 `diff` → 无变化时 `skip`。
   `version` 字符串里带着可见条数与 400 预算（`…-12-400`），和离线断言的口径一致。
2. **B1 的"宁可给 1 分"规则在真机生效**：「继续。」本身是 0 分，但那一轮模型调用了工具，
   我的 `screenTurns` 把该组升到 1 分（`scored1:1`），随后是**既有的内容门**以 `tool-evidence` 跳过。
   也就是说：这条消息没有被当成"纯填充句"静默丢掉。
3. **抽取与筛掉的计数都真的写进了 `lastExtract`**，前端运行记录页读的就是这些字段。
4. **单写者锁在真实并发下是"拒绝"而不是"写坏"**：桌面版与本机 web 宿主同时开同一库时，写被明确拒绝。

## 没验证到的

1. **`screen` 整窗口丢弃没有真机样本**：要触发它需要"只有填充句、且这一轮模型没调工具"的窗口；
   本次两条候选都被工具证据救回。0 分本身的判定只在 p75 的夹具里验证过。
2. **`stuck` / `recovered` 没有真机事件**：要么等一次真的 30 秒超时，要么人为掐断，本次没做。
3. **B2 地图热度没有样本**：模型这几轮没有走 `ctx_read` 命中路径，`usage` 旁路文件是否按 60 秒节流写盘未观测。
4. **medium 布局档**（900–1199 卡片宽）仍然只有结构测试——宿主设置弹窗固定约 600px。

## 副作用与清理

- 第一轮在**仓库工作区**写入的 5 个测试节点（id 17–21，含一条错误的"这个仓库用 pnpm"）已通过
  `POST /nodes/<id>/delete` 删除，随后核对列表恢复为原有 8 条可见节点。
- 临时登记的 `workspace.json` 已用备份还原（`s0-ws` 条目 0 条），`.tmp/s0-ws` 已删除。
- 测试期间新建的几个会话仍留在宿主会话列表里（标题为"仓库使用 pnpm 及测试命令""认证令牌轮换周期"等），
  可在侧栏归档；没有删除它们，避免误删你的会话。
