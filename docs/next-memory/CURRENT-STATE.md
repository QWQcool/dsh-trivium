# 当前状态（单一入口）

> **动手前先读这一页。** 历史文档里的"当前 / 未发布 / 下一步"以它自己的日期为准，不是今天的指令。
> 本页只写"现在是什么状态、什么已经验过、什么别再重复"，细节仍在各自文档里。

更新于 **2026-11-12**。

## 1. 发布包与源码

| 范围 | 状态 |
|---|---|
| npm 发布包 | **`latest = 0.8.9`**，tag `v0.8.9`。实际产物与验收见[发布说明](../release-0.8.9.md)。 |
| 发布分支 | `release/0.8.4`、`release/0.8.5` 保留为当时的发布快照；两个 store 修复已用 parity 提交搬回 main（`8801fd6`、`4b0ad42`），**不需要合并** |
| 当前 main | 本版包含 #4 的预算和规则抽取开关、#5 的在线 TQL 与独立快照，以及 F88-R01/R02/R03/R06 修复。[公司机器验收](../reviews/0.8.9-RESULTS-2026-11-12.md) |
| main 领先发布包 | 芯片批量写、向量保护与回填、三类查询卡片；独立实体范围只读后端已验收，显式 semantic 请求，两路分别返回，未接入工具/自动召回/UI。[实体后端](../reviews/ENTITY-SEARCH-BACKEND-2026-11-12.md) · [写延迟](../reviews/WRITE-LATENCY-RESULTS-2026-11-12.md) · [本地向量与查询](../reviews/LOCAL-EMBEDDING-READ-RESULTS-2026-11-12.md) |
| 依赖 pin | `package.json` 要 `triviumdb@0.9.0`（正式版） |
| 本机实际内核 | 两台机器都已是 **`0.9.0`**（Administrator 机 2026-11-05 用 `npm install` 对齐，之前是 0.8.11）。跑测前仍建议自己查一次 |
| 宿主基线 | `@deepseek-ai/dsh@0.2.2-rc.1`（2026-11-10 实机启动验证）；README 里的 `0.2.1-rc.4` 已同步改掉 |

自查命令：`git rev-list --count v0.8.7..HEAD`、`node -e "console.log(require('triviumdb/package.json').version)"`。

## 2. 已验证（按证据强度分层，别混用）

| 层 | 结论 | 证据 |
|---|---|---|
| 0.8.9 成品 | 发布验收 `run-all` **86/86**。585／5000 节点负载 **148/148**，严格成品安装 **13 项**，真实 DSH **23/23**，停宿主后的快照查询/体检及四个 CLI help 通过。 | [2026-11-12 公司验收](../reviews/0.8.9-RESULTS-2026-11-12.md) |
| 本轮源码 | `run-all` **85/85**；p98 断言并入 p89，scripts 仍 120。真实本地向量 5000/5000 回填并重开验证；32 问对照；真实 DSH 查询卡片与设置保存通过。 | [本地向量与查询结果](../reviews/LOCAL-EMBEDDING-READ-RESULTS-2026-11-12.md) |
| 实体范围后端 | 新增协议/并发段 **35/35**，冻结新题 live/snapshot 各24道有答案题语义首选命中24/24；4道无答案/无关系题不确认答案。实际HTTP与独立worker通过，真实DSH三次HTTP通过。属于合成候选检索验收，不代表生成回答准确率。 | [接口、新题与边界](../reviews/ENTITY-SEARCH-BACKEND-2026-11-12.md) |
| 0.8.6 放行 | 收尾时 `run-all` **88/88**、`npm pack --dry-run` 49 文件、付费调用 0 次（¥0） | [`0.8.6-FINAL-RESULTS`](../archive/reviews/0.8.6-FINAL-RESULTS.md) |
| 0.8.7 放行 | `main@f9d72e9` 上的拒绝保护阻塞项已修；真实插件入口回归（含 pending replay 全链路）与日期反例通过；脚本仍 119 | [`0.8.7-FINAL-RESULTS`](../reviews/0.8.7-FINAL-RESULTS-2026-11-10.md) |
| 真实模型 + 合成夹具 | A5：抽取命中 25/25、进库 25/25、新会话答对 21/25；A10：改口/否定各 10/10 | `A5-WIDER-BASELINE`、`A10-REGRESSION-N10` |
| 真实宿主 + 桩模型 | R3 第一片采集预检 16/16；注入/预算/过期/坏链在真宿主成立 | `R3-HOST-RESULTS` 第三片前 |
| 真实宿主 + 真实模型 | R3 第二片：S1 通过；S2 落库是改写句、新会话答对；**S3 长尾失败**（`verify-QA-71` 丢失，0.8.2 修复后 11-01 复测通过） | `R3-HOST-RESULTS` §四 |
| 真机 UI | 设置页 1280 浅色可截；入口 = **账号菜单 → 设置**（`Ctrl+Alt+,`）→ 左侧「Trivium 记忆」 | 2026-11-01，`.tmp/r3/p1/` |
| 宿主 0.2.2 真机一轮 | 抽取 `applied: 2`（gate `tool-evidence`）、`mapInjections {skip:1, sessionStart:1}`、面板无报错；库已备份恢复 | 2026-11-11，`docs/reviews/0.8.7-FINAL-RESULTS-2026-11-10.md` 末节 |

## 3. 已推翻或降级的结论（不要再引用旧说法）

| 旧说法 | 现状 |
|---|---|
| 抽取降本"省 80%" | **撤回**。D3 按实际保留请求重算 = 15→15、费用不变 |
| 图记忆相对纯文本"零增益 / 等效" | **降级为不可判定**。旧脚本库未隔离、判据太松、14.7× 是价格比不是 token 比 |
| "公开 API 造不出坏链" | **错**。`ctx_remember` 的 `link_label` 原本可写 `supersedes`，已修 |
| 查询复杂度 n^1.75 | **不成立**，阶段测量不支持该拟合 |
| "必须加 `session/disposed` flush" | **不需要**，已有 `savePending` + `pending-replay` |
| "自动建 `supersedes` 边是安全的" | 默认 `supersedeMode=propose`。抽取只提议，旧决定和新决定都保有进入短地图的资格。面板确认需要候选 ID 和 ETag，保持原样也要校验 ETag。[现行提案接口](../release-0.8.7.md#由人确认且确认前会重新核对) |

## 4. 待办与前置条件

| 事项 | 下一步 |
|---|---|
| 下一步投入 | 先收集三类查询卡片的真实使用问题，再定大库扫描分页、上游异步查询/游标优先级。单次同步 flush 尖峰 F-LAT-01 仍在，内核和预算未改。[本轮结果与剩余事项](../reviews/LOCAL-EMBEDDING-READ-RESULTS-2026-11-12.md) |
| P1 向量召回与语义去重 | F-EMB-01/02 已修；F-EMB-04 已归因，实体范围独立后端已实现并验收两路候选，**尚未选择融合排序或接入工具**。无答案近邻和同实体文本噪声仍在，相似度身份合并继续关闭。[后端结果](../reviews/ENTITY-SEARCH-BACKEND-2026-11-12.md) · [范围实验](../reviews/SCOPED-TEXT-CAPABILITY-2026-11-12.md) · [归因对照](../reviews/F-EMB-04-ATTRIBUTION-2026-11-12.md) |
| P3 Router 常驻化 | 只读继承和 Router 原型已跑通，`scopeInheritance` 默认关。宿主提供 Router/Worker 接口后再做常驻集成。[只读继承](evidence-write-provenance/S1/INHERIT-READ-2026-11-03/README.md) · [三 Worker 结果](evidence-write-provenance/S1/THREE-WORKERS-2026-11-03/README.md) |
| R3 同质量净费用 | 第二片 S3 长尾于 11 月 1 日复测通过，第三片仍需真实宿主的 S2 边级证据。 |
| B 站 E1-B 与 REFERENCE | 前者等对方扩展点。后者的 A5 为 4/5，需人工复判“先否定后纠正”的回答。 |
| 恢复诊断 | 已观察到跨会话的过期锁恢复。真实宿主的 `extract-timeout` 和 `replay-timeout` 仍缺实测记录。[宿主记录与边界](evidence-write-provenance/S1/PRE-0.8.5-2026-11-04/README.md) |

其他 B/C 批遗留决策及修订过程见 [0.8.7 复审报告](../reviews/0.8.7-REPORT-2026-11-06.md)。

## 5. 别再重复做的实验

| 实验 | 为什么别重做 |
|---|---|
| R3 第二片 S1（姓名/端口/金额） | 已通过，见 `R3-HOST-RESULTS` §四 |
| R3 第二片 S3（长正文尾部） | 10-29 失败、**2026-11-01 复测已通过**（0.8.2 尾部保底生效） |
| A5 / A10 | 已 n=5 / n=10，重复只增加费用 |
| C3 三臂（无记忆 / 图+工具 / 纯文本） | 旧结论已降级，重跑前先读 `COST-QUALITY-RESULTS` 的修正口径 |
| 用 Trivium 面板工作区下拉做隔离 | 实测**只切视图**：默认库 13→14，面板选的库 1→1 |
| 用会话「选择工作区」做隔离 | 实测未改变写入目标，会话 cwd 固定 `Documents/deepseek-harness/default-workspace` |
| 重做 B1/B2/B3/B5 或"作用域抽象" | 阶段 0 已完成，具体边界见[阶段 0 证据](evidence-write-provenance/S0/)。 |
| 重做设置页四页化/命令面板 | 已在 0.8.4 发布（`release/0.8.4`）；只修实机缺陷，不要重新排版 |
| 按"每个会话都重发全量地图"估算 B3 收益 | 0.8.3 本来就只注入一次；B3 的对手是假想的每轮全量，对真实基线是"多几十 token 换新鲜度" |
| 重跑 0.8.6 放行验收 | 已放行并发布（`0.8.6-FINAL-RESULTS`）；再跑只是重复付费，除非代码有实质改动 |
| 再论证"自动建 supersedes 边" | 0.8.7 已定 P 路线（提案制）；再讨论请直接读 `0.8.7-REPORT` §2.3 的取舍，不要从零复现四个攻击案例 |

## 6. 真机实验的环境与方法（省下重新摸索的时间）

- 先用 `node -v` 核对当前运行时与宿主的 engines。11 月 1 日的走查使用了桌面版自带的 Node 24.21.0。
- 宿主：`node node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port <p>`，日志里会打印 `?token=` 的 URL。
- 11 月 1 日的截图使用 Chromium 和本地 CDP 脚本（`.tmp/r3/cdp-shot.cjs`）。
- **工作区隔离**取决于会话实际使用的 cwd。使用隔离的 `DSH_HOME` 后仍应核对写入目标。11 月 1 日默认工作区备份在 `.tmp/r3/backup-20261101-172142/`，当时已核对 md5。
- 抓包顺序：先 `GET /api/dsh-trivium/status?cwd=<ws>` 看 `lastExtract`，再拷贝 `.dsh` 用只读脚本查节点与边（不要对宿主正在用的库双开）。

## 7. 文档入口

按任务查找发布说明、设计稿、路线图和原始证据，见[维护者索引](../README.md)。

## 8. 历史版本记录

0.8.3 → 0.8.4 的阶段记录（四条工单、设置页四页化、0.8.4 发布回执）已移到
[`archive/next-memory/0.8.3-0.8.4-RELEASE-LOG.md`](../archive/next-memory/0.8.3-0.8.4-RELEASE-LOG.md)。
0.8.5 / 0.8.6 / 0.8.7 的发版回执见各自的 `docs/release-<版本>.md`。
