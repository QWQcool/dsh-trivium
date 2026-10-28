# 真实宿主交互证据（2026-10-27）

> **历史截图证据（0.5.0）**：保留图片与原始日志，不更新其日期或版本。后续缺陷修复、双标签页冲突及更正 UI 的证据分别见上级 R5 / R7 / R8；当前总览见 [文档入口](../../README.md)。

这一组截图来自**运行中的 DeepSeek Harness**，不是原型，也不是模拟数据。

## 环境

| 项 | 值 |
|---|---|
| 宿主 | `@deepseek-ai/dsh@0.2.1-rc.4`，`dsh web --port 3090` |
| 插件 | 本地源码 `Desktop/dsh-trivium` @ **0.5.0**，由 `DeepSeek_Harness/dsh-extra/install-trivium.cjs` 以 junction 挂到 `~/.dsh/profiles/web` |
| peer | 宿主自带 `@deepseek-ai/dsh-llm` / `dsh-tools@0.2.1-rc.4` |
| 工作区 | `C:\Users\Administrator\Documents\dshTest`（专门的试验目录） |
| 模型 | DeepSeek-V4.1-Flash（真实调用，用于产生一轮真实注入） |
| 浏览器 | `chromium-1248` headless，通过 CDP 驱动（无 Playwright 依赖） |

截图由 `evidence*.mjs`（Chrome DevTools Protocol 驱动）生成。因为本机工具沙箱在每次调用结束时回收子进程，**服务、浏览器、脚本必须在一次调用内跑完**，所以每轮都是「起服务 → 起浏览器 → 跑脚本 → 收工」。

## 截图对照

| 文件 | 证明什么 |
|---|---|
| `01-memory-entries-1440.png` | 设置页「Trivium 记忆」在 1440 宽下的记忆条目列表；顶部有「记忆条目 / 召回检查」两个页签，条目详情有「内容 / 来源 / 决策历史」三个页签；「显示过期决策」与「显示已替代」是两个独立勾选 |
| `02-source-tab.png` | **来源**页签显示 `来源类型 chip`、`记录时间`、真实摘录，以及「宿主没有提供会话跳转接口，因此不提供跳转」 |
| `03-history-tab.png` | **决策历史**页签（尚无替代关系时的状态） |
| `04-supersede-dialog.png` | 「确认替代关系」弹窗：并排展示**将被替代**与**新决策**两条已有决策，不是自动生成 |
| `05-dialog-filled.png` | 选择替代者并填写说明后的弹窗，提交按钮可用 |
| `06-conflict-409.png` | 用**过期 ETag** 提交后，服务端返回 409，弹窗显示「内容已在别处变更（409）。你的选择已保留，刷新后可以重试。」，并给出「刷新并重试」，用户的选择没有被清空 |
| `07-superseded-visible.png` | 替代成功后勾选「显示已替代」，旧版本重新出现在列表里，动作区变成「**查看当前版本**」而不是「撤销替代」 |
| `08-before-revoke.png` | 当前版本（新决策）展开后的动作区，带「撤销替代」 |
| `09-revoked.png` | 撤销之后：两个节点都只剩「替代… / 归档 / 删除」，重新独立；「撤销替代」按钮消失 |
| `10-recall-check-turn.png` | 「召回检查」页签：本轮预算条、入选条目、以及**最近召回诊断**——真实记录的分支 `native-hybrid → keyword-fallback → entity-anchor → same-as-normalize → business-expand` |
| `11-recall-preview.png` | 「运行只读检查」返回的真实候选与「将发送给模型的文本」，即 `dsh-trivium autoRecall (L0 only; ...)` 那段 |
| `12-turn-injected.png` | 一轮真实对话：模型回答里直接引用了注入的 `id 12 / id 13` 及其正文，说明注入内容真的进入了模型上下文 |
| `13-trajectory-injection.png` | **最强的一条**：轨迹视图里能看到两条插件上下文消息——`dsh-trivium autoRecall (...)` 与 `dsh-trivium memory map (...)`，紧接着是用户消息、`ctx_read {"id":15}` / `{"id":14}` 两次工具调用 |
| `14-width-900.png` | 900 宽：宿主设置弹窗仍是 800px（NAV 188 + 内容 612），插件卡片 559px，与 1440 一致，信息层级不变 |
| `15-width-390.png` | 390 宽：**无横向溢出**（`scrollWidth === innerWidth`），但内容只剩 101px —— 见下方「390 宽的真实边界」 |
| `16-dark-1440.png` | 深色主题下的同一面板 |

原始运行日志：`run.json`（完整流程）、`run-conflict.json`（409 → 重试 → 成功 → 撤销那一段）。日志里保存了每一步的返回值，例如：

- `read-success`: `已建立替代关系`
- `read-revoke`: `已撤销替代关系`
- `width-900` / `width-390`: `900x900` / `390x390`
- `read-turn-status`: `recallMode: auto`、`planBudget: 300`、`planTokens: 0`、`planRecords: []`

最后一行值得说明：那是该轮**最后一个** pre-step 的数字。同一轮第一次 pre-step 已经把召回块交付出去，所以余下的步骤计划为空——这正是「同一用户轮的工具循环不重复注入」的行为，而不是没生效。轨迹截图里能看到第一次交付的那段文本。

## 这轮真机跑出来的问题

1. **`remainingOf is not defined`（已修）**。`lib/index.js` 用了 `remainingOf` 但没 import，`agent/pre-step` 在第一个真实轮次就抛错并被兜底吞掉，表现为「芯片/召回开了却什么都不注入」。离线套件只做源码级断言，抓不到这类未定义标识符；现在 `scripts/verify-package.mjs` 增加了**运行时** pre-step 检查（用真实 peer 驱动一次 pre-step，断言注入块存在且 ≤300 估算 token、同轮第二步不重复），这类 bug 会被打包验证挡住。
2. **409 提示文案重复（已修）**。冲突横幅把「内容已在别处变更（409）…」和同义的服务端句子拼在一起，现在 `code` 为 `etag` 时只显示前者；其它 409 原因（循环、线性链限制等）仍会带上服务端说明。

## 390 宽的真实边界

`measure-narrow.json` 记录了三个宽度下的实测盒子：

| 视口 | 弹窗 | NAV（宿主） | 内容列（宿主） | 插件卡片 |
|---|---|---|---|---|
| 1440 | 800 | 188 | 612 | 559 |
| 900 | 800 | 188 | 612 | 559 |
| 390 | 342 | 188 | 154 | **101** |

结论要分开说：

- **没有横向溢出**：三个宽度下 `document.documentElement.scrollWidth === window.innerWidth`（1440/900/390）。
- **插件自己的布局会收缩**：390 下「记忆条目 / 召回检查」两个页签的 `y` 分别是 7090 / 7124，即已经换行堆叠；两列栅格也退成单列。
- **但 390 仍然不可读**：宿主的设置弹窗保留了固定 188px 侧栏，扣掉内边距后卡片只有 101px，中文只能一字一行。这是宿主设置弹窗在手机宽度下的布局，插件无法通过自身 CSS 解决（把卡片强行撑成 `100vw` 会破坏宿主布局）。

所以：**900 以上的窄桌面完全可用；390 只证明「不产生横向滚动」，不证明「可用」**。DSH 桌面端的设置弹窗没有为手机宽度做适配，这一条作为已知边界记录，不作为插件缺陷。如果将来要支持窄屏，需要宿主先把设置弹窗在窄宽度下改成单栏。

## 边界（不要过度解读）

- 409 是**在客户端边界注入过期 ETag** 制造出来的（`window.fetch` 一次性改写 `expectedEtags`），不是两个真实浏览器窗口各开一份。服务端 409 与前端渲染都是真的，但「两个窗口」这个场景本身是用故障注入模拟的。
- 截图里的 `dshTest` 工作区是本轮试验目录，累积了多轮证据轮次的测试节点（`证据轮 <tag>` 字样）。用户自己的 `AIRP` / `AICodingPrjStudy` / `TriviumDB` 没有被写入。
- 为了产生真实注入，脚本临时把「注入策略」切到 `autoRecall`，结束时切回「关」；每轮结束的 `read-final-status` 都是 `recallMode: off`。
- 仍未覆盖：双窗口真实并发、`withWorkspaceQueue` 的跨进程行为、性能/负载。
