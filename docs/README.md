# 文档入口与当前基线

**0.8.0 已发布**，见 [发布说明与回执](release-0.8.0.md)。本轮 [判据、公平对照和成本报告](next-memory/COST-QUALITY-RESULTS.md) 包含原始证据；35/35 离线组、13 项干净安装/真实 peers 验证及隔离 Web HTTP 自验通过。C4 留在发布之后。

更新：2026-10-29。这里是维护者的当前状态入口；安装和日常使用见 [中文 README](../README.zh-CN.md)。历史报告中的“当前”“待发布”“下一轮”只对报告当时有效，不作为今天的执行指令。

## 当前发布基线

| 项目 | 状态与证据 |
|---|---|
| 插件 | `dsh-trivium@0.8.0`；registry 已确认 `latest=0.8.0` |
| 发布时间 | `2026-10-29T03:55:18.088Z`，即北京时间 2026-10-29 11:55:18 |
| 发布源码 | `v0.8.0` → `d9bd4d5`；远端 main 已包含该提交，发布回执另行提交 |
| 发布包 | shasum `ca3950f18ae837396657558feb368bb2cbd01e32`；38 个文件，与最终验收包一致 |
| 内核 | `triviumdb@0.9.0-beta.3`，精确锁定；内核 npm tag 本轮未重新核查；未更换内核版本 |
| 运行时 | ESM；Node `^22.19.0 || >=24`；npm 锁文件；宿主提供 `dsh-llm` / `dsh-tools` peers |
| 已记录宿主 | Web `@deepseek-ai/dsh@0.2.1-rc.4`；桌面 `0.2.1-rc.3` 的覆盖边界见下表 |
| 旧问题版本 | 0.5.0 既有 deprecation 保留；当前升级目标为 0.8.0，本轮未另行 deprecate 旧版本 |

本页记录发布基线，不代表未发布工作树已进入 npm。当前修改与新增缺陷结论应单独列在本轮审查结果中。

## 0.7.1 可靠性收尾（已发布）

package/lock 已更新到 0.7.1；更正调度、自然到期、按库诊断和 UI 收尾已发布。最终回归 26/26（p23 47 项、p24 12 项、p25 32 项），最终 tarball 干净安装及 13 项真实 peers 验证通过。用户完成键盘、深色/900px、两浏览器冲突及冲突后列表复验；宿主 HTTP 导入文件锁故障/恢复通过。完整 UI 导入故障、独立安装桌面制品全流程与质量/负载基准仍未覆盖。

发布状态见 [0.7.1 发布说明](release-0.7.1.md)，各层证据见 [0.7.1 验收](verification-0.7.1.md)。后续 B–E 的范围与原型安排见 [可复制的 IDE 提示词](NEXT-IDE-PROMPT-0.7.1.md) 和 [HTML 对照](frontend-prototype-review-2026-10-28.md)。

旧文档引用迁移与三份删除已独立提交 `8eb2b75`，原始文件仍可从固定 Git 提交读取，冻结 JSON 未改。

## 上轮审查工作树（2026-10-28，历史证据）

以下是在 0.7.1 开始前完成的审查，后已提交为 `2b21a0a`。当时没有改版本号、发布 npm 或推送。已发布的 0.7.0 不包含这些修复；临时包仅供本地验收，不能覆盖已发布版本号。后续变化以 0.7.1 验收为准。

| 检查 | 本轮实际结果 |
|---|---|
| 离线回归 | 修复前 23/23；修复后 **25/25**。新增后端/CLI p23 **47/47**，前端 p24 **6/6** |
| 独立 tarball 消费 | 本地包 37 文件；全新消费目录正常 npm install，真实 peers `0.2.1-rc.4`；`verify-package` **13 项通过**，两个 bin 的 `--help` 通过 |
| 制品身份 | 临时包 shasum `ef5ee28192e4c4bb49cfc94a3255c3f8349872a7`，与正式 0.7.0 的 hash 不同。35 个文件逐字节一致；两个 bin 安装后仅 shebang 换行规范化，归一后与源码一致 |
| 桌面有限走查 | rc.3、约 1280×820、浅色；面板正常，Tab 到条目标题、Enter 展开详情、Escape 关闭设置。加载的是本地工作树；焦点归还未确认，不是最终包完整桌面验收 |
| 保留的缺口 | 双独立浏览器进程 409、宿主 UI 导入故障、900px/深色/嵌套弹窗完整键盘检查；更正调度/自然到期/按库诊断与质量负载基线 |

详细证据与日志定位见 [代码与 CLI 查验](bug-audit-2026-10-28.md)、[UI 和设计审计](ui-design-audit-2026-10-28.md)；后续路线见 [11 个同类项目调研](memory-plugin-landscape-2026-10-28.md)。

## 先读什么

| 目的 | 文档 |
|---|---|
| 安装、配置、使用、排障 | [中文 README](../README.zh-CN.md) / [English README](../README.md) |
| 产品边界、架构、后续方向 | [PLAN.md](../PLAN.md) |
| 可选芯片与会话层的实际契约 | [PLAN-session-map.md](../PLAN-session-map.md) |
| 当前版本改了什么 | [0.8.0 发布说明](release-0.8.0.md) / [质量与成本记录](next-memory/COST-QUALITY-RESULTS.md) |
| 交给其它 AI IDE 的后续范围 | [B1–B5 连续开工提示词与 B–E 依赖](NEXT-IDE-PROMPT-0.7.1.md) |
| B 批交互契约与原型 | [0.8.0 交互原型（合成 fixture）](next-memory/FRONTEND-0.8.0.html) / [执行计划](next-memory/B-EXECUTION-PLAN.md) / [B1–B5 结果](next-memory/B-RESULTS.md)；旧的 [FRONTEND.html](next-memory/FRONTEND.html) 保留历史身份 |
| C 批质量与负载基线 | [结果汇总](next-memory/C-RESULTS.md) / [执行计划](next-memory/C-EXECUTION-PLAN.md) / [10 个场景](next-memory/C3-SCENARIOS.md) / [对手取舍](next-memory/C4-COUNTERPARTS.md) |
| C4 对手验装与同语料对照 | [预注册](next-memory/C4-PLAN.md) / [结果](next-memory/C4-RESULTS.md)（7 臂 42 格，¥0.0203） |
| D0 完整性修复与复测 | [结果](next-memory/D0-RESULTS.md)（尾部保底 + topK 8；我方 4/6 → 18/18，注入 97 tok） |
| 发布操作与证据要求 | [发布检查清单](release-checklist.md) |
| 文档保留、合并、删除候选 | [文档审计](documentation-audit-2026-10-28.md) |
| 本轮缺陷复现、修复与回归 | [0.7.0 缺陷审查](bug-audit-2026-10-28.md) |
| 前端实现、设计取舍和 UI 验证 | [UI 与设计审查](ui-design-audit-2026-10-28.md) |
| GitHub 同类插件、差异与可借鉴方向 | [记忆插件调研](memory-plugin-landscape-2026-10-28.md) |
| 新一轮回交与审查 | [回交模板](next-memory/RESULT_TEMPLATE.md) / [审查清单](next-memory/REVIEW_CHECKLIST.md) |

## 最近三版

| 版本 | 主要变化 |
|---|---|
| [0.6.0](release-0.6.0.md) | 两个维护命令随 npm 包分发；补双标签页冲突、稳定消息 id 和期限清理验证 |
| [0.7.0](release-0.7.0.md) | 设置页可查看更正与版本链体检；增加旁路故障与重开恢复回归 |
| [0.7.1](release-0.7.1.md) | 原子导入、归档历史、更正与自然到期、按库诊断、只读 CLI、UI 冲突与键盘可靠性 |

## 验证覆盖与缺口

以下是相应版本的历史证据，不能替代本轮重跑或正式包验证。

| 层级 | 已有证据 | 仍需区分 |
|---|---|---|
| 离线回归 | 0.7.0 发布记录：23/23 脚本；p21 89 条、p22 38 条、issue #3 的 p15 48 条 | 脚本通过不能证明不存在未覆盖缺陷；当前数量以 `scripts/run-all.mjs` 为准 |
| 打包消费项目 | [R5](next-memory/R5-VERIFICATION-2026-10-28.md) / [R7](next-memory/R7-VERIFICATION-2026-10-28.md)：真实 peers、13 项 `verify-package`，含累计预算和新 id / 新正文 | 不把早期 tarball 的验证直接移植成后来每个包都已重验 |
| Web 真机 | [R7](next-memory/R7-VERIFICATION-2026-10-28.md) 双标签页 ETag 409；[R8](next-memory/R8-VERIFICATION-2026-10-28.md) 更正送达、体检、Tab / Escape | 两个独立浏览器进程的竞争仍未由这些记录覆盖 |
| 桌面宿主 | [R8](next-memory/R8-VERIFICATION-2026-10-28.md)：rc.3 内部 API 可访问、注入与召回正常 | 当时是版本字段仍为 0.6.0 的 0.7.0-preview 工作树；不是正式 0.7.0 包的完整视觉／键盘验收 |
| 失败恢复 | p22 用真实文件故障验证旁路失败可见、重开恢复和文本索引重建 | 不等于从真实宿主 UI 触发完整导入失败链路 |

“桌面视觉／键盘验收”包括：在桌面客户端打开设置页，检查布局、文字截断、滚动、浅深色和错误状态；用 Tab / Shift+Tab / Enter / Escape 操作，检查焦点可见、弹窗内焦点、关闭后焦点返回。API 返回 200 只能证明服务接口运行，不能证明这些交互。

## 维护边界

- 默认关闭芯片、自动召回、会话层、Git 旁路写出与远程 embedding；**抽取默认开启**，可使用宿主配置的模型，并非所有处理都只在本机进行。
- 短地图每会话最多一次、默认 ≤400 估算 token；芯片、召回、更正共用每用户轮累计 300；主动工具调用不计入这 300。
- 只支持 900px 及以上宽度；同一 `.tdb` 只允许一个读写进程；同工作区不同会话共享记忆，fork 不复制数据库。
- 不用真实用户设置或真实记忆库做故障测试；隔离 `DSH_HOME`、`DSH_TRIVIUM_SETTINGS` 和工作区。不删除用户 `.dsh`。
- 发布、推送、改 dist-tag、deprecate、回复 issue 需要用户已经授权相应动作；文档审计与本地修复本身不包含发布。

## 历史材料怎么读

`next-memory/` 保留 0.5.0 规格、失败证据、0.5.1 修复过程和 R5 / R7 / R8 验收。旧的 `BASELINE.json`、`TOOL_SCHEMA_BASELINE.json`、`ACCEPTANCE_CASES.json` 与截图是冻结参考，不能改日期或测试数字伪装成最新结果。保留的兼容交接入口为短跳转；三份重复草稿已经迁移引用后移除，详见文档审计中的固定提交存档。
