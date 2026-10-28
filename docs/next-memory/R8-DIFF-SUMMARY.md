# R8 未提交改动说明（供审查）

状态：**已提交并发布为 0.7.0**（版本提交 `4fe638f`，tag `v0.7.0`，npm 2026-10-28T07:33:32Z，shasum `14545bd6…`）。以下保留审查时的改动说明。

范围：`git diff --stat` 显示 7 个文件、+283 / -8；另有一份新增的验收记录 `R8-VERIFICATION-2026-10-28.md`。

## 一、文件级改动

| 文件 | 改动 | 目的 |
|---|---|---|
| `lib/turn-ledger.js` | +34 | 账本新增 `sentCorrections`（最近 20 条）；新增 `correctionSessions(cwd)`，按会话返回 `pending` / `sent`，并按工作区过滤 |
| `lib/server.js` | +24 | 新增 `GET /api/dsh-trivium/corrections` 与 `GET /api/dsh-trivium/integrity` |
| `lib/client.js` | +130 | 「召回检查」页签新增「更正」区块（待发 / 最近已发送）与「版本链体检」按钮；召回页签加载时同时拉取更正 |
| `scripts/smoke-p22.mjs` | +95 | 新增 CORR-22（待发/已发、按工作区隔离）与 B3-22（旁路文件故障可见 + 重开恢复 + 索引重建）；共 38 条断言 |
| `scripts/smoke-p18.mjs` | +6 / -2 | 更新「按页签加载」断言以覆盖 `loadCorrections()`；新增 `/corrections`、`/integrity` 端点契约 |
| `README.md` | +1 | 排障表新增桌面端 `EPIPE` 条目 |
| `README.zh-CN.md` | +1 | 同上（中文） |
| `docs/next-memory/R8-VERIFICATION-2026-10-28.md` | 新增 | 本轮验收证据：D2、C1、C3、B3、B4、E1、E2 |

## 二、新增接口

### `GET /api/dsh-trivium/corrections?cwd=...`

```json
{
  "ok": true,
  "cwd": "...",
  "sessions": [
    {
      "sessionId": "session-...",
      "cwd": "...",
      "pending": [{ "id": 2, "note": "已被 #3 替代；后续请以 #3 为准。", "queuedAt": 1793165847730 }],
      "sent": [{ "id": 2, "note": "已被 #3 替代；后续请以 #3 为准。", "at": "2026-10-28T05:39:03.013Z" }]
    }
  ]
}
```

- `pending` 是还没送达的更正（下一条消息生效）。
- `sent` 是最近真正送达的更正（最多 10 条），**进程重启后清空**（账本本来就是内存态）。
- 按 `cwd` 过滤；`cwd` 缺省时用当前活动工作区，未知 `cwd` 按空处理。

### `GET /api/dsh-trivium/integrity?cwd=...`

```json
{ "ok": true, "cwd": "...", "nodes": 16, "edges": 0, "issues": [] }
```

- 复用 `checkRevisionIntegrity(db)`，只读；不修链、不写库。
- 报告 `self-loop` / `cycle` / `fork` / `duplicate-uri` / `missing-endpoint` / `unresolved` 等。

## 三、界面变化

只在设置 →「Trivium 记忆」→「召回检查」：

- **版本链体检**：一个「检查版本链」按钮；成功显示「版本链正常。已扫描 N / M」，有问题显示 `#id code` 列表。
- **更正**：按会话列出待发更正（`#id + note + 下一条消息生效`）与最近已发送（`✓ #id + note + 最近已发送`）；没有时显示「没有待发送或最近发送的更正」。
- 这两个区块的数据只在打开召回页签时拉取，不在列表页常驻请求。

## 四、测试

| 命令 | 结果 |
|---|---|
| `npm test` | **23/23** 通过 |
| `node scripts/smoke-p22.mjs` | **38 条**（原 25 + CORR-22 7 + B3-22 6） |
| `node scripts/smoke-p18.mjs` | **43 条** 通过 |
| 真实宿主（Web `0.2.1-rc.4`） | 待发→已发、体检 3/1、Tab 顺序、Escape 焦点归还 |
| 真实桌面端（`0.2.1-rc.3`，重启后） | 版本 0.6.0；16 节点；启动注入 126；integrity 16/0；召回 150/300（#4,#3,#5）；无 EPIPE |

## 五、审查重点

1. `turn-ledger.js`：`sentCorrections` 账本保留 20 条，接口返回最近 10 条，界面展示最近 3 条；`correctionSessions` 的 `cwd` 匹配逻辑（空 cwd 不过滤）。
2. `server.js`：两个 GET 都走 `dbForRequest` / `getActiveCwd`，没有新增写入路径。
3. `client.js`：只读展示；没有新增自动请求；`loadCorrections` 与 `loadTraces` 同一 effect，切走页签不会继续拉。
4. `smoke-p22` 的 B3：故意把 `.jsonl` 换成同名目录制造失败，验证 health 变红、重开 `bootstrap-write` 恢复、索引重建、两条事实都在。
5. README 只加了 EPIPE 排障行；**0.7.0 的 Changelog 与 Release info 尚未写**，计划在打包时统一更新。

## 六、本轮不做 / 后续

- 版本号、CHANGELOG、Release info、`npm pack`、发布：等审查后做 `0.7.0`。
- 自动修复损坏的版本链：只提供只读体检与 `clear-until`，不自动改数据。
- 桌面端设置面板的**可视化**核对：桌面端无调试端口，本轮通过内部 API 验证；如需截图级确认可人工打开面板。
- 390px 手机宽度、多进程并发写、性能/负载：仍为范围外。
- 内核 `0.9.0` 稳定后从精确 pin 切 `^0.9.0` 并重跑 23 组 + `verify-package` + 真机。
