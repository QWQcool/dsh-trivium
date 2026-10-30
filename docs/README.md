# 文档入口与版本状态

更新：2026-10-30。安装和日常使用见 [中文 README](../README.zh-CN.md) / [English README](../README.md)；本文面向维护者。历史报告里的“当前”“未发布”“下一步”以报告日期为准，不是今天的指令。

## 先分清发布包与源码

| 范围 | 状态与证据 |
|---|---|
| npm 发布包 | `dsh-trivium@0.8.2`；2026-10-30 查询 `latest=0.8.2`。发布内容、验证和已知问题见 [0.8.2 发布说明](release-0.8.2.md)，标签 `v0.8.2` 指向 `db35034` |
| 当前 main 源码 | 在 `v0.8.2` 后包含写入来源、决策/日期保护、变更记录和抽取单写者改动；包版本字段仍为 0.8.2，**不表示这些后续改动已进入 npm 包**。以 `git log v0.8.2..HEAD` 和 [W1–W5 结果](next-memory/WRITE-PROVENANCE-RESULTS.md)、[W6 证据](next-memory/evidence-write-provenance/W6/README.md) 核对 |
| 依赖与运行时 | `triviumdb@0.9.0-beta.3` 精确锁定；Node `^22.19.0 || >=24`；实际依赖以 package、lock 和安装环境为准 |

当前源码的 W1–W5 报告记录离线和隔离宿主桩自验；HTTP 变更路由与 UI 视觉/键盘尚未实测，未做本批真实模型验证。W6 只保护抽取写入；工具写入和导入的并发未覆盖。历史结果中的“未发布、未合并”只描述当时：这些后续提交现在已在 `main`，但不在 `v0.8.2` 标签中。

## 按目的查找

| 需要 | 文档 |
|---|---|
| 安装、配置、数据权限和日常使用 | [中文 README](../README.zh-CN.md) / [English README](../README.md) |
| 可复现的跨会话记忆示例 | [离线演示与运行说明](guide-example.md) |
| 产品边界和会话层契约 | [PLAN.md](../PLAN.md) / [PLAN-session-map.md](../PLAN-session-map.md) |
| 发布内容与逐版回执 | [0.8.2](release-0.8.2.md)、[0.8.1](release-0.8.1.md)、[0.8.0](release-0.8.0.md)、[0.7.1](release-0.7.1.md)；[发布检查清单](release-checklist.md) |
| 当前源码变更和待验边界 | [W1–W5 结果](next-memory/WRITE-PROVENANCE-RESULTS.md) / [W6 单写者](next-memory/evidence-write-provenance/W6/README.md) |
| 真实模型合成测试 | [5 场景基线 A5](next-memory/A5-WIDER-BASELINE-2026-10-30.md) / [改口、否定 A10](next-memory/A10-REGRESSION-N10-2026-10-30.md) / [工作报告及 A1–A10 索引](next-memory/WORK-REPORT-2026-10-30.md) |
| 旧成本和对照实验的纠正 | [独立审查](next-memory/POST-081-REVIEW.md) / [R1–R2 修复](next-memory/R1-R2-RESULTS.md) / [历史证据清单](evidence/README.md) |
| 审查与回交 | [审查清单](next-memory/REVIEW_CHECKLIST.md) / [回交模板](next-memory/RESULT_TEMPLATE.md) |
| 历史 B–E 交接 | [归档入口](NEXT-IDE-PROMPT-0.7.1.md) / [B 结果](next-memory/B-RESULTS.md) / [C 结果](next-memory/C-RESULTS.md) |

## 怎样理解测试数据

离线测试、真实宿主配可控桩、真实模型、正式包消费和桌面 UI 是不同层次，不能互相替代。A5 的五个合成场景各重复五次，抽取进库 25/25、新会话回答 21/25；它是修复前的旧基线，不是当前产品的总体准确率。A10 的改口和否定各 10 次，新会话回答各 10/10；其中否定场景有 3/10 次准备阶段触发请求上限，且部分轮次由 agent 调用工具写入。它不等于自然抽取的通用成功率。

旧 D0/C4 部分实验臂重复种植，D1 未保留真实注入历史和短地图，D2 的早期弱命中不是语义准确率；不要用这些数据宣称公平横评、真实会话固定省钱或质量等效。原始文件与负面结果保留供复核；完整性校验只验证清单中的字节，不验证实验设计，也不覆盖所有证据目录。

## 历史材料与维护规则

`next-memory/` 包含多个阶段的设计、回交、失败、验收及原始证据，而不仅是某一版本的“当前计划”。`IMPLEMENTATION_PLAN.md`、`FRONTEND.html` 是历史规格；`RESULT.md`、`REVIEW-2026-10-28.md` 与相应 JSON/复现保留早期失败；`R5`、`R7`、`R8` 保留各自的验证层级。`BASELINE.json`、`TOOL_SCHEMA_BASELINE.json`、`ACCEPTANCE_CASES.json` 为冻结参考，不改成当前源码快照。各类 `evidence*` 目录和版本发布回执保留原始身份。

维护时在本页更新当前入口，不再新增并行的 START、HANDOFF 或 CURRENT 快照。过时计划可保留历史身份和后继链接，不能重写原始结果。默认抽取开启，远程模型可能产生网络流量和费用；芯片、自动召回、会话层、Git 旁路和远程 embedding 默认关闭。相同 `.tdb` 只支持一个读写进程；不要拿真实用户库做故障测试。
