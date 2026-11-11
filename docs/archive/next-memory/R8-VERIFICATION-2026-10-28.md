# R8 验收记录（0.7.0 发布前验证，2026-10-28）

> **历史证据，状态已补正**：功能随后发布为 0.7.0；下列测试数据保留当时版本。桌面一节是 0.7.0-preview 工作树的 API 级验证，不是正式包的桌面视觉／键盘验收。当前覆盖矩阵见 [文档入口](../README.md)。

范围：B3 派生数据失败恢复、B4 键盘走查、C1 更正可观测性、C3 版本链体检入口、D2 deprecate 0.5.0、E2 桌面端 EPIPE 说明。
已作为 **0.7.0** 发布（2026-10-28T07:33:32Z，tag `v0.7.0`）。

## D2 — 0.5.0 已 deprecate

```
$ npm deprecate dsh-trivium@0.5.0 "known correctness issues; use 0.6.0"
registry: deprecated = known correctness issues; use 0.6.0
```

`npm view` 读到的是本地缓存里的旧文案；registry 直接查询已经是新文案。

## C1 — 更正可观测性

- 账本新增 `sentCorrections`（账本保留最近 20 条，接口返回最近 10 条，UI 展示最近 3 条），`correctionSessions(cwd)` 返回按会话分组的 `pending` / `sent`。
- 新增 `GET /api/dsh-trivium/corrections?cwd=`。
- 设置「召回检查」页新增「更正」区块：待发明细 + 「下一条消息生效」，送达后显示「✓ #id … 最近已发送」。

真机（隔离 `DSH_HOME`，3095）：

```json
{"pending":[{"id":2,"note":"已被 #3 替代；后续请以 #3 为准。"}],"sent":[]}
```

发送下一条消息后：

```json
{"pending":[],"sent":[{"id":2,"note":"已被 #3 替代；后续请以 #3 为准。","at":"2026-10-28T05:39:03.013Z"}]}
```

界面显示「会话 session-1b74 / #2 … 下一条消息生效」，送达后变成「✓ #2 … 最近已发送」。

## C3 — 版本链体检入口

- 新增 `GET /api/dsh-trivium/integrity?cwd=`，复用 `checkRevisionIntegrity(db)`（只读，不写库）。
- 「召回检查」页新增「检查版本链」按钮，显示「版本链正常。已扫描 3 / 1」；有问题时列出 `#id code`。

## B3 — 派生数据失败与重开恢复

`smoke-p22` 新增（真实文件故障，不是 mock）：

1. 写入旁路文件成功后，把 `.dsh/trivium.jsonl` 换成**同名目录**；
2. 再写一条事实并触发旁路调度 → `sidecarHealth().ok === false` 且带 error（失败可见，不是静默）；
3. 删掉目录后 `syncSidecarOnOpen` 返回 `bootstrap-write`，health 回到 ok；
4. 关闭重开：文本索引重建，`searchNodes` 命中两条事实，重建后的 JSONL 同时包含 `b3-1`、`b3-2`。

## B4 — 键盘走查（设置弹窗）

真实宿主逐次 Tab：

```
通用设置 → 模型 → 内置插件 → Agent 预设 → Trivium 记忆
→ 打开配置文件 → 关闭 → 保存设置 → 刷新 → 导出 JSON → 导出 Markdown
→ 导入 JSON → 检查更新 → 配置设置 → 记忆条目 → 召回检查
→ 查询输入框 → 运行只读检查 → 检查版本链 → 回到通用设置（焦点留在弹窗内）
```

- 「检查版本链」可通过键盘到达（TAB19）。
- Escape 关闭弹窗，焦点回到会话输入框。

## E2 — 桌面端 EPIPE 说明

README / README.zh-CN 的排障表新增一行：桌面端 `EPIPE: broken pipe, write` 来自 `electron-updater` 写已关闭的控制台管道，栈里没有插件；从开始菜单正常启动即可。

## 回归

- `npm test` **23/23**；`smoke-p22` 38 条；`smoke-p18` 43 条。
- 本节记录的验收时点尚未打包、改版本或推送；随后完成 0.7.0 发布，回执见 [发布说明](../release-0.7.0.md)。

## E1 — 桌面端（0.2.1-rc.3）复验

正常重启桌面端（父进程 `explorer.exe`，无 `--inspect` / `--remote-debugging-port`），通过其内部回环端口 `127.0.0.1:63301` 读取插件 API：

| 检查 | 结果 |
|---|---|
| 插件版本 | `0.6.0`（当前工作树） |
| 工作区 / 节点 | 仓库工作区，16 节点 |
| 启动注入 | `lastInjectTokens=126`，`lastInjectAt=2026-10-28T06:34:23Z`（重启时刻） |
| 版本链体检 | `ok:true`，`nodes:16`，`edges:0`，`issues:[]` |
| 更正接口 | `ok:true`，`sessions:[]`（重启后账本为空，符合预期） |
| 只读召回 | `tokens:150 / 300`，`records:[4,3,5]`，`semantic:not_run` |
| 主进程错误 | 无 EPIPE 弹窗；新进程由 explorer 启动、无调试参数 |

说明：桌面端加载的是未提交的 0.7.0-preview 工作树代码（`integrity` / `corrections` 两个新接口可访问），因此本次同时验证了 rc.3 宿主兼容性与本轮新增接口。

## 仍未完成

- 桌面设置面板的视觉／键盘、两个独立浏览器进程的 409、从宿主 UI 触发导入派生失败，未由本次记录覆盖。
- 390px、多进程并发写、性能测试仍是本版既定范围外。
