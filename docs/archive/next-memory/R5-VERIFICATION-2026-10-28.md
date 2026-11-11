# R4 / R5 验收记录（2026-10-28）

> **历史验收（R4 / R5，后续随 0.5.1 发布）**：下列版本、命令、输出和未覆盖项按当时记录保留。双标签页冲突在 R7 补充，更正 UI 在 R8 补充；当前覆盖矩阵见 [文档入口](../README.md)。

环境：Windows / Node 24.15.0 / DSH `0.2.1-rc.4`（Web，端口 3092，隔离 `DSH_HOME`）/ 内核 `triviumdb@0.9.0-beta.3` / 插件源码 0.5.0。
隔离方式：`DSH_HOME=<repo>\.tmp\dsh-home`、`DSH_TRIVIUM_SETTINGS=<repo>\.tmp\trivium.json`、测试工作区 `<repo>\.tmp\r5-ws`。未触碰真实工作区记忆库。

## R4 结果

| 项 | 结果 |
|---|---|
| 已投递事实表 | 账本按会话记录 `id → {type, l0, fingerprint}`；写路径（更新/归档/删除/合并/替代/撤销/导入）调用 `noteFactChanged()` |
| 指纹含状态 | `fingerprintOf(id, l0, record)` 纳入 type/until/stale/archived；截止期变化不再被当作同一条 |
| 更正消息 | 独立 `correction` 通道与独立消息块标题；不重发旧正文，不受归档/过期过滤影响 |
| 消费时机 | 只有更正真正随 reservation 提交后才从队列删除；超预算保留到下一轮 |
| JSONL 身份 | `applySidecar()` 移除正文回退，只按 URI 识别 |
| 只读体检 | `lib/integrity.js` + `scripts/check-integrity.mjs`；`accessMode: "readOnly"`，不重建索引、不写 WAL |

回归：`smoke-p21.mjs` **86 条**（新增 CTX-21-03/04、IO-21-07），全量 `npm test` **22/22**。

真机证据（隔离工作区）：

- 首轮提问「旧部署方式A」：模型调用记忆工具，回答引用 `memory#2/#3/#4/#5`（见 `evidence-r5/1440-memory-answer.png`）。
- 随后通过 HTTP 将 `#2 --supersedes--> #3`，再发「谢谢」：`/status.lastContextPlan` 显示
  `{records:[{id:2, channel:"correction", tokens:44}], budget:300}`。
- 模型第二轮回答：「后续以 #3 为准：部署方式A 现为多副本；#2 中『旧部署方式A 单机进程』仅作历史记录，不再作为现行事实引用。」
  —— 更正确实进入模型上下文，且没有重发旧正文。

## R5 结果

### 打包与安装

| 检查 | 结果 |
|---|---|
| `npm pack` | 35 个文件 |
| 独立消费目录 `npm install <tgz> dsh-llm@0.2.1-rc.4 dsh-tools@0.2.1-rc.4` | 25 个包，7.5s，无 force/legacy |
| `verify-package.mjs`（干净安装） | 13 项全部通过：注入、同轮去重、同轮累计 ≤300、**新 id 配新正文** |

### 真实宿主

| 检查 | 结果 |
|---|---|
| 插件加载 | 设置左侧出现「Trivium 记忆」，节点数 10，短地图 39/400 |
| 只读召回检查 | 一次查询返回 3 条候选、96 tokens；每条 tokens>0（修复前恒 0） |
| 多工具轮次 | 1 轮 3 步，模型实际调用记忆工具并引用节点 id |
| 过期 ETag | `POST /nodes/9/supersede` 携带旧 etag → **409 `code:"etag"`**「旧决策已在别处变更，请刷新后再确认。」；刷新后成功 |
| 键盘 | `Ctrl+Alt+,` 打开设置；Tab 顺序 模型 → 内置插件 → Agent 预设 → Trivium 记忆；Enter 打开；Escape 关闭，焦点回到输入框 |
| 390 宽 | `innerWidth=390`、`scrollWidth=390`（无横向溢出）；但对话框 342、侧栏 188、内容列 154、插件卡片 106 —— 不可阅读 |
| 1440 宽 | 面板与列表正常（`evidence-r5/1440-plugin-panel.png`） |

### 证据文件

- `evidence-r5/1440-plugin-panel.png`：1440 宽 Trivium 面板（10 节点、0.5.0）
- `evidence-r5/1440-memory-answer.png`：两轮回答；第二轮确认「以 #3 为准」
- `evidence-r5/390-plugin-panel.png`：390 宽被压成一字一行的实际形态

## 仍未覆盖 / 已知边界

1. **真实双窗口**：409 是客户端注入过期 ETag 制造的（与 REVIEW 的做法一致），不是两个真实浏览器窗口同时点击。
2. **390 宽**：只证明不横向溢出，不证明可用；需要「仅支持桌面」的范围确认，或宿主的全宽详情方案。
3. **多进程写同一 `.tdb`**：内核单写者契约，本轮只做了友好文案，不做并发写支持。
4. 性能/负载测试仍按计划后置。
5. 更正通知的界面展示：模型侧已生效，但插件没有单独的「已发送更正」UI 条目（状态页只显示计划通道）。
