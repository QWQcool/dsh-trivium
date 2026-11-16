# 文档入口

维护状态更新于 2026-11-16。安装和日常使用看[中文 README](../README.zh-CN.md) / [English README](../README.md)，接手开发先读 [CURRENT-STATE](CURRENT-STATE.md)。

## 发布状态

| 范围 | 记录 |
|---|---|
| 已发布包 | `dsh-trivium@0.8.9`，tag `v0.8.9`，见[回执](release-0.8.9.md) |
| 运行依赖 | 当前源码 `triviumdb@0.9.1`；npm 发布包仍为 `0.9.0` |
| 已验证宿主 | Web `0.2.2-rc.1`；桌面 `0.2.2-rc.3` 隔离宿主已验证源码包，具体边界见当前状态 |

## 日常维护

| 目的 | 文档 |
|---|---|
| 现在到哪一步、哪些结论作废 | [CURRENT-STATE](CURRENT-STATE.md) |
| 低成本记忆、Super Agent、TDB 开发顺序 | [ROADMAP](ROADMAP.md) |
| 产品契约、模块与并发 | [PLAN](../PLAN.md) · [芯片与会话层](../PLAN-session-map.md) |
| 环境、按主题回归、实验入口 | [DEVELOPMENT](DEVELOPMENT.md) |
| HTTP、TQL、快照、实体搜索 | [read-api](read-api.md) |
| 请求、token 与费用 | [COST-MODEL](COST-MODEL.md) |
| 自动合并为何仍默认关 | [IDENTITY-CORPUS](IDENTITY-CORPUS.md) |
| 小型可重复示例 | [guide-example](guide-example.md) |
| 发布步骤 | [release-checklist](release-checklist.md) |

## 按需追溯

| 主题 | 记录 |
|---|---|
| 实体检索 | [后端](reviews/ENTITY-SEARCH-BACKEND-2026-11-12.md) · [面板](reviews/ENTITY-SEARCH-PANEL-2026-11-13.md) |
| 向量与检索质量 | [结果](reviews/LOCAL-EMBEDDING-READ-RESULTS-2026-11-12.md) · [融合归因](reviews/F-EMB-04-ATTRIBUTION-2026-11-12.md) · [范围实验](reviews/SCOPED-TEXT-CAPABILITY-2026-11-12.md) |
| 写延迟和批处理 | [测量结果](reviews/WRITE-LATENCY-RESULTS-2026-11-12.md) |
| 发布/复审 | release-*.md · [0.8.9 验收](reviews/0.8.9-RESULTS-2026-11-12.md) |
| 旧计划、实验修正、原文位置 | [HISTORY](HISTORY.md) |
| 原始测量 | [evidence](evidence/README.md) · [写入/宿主证据](next-memory/evidence-write-provenance) |

一个结论维护一个入口。任务写 ROADMAP，完成后更新状态；不再复制开工提示词和机器交接稿。历史发布回执和失败数据按原日期保留，现状在 HISTORY 说明。本地链接和版本声明由 `npm run test:docs` 检查。
