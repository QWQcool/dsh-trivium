# 文档入口（维护者）

> **只读一页的话，读 [当前状态](next-memory/CURRENT-STATE.md)。** 它回答：现在发布的是什么、源码多了什么、哪些结论已经被推翻。

安装和日常使用看 [中文 README](../README.zh-CN.md) / [English README](../README.md)。本页面向维护者，2026-11-11 起只保留**在用的**文档；历史材料统一在 [`archive/`](archive/README.md)。

## 发布状态

| 范围 | 状态 |
|---|---|
| npm 发布包 | `dsh-trivium@0.8.8`（tag `v0.8.8` 指向本次发布提交；上一版 `0.8.7` → `e50358e`） |
| 内核 | `triviumdb@0.9.0`（0.8.5 引入，0.8.6/0.8.7 未再升级） |
| 已验证宿主 | `@deepseek-ai/dsh@0.2.2-rc.1`（2026-11-11 真机一轮；0.2.1-rc.4/rc.5 为历史基线） |
| 标签之后的源码改动 | [当前状态 §1](next-memory/CURRENT-STATE.md#1-发布包与源码) |

## 现在该看什么

| 需要 | 文档 |
|---|---|
| 现在到哪一步、哪些结论作废 | [CURRENT-STATE](next-memory/CURRENT-STATE.md) |
| 这一版发了什么 | [0.8.8 发布说明](release-0.8.8.md) / [English](release-0.8.8.en.md) |
| 下一步做什么、为什么挂起 | [待办与前置条件](next-memory/CURRENT-STATE.md#4-待办与前置条件) · [Super Agent 原始路线图](next-memory/ROADMAP-AND-SUPERAGENT.md) |
| 面板改进、发包顺序和本轮复核 | [记忆面板交互稿](design/MEMORY-PANEL-2026-11-11.html)（下载后用浏览器打开） |
| 替代提案如何确认或拒绝 | [现行契约](release-0.8.7.md) · [11 月 2 日的方案比较](next-memory/SUPERSEDE-CONTRACT-OPTIONS.md) |
| 事实去重的语料与基线 | [IDENTITY-CORPUS-2026-11-11](next-memory/IDENTITY-CORPUS-2026-11-11.md) |
| 成本口径 | [COST-MODEL](next-memory/COST-MODEL.md) |
| 复审与放行记录（0.8.7） | [报告](reviews/0.8.7-REPORT-2026-11-06.md) / [最终验收](reviews/0.8.7-FINAL-RESULTS-2026-11-10.md) |
| 原始证据（真机/并发/写入来源） | [evidence-write-provenance](next-memory/evidence-write-provenance/) |
| 发版步骤 | [发布检查清单](release-checklist.md) |
| 历史（2026-10 至 0.8.6 的计划、审计、失败记录） | [archive/](archive/README.md) |

## 维护规则

1. **一个事实只写一遍**：版本号与发布状态只在上表、`README.md`、`README.zh-CN.md` 和 `CURRENT-STATE.md` 出现，改版本时四处一起改，`scripts/smoke-p91.mjs` 会检查。
2. **新文档先落 `CURRENT-STATE` 或发布说明**；写完一次性的计划/结果，进 `archive/`，不要留在 `next-memory/` 顶层。
3. **历史文档不改**：`archive/` 里的内容按当时日期理解，里面的"当前/未发布/下一步"不是今天的指令。
4. **发布前跑** `node scripts/smoke-p91.mjs`，它会因为版本声明不一致而失败。
