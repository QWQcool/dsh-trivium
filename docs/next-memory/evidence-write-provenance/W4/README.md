# W4 证据：有界的变更记录与"记忆变化"入口

基线 `db35034`（0.8.2）。零模型调用、零费用。

## 实现

| 位置 | 变化 |
|---|---|
| `lib/change-log.js`（新增） | 每工作区一份 JSONL 审计：写入/合并/替代/拒绝/日期调整/待确认/替代失败/恢复超时；上限 200 条，裁剪时写 `trim` 标记 |
| `lib/index.js` | `lastExtract` 补齐 `superseded`；抽取后按结果落审计；8 秒重放超时也记一条 `replay-timeout` |
| `lib/server.js` | `GET /api/dsh-trivium/changes?cwd=&limit=`，返回 `entries/trimmed/total/labels` |
| `lib/client.js` | 召回页新增"记忆变化"块：时间、原因标签（中/英）、来源（角色 · #seq · 消息 id 前 8 位）、摘录；超出保留期显式提示 |

## 红线（都有断言）

1. **审计永不进模型上下文**：只在 `readChanges` / 路由里读，没有任何注入路径调用它；针对相同合格事实，注入正文与预算不变（本片没有改动注入逻辑）。
2. **先脱敏再落盘**：`noteChanges` 对每条 `preview` 先过 `sanitizeForWrite`，不通过就写 `<redacted>`。p53 断言文件里搜不到 `ghp_`。
3. **有界**：超过 200 条裁剪最旧的，并写下 `dropped` 数量；读取返回 `trimmed`，UI 显示"更早的记录已超出保留范围"，不伪装完整历史。
4. **幂等**：每条记录带 `opId`，同一操作重复处理只保留一条（p53 断言）。
5. **按工作区隔离**：日志路径在各自 `cwd/.dsh/` 下，p53 断言两个工作区互不可见。
6. **失败要说**：审计写失败返回 `ok:false`（p53 用"父路径是文件"构造），`lastExtract` 旁边另有 `lastAuditError`；不宣称"记录完整"。
7. **状态可区分**：`written / merged / superseded / rejected / date-adjusted / pending-review / supersede-failed / replay-timeout` 各有独立原因码与中英文案（p53 逐码断言 label 存在）。

## 覆盖层级（重要）

| 层级 | 状态 |
|---|---|
| 模块单测（p53） | 30/30：写入、顺序、脱敏、幂等、裁剪、隔离、失败上报、结果映射 |
| 客户端契约（p18 源码级） | 48 checks 通过，含 4 条新增：调用 `/api/dsh-trivium/changes`、中英标签、`trimmed` 提示、行内有来源 |
| HTTP 路由 | **只做了源码路径与返回结构检查**，没有起真实 HTTP 服务打这个端点 |
| 视觉 / 键盘 / 明暗主题 | **未做**：没有截图，也没有以 Computer Use 走一遍 Tab/Enter/Escape |

即：本片"可查看"在**模块与源码契约层**成立，**渲染与键盘仍未验收**。

## 与计划的偏差

- 计划要求"尽量复用现有详情/版本历史/操作回执"，本片只是把块放进召回页，没有把条目和节点详情互相跳转（无深链）。
- 计划提到"恢复中"状态：只落了 `replay-timeout` 记录，UI 目前只作为一条普通记录显示，没有专门的"恢复中/恢复失败"图标。
