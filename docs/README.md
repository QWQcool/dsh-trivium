# 文档入口

维护状态更新于 2026-11-23。安装和日常使用看[中文 README](../README.zh-CN.md) / [English README](../README.md)，接手开发先读 [CURRENT-STATE](CURRENT-STATE.md)。

## 发布状态

| 范围 | 记录 |
|---|---|
| 已发布包 | `dsh-trivium@0.9.3`，tag `v0.9.3`。 [中文发布回执](release-0.9.3.md) · [English](release-0.9.3.en.md) |
| 本地发布候选 | 0.9.4，尚未发布。 [中文候选说明](release-0.9.4.md) · [English](release-0.9.4.en.md) |
| 运行依赖 | npm 包固定 `triviumdb@0.9.3`。已有格式 15 库先留存再打开，格式 13 走离线迁移。 [内核升级、失败恢复与回退](kernel-upgrade.md) |
| 已验证宿主 | Web `0.2.2-rc.1`；桌面 `0.2.2-rc.3` 隔离宿主已验证源码包，具体边界见当前状态 |

## 日常维护

| 目的 | 文档 |
|---|---|
| 开发中新增、改进、删除与升级影响 | [UNRELEASED](UNRELEASED.md) · [五项统一结果](reviews/NEXT-MEMORY-2026-11-17.md) · [回退、桌面和真实对照](reviews/NEXT-DELIVERY-2026-11-18.md) |
| 按需工具、抽取恢复及文档片段 | [实现与测量](reviews/TASK-RETRIEVAL-WRITE-DOCS-2026-11-18.md) |
| Super Agent 项目/工单交接协议 | [handoff-protocol](handoff-protocol.md) |
| 现在到哪一步、哪些结论作废 | [CURRENT-STATE](CURRENT-STATE.md) |
| 低成本记忆、Super Agent、TDB 开发顺序 | [ROADMAP](ROADMAP.md) |
| 实体面板与记忆评测的任务交接 | [AI-TASK-HANDOFF](AI-TASK-HANDOFF.md) |
| 产品契约、模块与并发 | [PLAN](../PLAN.md) · [芯片与会话层](../PLAN-session-map.md) |
| 环境、按主题回归、实验入口 | [DEVELOPMENT](DEVELOPMENT.md) |
| HTTP、TQL、快照、实体搜索 | [read-api](read-api.md) |
| 请求、token 与费用 | [COST-MODEL](COST-MODEL.md) |
| 来源待核对、任务记忆包与 C4 对照 | [2026-11-17 结果](reviews/MEMORY-EVAL-2026-11-17.md) |
| 真实模型对照、写入去冗余与来源核对入口 | [本轮结果与消耗](reviews/MEMORY-QUALITY-2026-11-17.md) |
| 正式桌面质量版安装与数据保留 | [2026-11-17 更新回执](reviews/DESKTOP-QUALITY-UPDATE-2026-11-17.json) |
| 自动合并为何仍默认关 | [IDENTITY-CORPUS](IDENTITY-CORPUS.md) |
| 小型可重复示例 | [guide-example](guide-example.md) |
| 发布步骤 | [release-checklist](release-checklist.md) |
| 工作区整组迁移与失败恢复 | [内核升级与回退](kernel-upgrade.md) |

## 按需追溯

| 主题 | 记录 |
|---|---|
| 实体检索 | [后端](reviews/ENTITY-SEARCH-BACKEND-2026-11-12.md) · [面板](reviews/ENTITY-SEARCH-PANEL-2026-11-13.md) |
| 向量与检索质量 | [结果](reviews/LOCAL-EMBEDDING-READ-RESULTS-2026-11-12.md) · [融合归因](reviews/F-EMB-04-ATTRIBUTION-2026-11-12.md) · [范围实验](reviews/SCOPED-TEXT-CAPABILITY-2026-11-12.md) |
| 写延迟和批处理 | [测量结果](reviews/WRITE-LATENCY-RESULTS-2026-11-12.md) |
| 发布/复审 | [0.9.3 发布回执](release-0.9.3.md) · [0.9.2 发布说明](release-0.9.2.md) · [0.9.1 发布说明](release-0.9.1.md) · [0.9.0 回执与沿用证据](release-0.9.0.md) · [0.8.9 验收](reviews/0.8.9-RESULTS-2026-11-12.md) |
| 0.9.4 使用和限制 | [任务记忆变更](read-api.md#任务记忆变更) · [选定来源内查找原文](read-api.md#在选定文档来源内查找原文) · [已知读取限制](release-0.9.4.md#修复) |
| 旧计划、实验修正、原文位置 | [HISTORY](HISTORY.md) |
| 原始测量 | [evidence](evidence/README.md) · [写入/宿主证据](next-memory/evidence-write-provenance) |

一个结论维护一个入口。任务写 ROADMAP，完成后更新状态；本轮两项任务的执行说明集中在一份交接文件，不再分散复制。历史发布回执和失败数据按原日期保留，现状在 HISTORY 说明。本地链接和版本声明由 `npm run test:docs` 检查。
