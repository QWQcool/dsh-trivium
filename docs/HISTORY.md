# 历史与修订

更新：2026-11-16。旧的一次性开工提示、交接稿、分项计划和逐条结果已合并到本页，减少维护入口。原始 JSON、截图、发布说明和回归继续保留；被合并的全文可按下方固定提交链接读取，也可用 git show 47b01749d44863e4008629c5c3adba425271c02d:<旧路径> 查阅。

当前事实看 [CURRENT-STATE](CURRENT-STATE.md)，计划看 [ROADMAP](ROADMAP.md)，执行方法看 [DEVELOPMENT](DEVELOPMENT.md)。本页不会把旧的模拟/小样本成绩改写为今天的真实验收。

## 已完成的阶段

| 阶段 | 当前结论与后继 | 可查依据 |
|---|---|---|
| 0.5–0.7.1 的 M0/M1/M2、R4–R8 | 同轮预算、来源、决策链、诊断与维护 CLI 已实现；旧开工模板不再执行 | 各版本 release 说明、现存对应 p 用例 |
| B 批界面与回执 | 设置页交互后续已多次修订；当前架构见 PLAN，不能拿旧 HTML 当今天的完整规格 | 保留的设计 HTML、0.8.8/0.8.9 报告 |
| A1–A10、R1/R2 | 指令句吞事实、尾部截断、空抽取、敏感值、改口/否定、日期、重放与压缩后地图均有修复记录和回归 | 抽取/修订主题集合及 p44、p47、p51 等 |
| W1–W5、F-W04/F-W05 | 来源引文验证、人工替代、变更记录、锁与 pending 保留已经落地；恢复实测仍有补口 | next-memory/evidence-write-provenance 与当前回归 |
| 0.8.3–0.8.6 的借鉴项 | 热度、增量地图、诊断、MemoryWriter、继承/Router 原型已存在；快筛变为观察信号 | release-0.8.6、p70/p74–p86、对应证据 |
| 0.8.7 | 默认人工提案替代，拒绝保护和日期守卫完成；不再按 A6/W2 旧方案自动批准替代 | release-0.8.7 与最终复审记录 |
| 0.8.8 → 0.8.9 | 0.8.8 独立验收发现错库删除等问题；0.8.9 修复并发布在线查询/快照/CLI | 独立验收、0.8.9 发布和验收记录 |
| 0.8.9 后的源码 | 写批处理、本地向量与查询卡片、实体范围后端/面板已实现；面板仍需真机走查 | 当前 reviews 目录和 CURRENT-STATE |

## 被撤回或更新的实验结论

- “抽取省 80%”已撤回：D3 按实际保留请求重算为 15→15，费用不变。不能把重复/失败请求删掉后当成节省。
- “图记忆相对纯文本零增益/等效”不可判定：旧库隔离和字符串评分有问题；14.7× 是价格比而非 token 比。先固定隔离、语料和判据再比较。
- A5 的 25/25 抽取/入库与 21/25 新会话答对是单模型合成小样本；A10 两场景各 10/10 不能合并成通用准确率。
- R3 长正文尾部在 10 月 29 日失败，11 月 1 日重测通过；第三片同质量净费用仍缺真实宿主 S2 边级证据。
- 原地自动建 supersedes 已改为人工提案；“公开 API 不可能写坏链”也被反例推翻并修复。
- 老版本本就不是每轮重发全量地图；增量地图的真实收益要与会话首启基线对照，不能引用假想的每轮全量。
- 向量检索已于 11 月 12 日用本地真实模型测量，不再是“没有端点所以未测”；数值/否定的同异分布仍重叠，自动身份合并保持关闭。

## 仍需补证与暂缓

真实宿主 extract-timeout/replay-timeout、R3 费用对照和 REFERENCE 人工复判仍需补证；B 站 E1-B 等外部扩展点。父库继承、Router 原型的成功不代表已接入长期运行的 Super Agent。下一步以 ROADMAP 的条件和优先级为准。

## 测试与文档迁移

历史 p 编号保留为 npm test 的筛选项，21 个较小测试模块合并为 5 个主题集合，每例仍单独进程/设置。更早的 p32→p44、p59→p58、p90/p98→p89、p94–p97→p93 已在原提交合并。历史日志里的旧文件名和通过数只记录当时执行，不能直接套到现在。

## 原文索引

下列原文固定在整理前源码，不作为新的开工指令。按阶段查明细时再展开。

| 旧文档 | 整理前原文 |
|---|---|
| 0.7.1 之后的 AI IDE 开工提示词 | [archive/NEXT-IDE-PROMPT-0.7.1.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/NEXT-IDE-PROMPT-0.7.1.md) |
| 归档（历史文档） | [archive/README.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/README.md) |
| 用 dsh-trivium 给 DeepSeek Harness 补上跨会话图记忆 | [archive/article-2026-update.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/article-2026-update.md) |
| 0.7.0 代码审计与修复记录 | [archive/bug-audit-2026-10-28.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/bug-audit-2026-10-28.md) |
| 文档审计与整理记录 | [archive/documentation-audit-2026-10-28.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/documentation-audit-2026-10-28.md) |
| FRONTEND.html 与当前前端的对照 | [archive/frontend-prototype-review-2026-10-28.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/frontend-prototype-review-2026-10-28.md) |
| 记忆与上下文插件调研：dsh-trivium 的位置和后续路线 | [archive/memory-plugin-landscape-2026-10-28.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/memory-plugin-landscape-2026-10-28.md) |
| 0.8.3 → 0.8.4 阶段记录（2026-11-03） | [archive/next-memory/0.8.3-0.8.4-RELEASE-LOG.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/0.8.3-0.8.4-RELEASE-LOG.md) |
| 0.8.6 最终范围（2026-11-06） | [archive/next-memory/0.8.6-SCOPE-2026-11-06.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/0.8.6-SCOPE-2026-11-06.md) |
| A-1：工具指令句不再吞掉事实（未提交） | [archive/next-memory/A1-FACT-LOSS-FIX-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/A1-FACT-LOSS-FIX-2026-10-30.md) |
| A-10：把两个已修场景拉大到 n=10 | [archive/next-memory/A10-REGRESSION-N10-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/A10-REGRESSION-N10-2026-10-30.md) |
| A-2：长文本尾部漏记的定位（真实报文级） | [archive/next-memory/A2-LONG-TEXT-DIAGNOSIS-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/A2-LONG-TEXT-DIAGNOSIS-2026-10-30.md) |
| A-3：抽取质量基线（非敏感夹具，3 场景 × 3 重复） | [archive/next-memory/A3-EXTRACTION-BASELINE-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/A3-EXTRACTION-BASELINE-2026-10-30.md) |
| A-4：凭据值闸门（补 A-3 暴露的缺口） | [archive/next-memory/A4-SECRET-VALUE-GATE-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/A4-SECRET-VALUE-GATE-2026-10-30.md) |
| A-5：扩样基线（5 场景 × 5 重复）与一次失败的压缩尝试 | [archive/next-memory/A5-WIDER-BASELINE-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/A5-WIDER-BASELINE-2026-10-30.md) |
| A-6：改口时自动退休旧决策（A-5 CORRECTION 缺口的修法） | [archive/next-memory/A6-DECISION-SUPERSEDE-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/A6-DECISION-SUPERSEDE-2026-10-30.md) |
| A-7：先重放 pending，再建短地图（修 “地图说 decisions=0” 的取用缺口） | [archive/next-memory/A7-REPLAY-BEFORE-MAP-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/A7-REPLAY-BEFORE-MAP-2026-10-30.md) |
| A-8：清掉凭空写出来的绝对日期 | [archive/next-memory/A8-DATE-GUARD-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/A8-DATE-GUARD-2026-10-30.md) |
| A-9：真实压缩后的跨会话召回（补上 A-5b 的空白格） | [archive/next-memory/A9-COMPACTION-RECALL-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/A9-COMPACTION-RECALL-2026-10-30.md) |
| 0.8.6 最终复核提示词 | [archive/next-memory/ASTRA-REVIEW-PROMPT-0.8.6.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/ASTRA-REVIEW-PROMPT-0.8.6.md) |
| B 批回交结果（B1–B5） | [archive/next-memory/B-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/B-RESULTS.md) |
| B站偏好筛选适配计划 | [archive/next-memory/BILI-ADAPTER-PLAN-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/BILI-ADAPTER-PLAN-2026-10-30.md) |
| B站适配 E0 / E1-A 结果（未提交、未发布） | [archive/next-memory/BILI-E0-E1A-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/BILI-E0-E1A-RESULTS.md) |
| C 批结果汇总与独立复核 | [archive/next-memory/C-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/C-RESULTS.md) |
| C 批回交复核与 P0 修复 | [archive/next-memory/C-REVIEW-2026-10-29.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/C-REVIEW-2026-10-29.md) |
| C3 场景集（10 个 pilot 场景） | [archive/next-memory/C3-SCENARIOS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/C3-SCENARIOS.md) |
| C4 对手池与取舍（不是排行榜） | [archive/next-memory/C4-COUNTERPARTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/C4-COUNTERPARTS.md) |
| C4 对照预注册（写于跑真实模型之前） | [archive/next-memory/C4-PLAN.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/C4-PLAN.md) |
| C4 结果：两个对手的验装与同语料注入对照 | [archive/next-memory/C4-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/C4-RESULTS.md) |
| 0.8.2 基线与陪伴记忆方案借鉴 | [archive/next-memory/COMPANION-REFERENCE-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/COMPANION-REFERENCE-2026-10-30.md) |
| 改口不建 supersedes 边：成因与最小修复方案 | [archive/next-memory/CORRECTION-CHAIN-ANALYSIS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/CORRECTION-CHAIN-ANALYSIS.md) |
| 评测与成本修复：预注册（2026-10-29） | [archive/next-memory/COST-QUALITY-PLAN.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/COST-QUALITY-PLAN.md) |
| 判据、公平对照与成本收尾 | [archive/next-memory/COST-QUALITY-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/COST-QUALITY-RESULTS.md) |
| D0：先修完整性，再重跑对照（Step 0–3） | [archive/next-memory/D0-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/D0-RESULTS.md) |
| D1 预注册：记忆是否让「更激进的压缩」变得可行（写于付费请求之前） | [archive/next-memory/D1-PLAN.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/D1-PLAN.md) |
| D1 结果：记忆让「压缩」变得安全，但省不省钱取决于会话长度与抽取成本 | [archive/next-memory/D1-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/D1-RESULTS.md) |
| D2 抽取成本专项：检索省下的钱，被写入吃掉多少 | [archive/next-memory/D2-EXTRACT-COST.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/D2-EXTRACT-COST.md) |
| D3：抽取门控、S07 失败类归因与 50k 档实测 | [archive/next-memory/D3-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/D3-RESULTS.md) |
| E1-B 第一片：消费端可校验 + 英文凭据规则收窄 | [archive/next-memory/E1B-CONSUMER-VERIFY-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/E1B-CONSUMER-VERIFY-2026-10-30.md) |
| 0.5.1 开工计划（执行版） | [archive/next-memory/EXECUTION_PLAN-0.5.1.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/EXECUTION_PLAN-0.5.1.md) |
| F-W04 / F-W05 收尾结果 | [archive/next-memory/F-W04-F-W05-RESULTS-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/F-W04-F-W05-RESULTS-2026-10-30.md) |
| 0.5.1 正确性修复开工计划 | [archive/next-memory/FIX_PLAN-2026-10-28.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/FIX_PLAN-2026-10-28.md) |
| Trivium 记忆可信度升级实施计划 | [archive/next-memory/IMPLEMENTATION_PLAN.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/IMPLEMENTATION_PLAN.md) |
| 当前检查与下一轮开工顺序 | [archive/next-memory/NEXT-PLAN-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/NEXT-PLAN-2026-10-30.md) |
| 0.8.0 会话之后的独立审查与下一步 | [archive/next-memory/POST-081-REVIEW.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/POST-081-REVIEW.md) |
| R1/R2 修复与自验（未发布） | [archive/next-memory/R1-R2-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/R1-R2-RESULTS.md) |
| R3 真实宿主闭环：准备方案，尚未执行 | [archive/next-memory/R3-HOST-PLAN.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/R3-HOST-PLAN.md) |
| R1/R2 独立复核 + R3 真实宿主闭环（第一片通过，第二片未达标，第三片按规则不启动） | [archive/next-memory/R3-HOST-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/R3-HOST-RESULTS.md) |
| R4 / R5 验收记录（2026-10-28） | [archive/next-memory/R5-VERIFICATION-2026-10-28.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/R5-VERIFICATION-2026-10-28.md) |
| R7 验收记录（0.6.0，2026-10-28） | [archive/next-memory/R7-VERIFICATION-2026-10-28.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/R7-VERIFICATION-2026-10-28.md) |
| R8 改动审查记录（已随 0.7.0 发布） | [archive/next-memory/R8-DIFF-SUMMARY.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/R8-DIFF-SUMMARY.md) |
| R8 验收记录（0.7.0 发布前验证，2026-10-28） | [archive/next-memory/R8-VERIFICATION-2026-10-28.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/R8-VERIFICATION-2026-10-28.md) |
| 回交结果 | [archive/next-memory/RESULT.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/RESULT.md) |
| 回交结果模板 | [archive/next-memory/RESULT_TEMPLATE.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/RESULT_TEMPLATE.md) |
| 0.5.0 回交审查 | [archive/next-memory/REVIEW-2026-10-28.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/REVIEW-2026-10-28.md) |
| 当前维护审查清单 | [archive/next-memory/REVIEW_CHECKLIST.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/REVIEW_CHECKLIST.md) |
| 工作交付报告（2026-10-30，供外部审查） | [archive/next-memory/WORK-REPORT-2026-10-30.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/WORK-REPORT-2026-10-30.md) |
| W1–W5 交付结果（写入准确性、来源定位与变更记录） | [archive/next-memory/WRITE-PROVENANCE-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/next-memory/WRITE-PROVENANCE-RESULTS.md) |
| 0.7.1 后端可靠性收尾 | [archive/reliability-0.7.1-backend.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/reliability-0.7.1-backend.md) |
| 对 0.8.5 外部评审（不可发布）的回应（2026-11-04） | [archive/reviews/0.8.5-AUDIT-RESPONSE.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/reviews/0.8.5-AUDIT-RESPONSE.md) |
| 0.8.5 评审包（供外部评审） | [archive/reviews/0.8.5-REVIEW-PACKET.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/reviews/0.8.5-REVIEW-PACKET.md) |
| 0.8.6 最终放行记录 | [archive/reviews/0.8.6-FINAL-RESULTS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/reviews/0.8.6-FINAL-RESULTS.md) |
| 0.8.6 评审包（供外部评审） | [archive/reviews/0.8.6-REVIEW-PACKET.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/reviews/0.8.6-REVIEW-PACKET.md) |
| 0.7.0 前端与产品设计查验 | [archive/ui-design-audit-2026-10-28.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/ui-design-audit-2026-10-28.md) |
| 0.7.1 验收记录 | [archive/verification-0.7.1.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/verification-0.7.1.md) |
| dsh-trivium 介绍视频 · 录制脚本（台词 + 对话稿） | [archive/video-script.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/archive/video-script.md) |
| 公司电脑接手与 npm 发布交接（2026-11-12） | [NPM-RELEASE-HANDOFF-2026-11-12.zh-CN.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/NPM-RELEASE-HANDOFF-2026-11-12.zh-CN.md) |
| 替代关系契约：C 现状 / P / P′ 备选 | [next-memory/SUPERSEDE-CONTRACT-OPTIONS.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/next-memory/SUPERSEDE-CONTRACT-OPTIONS.md) |
| Trivium 设置页重设计交接 | [design/SETTINGS-REDESIGN-HANDOFF.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/design/SETTINGS-REDESIGN-HANDOFF.md) |
| 设置页四页化：实施记录（第一阶段） | [design/SETTINGS-PAGE-SPLIT-2026-11-03.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/design/SETTINGS-PAGE-SPLIT-2026-11-03.md) |
| TDB 能力使用审查、查询面板范围与 embedding 验证 | [reviews/TDB-CAPABILITY-AUDIT-2026-11-12.md](https://github.com/QWQcool/dsh-trivium/blob/47b01749d44863e4008629c5c3adba425271c02d/docs/reviews/TDB-CAPABILITY-AUDIT-2026-11-12.md) |
