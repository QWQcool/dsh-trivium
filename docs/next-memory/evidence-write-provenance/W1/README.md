# W1 证据：来源贯穿与可核验摘录

基线 `db35034`（0.8.2）。零模型调用、零费用。本目录只放脱敏结果，原始日志在 `.tmp/write-provenance/W1/`。

## 修前

- `p50-before.log`：运行时的 p50 在实现前直接 `ERR_MODULE_NOT_FOUND: lib/source-events.js`——即**没有**任何"把宿主 locator 带进写入"的能力。
- `before-source.json`：直接调用 0.8.2 的 `applyCandidates`（带 `sourceTurns` 也不会被使用），写出的节点来源只有
  `{capturedAt, kind, quote, sessionId, via}`，`hasLocator: false`。

## 修后

- `p50-after.log`：47/47。
- 全量 `run-all` 51/51（含 p27/p28 两个既有调度/重试回归）。

## 关键断言（p50）

| 组 | 断言 |
|---|---|
| 事件解析 | `seq` / `messageId` / `at`（毫秒时间戳转 ISO）/ `role` 全部来自真实事件；缺字段为 `null` 且 `recorded:false` |
| 自身注入 | `source.kind = plugin:*` 的 user 消息**不入缓冲**，不能当用户原文 |
| 角色 | assistant / tool 保留各自角色；assistant 的措辞不会被当成用户证据 |
| 摘录匹配 | 精确 > 部分 > 无；无匹配时角色 `unknown`，摘录仍展示 |
| 重放 | pending 往返不改 `messageId`/`seq`/`at`；重放写库的 `source.at` 是**源时间**，`capturedAt` 是处理时间，两者分开 |
| 去重 | 同一句两次 = 两个事件（按 `messageId`/`seq` 区分）；同一事件重试只登记一次 |
| 读投影 | `locatorKnown` 与 `recorded` 分开；`hostText` 恒为 `unavailable`（宿主无回读接口，不伪造跳转） |
| 旧数据 | 没有 `source` 的节点 `status:missing`、`source:null`；只有摘录的来源 `locatorKnown:false` |

## 已知边界

- 时间戳只有 `event.time`（毫秒）。事件没有时区字段，本片按主机本地时区解释，W3 会把锚点与解析规则写清。
- `hostText` 无法变为可用：插件没有"按消息 id 回读原文"的接口，因此永远显示"已保留摘录、无法跳转"。
- 本项目不复制会话，`quote` 上限 240 字符，来源只记一条（多源支持留给后续）。
