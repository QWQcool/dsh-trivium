# 文档审计与整理记录

日期：2026-10-28。审计基线为发布后的 `main`（`b2a82a5`，插件 0.7.0）；本轮修改尚未发布。覆盖初始检出的 **29 份 Markdown**，并检查 `next-memory/` 的 **8 份 JSON** 的用途、版本和证据归属。代码／缺陷、UI 和同类项目调研分别记录，不把文档整理当作功能验收。

## 结论

主要问题不是文档数量本身，而是多个文件同时声称“当前”“下一轮”，且各自停在 0.4.14、0.4.22、0.5.0、0.5.1 或 0.7.0。接手者可能因此回退内核、重复执行已完成计划、再次准备旧版本发布，或把预览工作树 API 验证当正式包 UI 验收。

已建立一个当前入口：[docs/README.md](README.md)。`PLAN.md` 只保留现行架构与产品约束，发布回执各按版本保留；原始失败证据和截图保留历史身份。初次整理将旧提示词收成短跳转；随后 0.7.1 收尾按用户授权迁移已知引用，再移除三份重复文档，具体映射见文末。

## 保留、合并与删除候选

下表记录初次整理后的保留结论，并更新 0.7.1 收尾已执行的三项删除；原始失败证据、冻结 JSON 和截图均未删除。

| 原文件 | 处理 | 理由与实际修改 |
|---|---|---|
| `README.md`、`README.zh-CN.md` | 保留，更新 | 面向用户的安装／使用入口；双语同步当前宿主、抽取联网边界与历史截图说明，由本轮主审查负责 |
| `PLAN.md` | 保留，重写现状 | 移除重复版本流水账与过期开工顺序，保留产品范围、数据／预算／恢复契约、模块边界和下一阶段顺序 |
| `PLAN-session-map.md` | 保留，收敛 | 芯片／fork 的专门契约仍有价值；已把“待开发”功能更新成现状，修正独立 300 预算、旧标签名和 fork 隔离误解 |
| `docs/article-2026-update.md` | 保留，压缩并更新 | 有面向读者的解释用途；改为 0.7.0 介绍稿，去除无对照依据的竞品泛化与 0.4.14 快照，不复制完整配置手册 |
| `docs/video-script.md` | 保留，校正文案 | 独立录制用途；改正预算、模型代钉选和“分支不影响记忆库”的错误承诺，演示改用隔离工作区；未重录或彩排 |
| `docs/issue-3-reply.md` | 已移除，保留固定提交存档 | 发布前回复草稿已失效；现行根因与旧数据处理由 README、0.4.22 发布说明承接。发布页和 RESULT 的历史引用已改为固定提交链接 |
| `docs/release-checklist.md` | 保留，更新 | 唯一发布操作流程；补当前入口、最终包证据、发布授权与凭据边界，不在每份交接词重复命令 |
| `docs/release-0.4.22.md` | 保留历史回执，补正 | 改正“未发布”；移除再次发布同版本的执行步骤，保留校验值和当时测试；失效临时产物路径明确标记 |
| `docs/release-0.5.0.md` | 保留历史问题版本记录 | 改正“未发布”，醒目标记已 deprecated 和三个 P1；不把原完成声明改成正确性证据 |
| `docs/release-0.5.1.md`、`docs/release-0.6.0.md` | 保留历史回执 | “latest 指向本版”改为“发布时”；保留各自原测试数量、限制与发布时间 |
| `docs/release-0.7.0.md` | 保留当前发布回执 | 更新时间精度、sent 容量说明；明确桌面是 preview 工作树 API 验证，不是正式包 UI 验收 |
| `next-memory/START_HERE.md` | 合并，保留导航 | 当前状态迁到 `docs/README.md`；本文件只解释本目录历史材料怎么读 |
| `next-memory/HANDOFF_PROMPT.md` | 合并后已移除 | 原 M0–M2 指令已完成；HTML 交接导航已迁到保留的现行交接入口，原规格／结果保留 |
| `next-memory/FIX_HANDOFF_PROMPT.md` | 合并后已移除 | 原 0.5.1 指令已完成且锁 0.8.11 的要求过时；执行计划中的历史依据已改为固定提交链接 |
| `next-memory/HANDOFF-PROMPT-0.7.0.md` | 合并，保留兼容入口 | 现只保留接手顺序、边界和链接；不复制版本表、测试矩阵或发布命令 |
| `next-memory/IMPLEMENTATION_PLAN.md` | 保留，历史规格 | 包含上下文契约的设计理由，不能只因旧版本而删；新增醒目历史标记，当前契约由 PLAN 承接 |
| `next-memory/FIX_PLAN-2026-10-28.md` | 保留，历史修复设计 | 详细失败断言、事务和降级理由有独立价值；顶部说明旧内核要求／待确认项已失效 |
| `next-memory/EXECUTION_PLAN-0.5.1.md` | 保留，历史执行记录 | 包含逐轮证据，不能并入现行计划后丢掉时间线；当前任务不再按其“下一轮”执行 |
| `next-memory/RESULT.md` | 保留，历史回交 | 保留原完成声明被后续审查推翻的完整过程；顶部说明旧 latest、拆分修复建议和半提交说明已过时 |
| `next-memory/REVIEW-2026-10-28.md` | 保留，原始失败证据 | 三个 P1 的复现与测试盲点不能删；只补历史身份，不篡改失败数字 |
| `next-memory/R5-VERIFICATION-2026-10-28.md` | 保留，历史验收 | 原多工具轮次、打包、过期 ETag 和窄屏数据有独立证据价值；后续补口用链接，不重写成已覆盖 |
| `next-memory/R7-VERIFICATION-2026-10-28.md` | 保留，历史验收 | 双标签页不是双浏览器进程，轮 id 和 CLI 制品证据独立保留 |
| `next-memory/R8-VERIFICATION-2026-10-28.md` | 保留，修正状态与笔误 | 标题不再“待发布”；sent 账本 20 / API 10 / UI 3 分开；“未打包”限定为验收当时；显式列出未覆盖项 |
| `next-memory/R8-DIFF-SUMMARY.md` | 保留历史审查摘要 | 虽与 release 有重叠，逐文件改动和 API 细节仍独立；删掉已经完成的发布待办口吻 |
| `next-memory/REVIEW_CHECKLIST.md` | 保留，更新为通用维护清单 | 不再把 0.4.22 / 0.8.11 / 390px 当当前硬门槛；增加真实运行时、异步工作区、事实／派生分层检查 |
| `next-memory/RESULT_TEMPLATE.md` | 保留，通用化 | 不再限定 M0–M2；要求分别报告离线、打包、Web、桌面 API、桌面 UI，以及实现／验收／发布 |
| `next-memory/evidence/README.md` | 保留，历史截图索引 | 图片与原始交互日志的解释不能删除；明确这些是 0.5.0 的证据 |

表中的 `next-memory/` 路径均相对于 `docs/`。

## 不改写的材料

- `BASELINE.json` 是 0.4.22 交接快照的校验表。更新它反而会破坏来源证明；其中哈希不应与今天的文件强行一致。
- `TOOL_SCHEMA_BASELINE.json` 是原四工具投影与 529 估算 token 的相对基线，不是模型真实费用。
- `ACCEPTANCE_CASES.json` 是冻结规格，不是已通过结果；旧环境和 390px 要求通过当前清单解释，原用例 id 保留供测试引用。
- `review-evidence-2026-10-28.json`、`review-repro-2026-10-28.mjs` 是原 P1 失败证据。复现脚本 exit 0 不等于修复通过。
- `evidence/` 下的 `run*.json`、`measure-narrow.json` 和图片、`evidence-r5/` 图片保留原样；不能把它们改名成 0.7.0 截图。
- `FRONTEND.html` 保留为离线交互规格，不属于运行产品，也不属于真机验收。以后若单独归档，必须一起更新规格引用。

## 本次消除的快照冲突

1. PLAN 顶部 0.5.0 待发布、npm 0.4.21、内核 0.8.11，与真实 0.7.0 / beta.3 冲突。
2. 旧 HANDOFF 要求重新执行 M0–M2 或禁止 0.9 beta，与已发布实现冲突。
3. 0.4.22 / 0.5.0 发布说明仍写未发布，可能诱导复用版本号。
4. 0.5.1 / 0.6.0 把各自发布时 latest 写成永远当前。
5. R8 标题待发布、末尾待改版本，与页首发布回执冲突。
6. sentCorrections 的“10 条”混淆账本、API 与 UI 三层容量。
7. 会话层文档把芯片当独占 300，把已实现的导航／继承仍写待开发。
8. 介绍稿和视频把本地存储延伸成全部离线、把 fork 延伸成记忆隔离；已改为实际边界。

## 维护规则

当前版本与覆盖矩阵只在 `docs/README.md` 维护；架构契约在 PLAN；面向使用者的双语说明在 README；版本变更在各自 release。历史文档加状态说明和后继链接，不改原始测试输出。新增本轮审查报告可以保留，但不要再新增一套内容重复的“START／HANDOFF／NEXT／CURRENT”入口。

## 0.7.1 收尾：删除与链接迁移

用户在初次审计后明确要求核查历史链接并单独提交移除。以 `2b21a0a` 保存初次整理结果后，扫描仓库内 Markdown、HTML、JSON、脚本及隐藏文本（排除 `.git`、`.tmp`、`node_modules`、`.dsh`），完成以下迁移并删除三份文件：

| 已移除文件 | 当前内容去向 | 原内容可达位置 |
|---|---|---|
| `docs/next-memory/HANDOFF_PROMPT.md` | [文档入口](README.md)、[原实施规格](next-memory/IMPLEMENTATION_PLAN.md)；`FRONTEND.html` 页脚已迁移 | [原 M0–M2 交接词](https://github.com/QWQcool/dsh-trivium/blob/a0ba565ce874a44cd6e62ad42438f775af9ff235/docs/next-memory/HANDOFF_PROMPT.md) |
| `docs/next-memory/FIX_HANDOFF_PROMPT.md` | [当前基线](README.md)、[原修复设计](next-memory/FIX_PLAN-2026-10-28.md)；执行计划历史引用已迁移 | [原 0.5.1 修复交接词](https://github.com/QWQcool/dsh-trivium/blob/a0ba565ce874a44cd6e62ad42438f775af9ff235/docs/next-memory/FIX_HANDOFF_PROMPT.md) |
| `docs/issue-3-reply.md` | [0.4.22 旧数据处理](release-0.4.22.md#用户升级与旧数据)、[中文 README](../README.zh-CN.md)；发布页和 RESULT 历史引用已迁移 | [原 Issue 回复稿](https://github.com/QWQcool/dsh-trivium/blob/818306bd552c47449b418488601aac78827dafc8/docs/issue-3-reply.md) |

`BASELINE.json` 的 `path: docs/issue-3-reply.md` 是冻结的校验记录，不是当前文件导航，故原样保留。已用 Git 读取 `818306b` 中的原文件，2456 字节及 SHA-256 `38607efb6ea1948dcd563bdcb8ad02f0b099f29f9e89a6bfe364705977e8d68e` 与该基线完全一致；上表固定提交链接提供恢复路径。

已知仓库内可点击引用均已迁移；GitHub 本仓库 issue 搜索未发现指向该回复稿的引用。无法穷尽私人收藏、聊天或外部站点中未知的 `main` 裸链接，因此不声称全网所有链接都已改写。已发布提交中的原文件仍可通过固定提交 URL 或 Git 历史访问。此次清理不发送 issue 留言，不删除冻结 JSON、截图或失败复现证据。

## 2026-10-30 文档整理结果

- 将中英文 README 和文档入口更新到 npm 0.8.2，并将标签后的当前源码改动与发布包分开；补充偏好导出、数据留存、过滤限制、分层测试数据和[可复现示例](guide-example.md)。压缩 README 中的版本流水，保留独立发布回执。
- 合并并移除 `next-memory/START_HERE.md` 和 `next-memory/HANDOFF-PROMPT-0.7.0.md` 两个重复导航；迁移本地引用并保留固定提交的历史链接。原始证据、预注册、失败报告和版本回执未删除。旧计划只增加历史提示，不作为当前执行指令。
- 对历史实验账本补上覆盖范围和实验限制；超出本机单次预算的旧命令保留为历史原文并明确禁止直接运行。实验脚本注释中的示例预算修正，运行逻辑未变。
- 本轮验证：`node scripts/run-all.mjs` → **56/56 组通过**；`node scripts/run-all.mjs smoke-p0` → **1/1 组**；`smoke-p51` → **14/14 断言**；`smoke-p52` → **20/20 断言**。以上为隔离离线回归，后两项使用模型桩，不代表真实模型准确率。`node scripts/verify-evidence.mjs` → **9/9 文件**，只验证历史清单的字节和哈希。
- 链接检查：全仓 Markdown 检查 252 个本地文件目标，缺失 0；未检查锚点与全部 HTML 链接。已删除两个导航的仓库内引用已迁移；历史审计中的文件名和固定提交链接保留。
- 模型调用 **0 次，费用 ¥0**；没有重新执行真实宿主、模型或 npm 包验收。当前源码的 F-W04 HTTP/UI 验收仍未完成，F-W05 的并发保护尚未覆盖工具写入和导入。旧计划中的机器路径仍是既有历史内容，本轮未声称清除历史。

## 2026-10-30 后续整理

`START_HERE.md` 与 `HANDOFF-PROMPT-0.7.0.md` 的现行导航已合并至 [文档入口](README.md)，为减少重复入口而移除；它们当时的原文分别可在[固定提交的 START_HERE](https://github.com/QWQcool/dsh-trivium/blob/65ea4e613c12ce0cd1b5029de01b6f0f8ce9085d/docs/next-memory/START_HERE.md) 和 [HANDOFF](https://github.com/QWQcool/dsh-trivium/blob/65ea4e613c12ce0cd1b5029de01b6f0f8ce9085d/docs/next-memory/HANDOFF-PROMPT-0.7.0.md) 查看。上述旧表描述的是 2026-10-28 的处理状态。历史规格、回交、失败证据及冻结文件保留。
