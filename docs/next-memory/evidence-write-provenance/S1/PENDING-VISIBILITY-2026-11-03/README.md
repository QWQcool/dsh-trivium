# 待补写窗口的可见性（2026-11-03）

基线 `main` @ `add329f`。零模型调用、零费用。

## 修前

抽取抢不到锁、失败或被中断时，窗口被写进 `<cwd>/.dsh/trivium-pending.json`，等下次会话启动重放。
但**面板看不到它**：设置页只有一个 `pendingPersistence.incomplete` 布尔（"写失败了"），
没有一个地方回答"现在到底有多少东西在等"。

后果正是 `S1/CONCURRENCY` 指出的那个风险——推迟只有在库还会被再次打开时才安全，
而运维看不到推迟，就没法判断"这个库还会不会被打开"。

## 修后

| 层 | 新增 |
|---|---|
| 读模型 | `lib/extract.js` 的 `pendingSummary(cwd)`：窗口数、事件总数、已确认数、文件 mtime、每个窗口的会话 id / 事件数 / **80 字单行预览** |
| 路由 | `GET /api/dsh-trivium/pending?cwd=`：已知工作区返回摘要，未知返回 400 |
| 面板 | 运行记录页新增「待补写」卡片：空态、错误态、刷新按钮；有内容时列出每个窗口 |
| 文案 | 中英各 8 条（`pendingTitle/pendingHint/pendingEmpty/pendingWindows/pendingTurns/pendingAck/pendingUpdated/pendingRefresh`） |

**只给计数与短预览，不搬运正文**：turn 文本可能很长，也不是回答"这里有没有东西"所必需的。
`acknowledged` 只给条数，键不外传。

## 验收

```
node scripts/smoke-p82.mjs   → 13/13（新增）
node scripts/smoke-p78.mjs   → 56/56（新增 2 条：卡片出现在运行记录页、不出现在记忆库页）
node scripts/smoke-p18.mjs   → 51 checks（正则按新增的 loadPending 更新）
node scripts/run-all.mjs     → 83/83（改前 82/82）
```

p82 覆盖：

| 断言 | 说明 |
|---|---|
| 没有 pending 文件 → 全零 | 不是错误 |
| 没有工作区 → `reason: "no-workspace"` | 不是抛异常 |
| 两个窗口 → 2 个窗口 / 5 条事件 / acknowledged 2 | 计数正确 |
| 每个窗口保留 id、条数、单行预览 | 预览去换行 |
| 300 字的正文被裁到 ≤80 字 | 不整段外传 |
| 摘要里搜不到完整正文与 acknowledged 键 | 只给计数 |
| `updatedAt` 是 ISO 且来自文件 mtime | 不伪造时间 |
| 坏文件 → `unreadable` + 错误串 | 降级 |
| 读一次后文件字节不变 | 只读 |
| `GET /pending` 已知工作区 200 且形状正确 | 路由级 |
| `GET /pending` 未知工作区 400 | 路由级 |

## 未覆盖 / 已知边界

1. **没有"立即重放"按钮**：重放由会话启动/下一轮触发，面板只显示不推进。加按钮需要定义"谁持有写锁"，
   与 Router 的落脚点绑在一起。
2. **窗口没有自己的时间戳**：`updatedAt` 是文件 mtime，多个窗口共用一个时间；要精确到窗口需改写入格式。
3. **只显示最近 80 字的预览**：够认出窗口，不够判断内容。
4. **acked 只给条数**：需要审计具体哪些事件已确认时，仍要读文件或走变更记录。
5. **未做真机截图**：卡片只在渲染级测试里验证过，宿主里的排版没有肉眼确认。
6. **不区分原因**：抢锁失败、抽取失败、被中断三种来源在文件里没有区分，卡片只能统一叫"待补写"。
