# dsh-trivium 0.7.0 发布说明

状态：**已发布**。npm `dsh-trivium@0.7.0` 于 2026-10-28T07:33:32.881Z 发布，`latest` 指向 0.7.0。
本页是发布回执与发布前证据；本轮未发布修改不自动属于该包。当前状态与后续验收见 [文档入口](README.md)。

产物 shasum `14545bd60a6b3dafaf3afa049873dfa5b1dfeb3c`，37 个文件，与本地 `npm pack` 一致。

0.7.0 是可观测性版本：把已经存在的更正队列和版本链体检暴露到设置页，并补上侧车失败的故障注入回归。记忆格式、默认值和四个工具均未变。

## 本次变更

**更正可见**

- 账本记录最近真正送达的更正（`sentCorrections`，账本最多 20 条；API 返回最近 10 条，UI 展示最近 3 条）。
- 新增 `GET /api/dsh-trivium/corrections?cwd=`，按会话返回 `pending` / `sent`，并按工作区过滤。
- 设置 →「召回检查」新增「更正」区块：待发显示「下一条消息生效」，送达后显示「✓ #id … 最近已发送」。

**版本链体检入口**

- 新增 `GET /api/dsh-trivium/integrity?cwd=`，复用只读 `checkRevisionIntegrity(db)`。
- 设置 →「召回检查」新增「检查版本链」按钮，显示「版本链正常。已扫描 N / M」或问题列表。

**回归与文档**

- `smoke-p22` 新增 CORR-22（待发/已发、按工作区隔离）与 B3-22（旁路文件故障可见 + 重开 `bootstrap-write` 恢复 + 索引重建）。
- README / README.zh-CN 增加桌面端 `EPIPE` 排障说明（宿主 `electron-updater`，非插件）。

## 升级

- `npm install dsh-trivium@0.7.0`，或在 DSH 桌面端「插件」页升级。
- 0.6.0 用户可直接升级；没有数据迁移，v2 格式不变。
- 两个新接口是只读的；不改变注入、抽取、芯片或 Git 旁路行为。

## 验证

- `npm test`：23/23 脚本通过；`smoke-p22` 38 条、`smoke-p18` 43 条。
- Web 宿主 `@deepseek-ai/dsh@0.2.1-rc.4`：待发→已发、体检 3/1、Tab 顺序（19 个停靠点）、Escape 焦点归还。
- 桌面端 `@deepseek-ai/dsh@0.2.1-rc.3`（正常重启）：通过内部 API 验证版本字段仍为 0.6.0 的 0.7.0-preview 工作树，16 节点、启动注入 126 token、integrity 16/0、召回 150/300（#4/#3/#5）、无 EPIPE。**这不是正式 0.7.0 tarball 的桌面视觉／键盘验收**。
- 内核仍为 `triviumdb@0.9.0-beta.3`（精确锁定）。

## 已知限制

- 仅支持 900px 及以上宽度；390px 受宿主侧栏限制不可读。
- 同一工作区的 `.tdb` 只允许一个读写进程；第二个宿主得到 `409 DB_LOCKED` 的说明。
- 更正列表是进程内状态，重启后清空；没有持久化的「已发送」历史。
- 版本链体检只报告，不自动修复；清理误写期限用 `dsh-trivium-clear-until`。
- 多进程并发写、手机宽度、性能测试仍不在本版范围。
