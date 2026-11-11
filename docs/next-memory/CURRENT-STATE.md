# 当前状态（单一入口）

> **动手前先读这一页。** 历史文档里的"当前 / 未发布 / 下一步"以它自己的日期为准，不是今天的指令。
> 本页只写"现在是什么状态、什么已经验过、什么别再重复"，细节仍在各自文档里。

更新：**2026-11-11**。发布基线 **0.8.7**（tag `v0.8.7`）；`main` 比标签多 **11 个提交**，其中**有未发布的代码**：
确认审计行、交互式编辑并入工作区锁、脚本合并、事实身份语料与热度清理。这些攒在下一版（0.8.8）里，尚未定版本号。

## 1. 发布包与源码

| 范围 | 状态 |
|---|---|
| npm 发布包 | **`latest = 0.8.7`**（tag `v0.8.7`，2026-11-09；放行记录见 [`0.8.7-FINAL-RESULTS`](../reviews/0.8.7-FINAL-RESULTS-2026-11-10.md)、发布说明 `docs/release-0.8.7.md`） |
| 发布分支 | `release/0.8.4`、`release/0.8.5` 保留为当时的发布快照；两个 store 修复已用 parity 提交搬回 main（`8801fd6`、`4b0ad42`），**不需要合并** |
| 当前 main | 比 `v0.8.7` 多 **11 个提交**：4 个文档/整理，7 个代码或测试（确认审计行、编辑/合并/归档/删除并入工作区锁、脚本 119→118、身份语料闸门、热度删除清理）。**这些还没有发布** |
| 依赖 pin | `package.json` 要 `triviumdb@0.9.0`（正式版） |
| 本机实际内核 | 两台机器都已是 **`0.9.0`**（Administrator 机 2026-11-05 用 `npm install` 对齐，之前是 0.8.11）。跑测前仍建议自己查一次 |
| 宿主基线 | `@deepseek-ai/dsh@0.2.2-rc.1`（2026-11-10 实机启动验证）；README 里的 `0.2.1-rc.4` 已同步改掉 |

自查命令：`git rev-list --count v0.8.7..HEAD`、`node -e "console.log(require('triviumdb/package.json').version)"`。

## 2. 已验证（按证据强度分层，别混用）

| 层 | 结论 | 证据 |
|---|---|---|
| 离线回归 | `run-all` **86/86**（`scripts/` 118 个 `.mjs`，上限 120；p40→p33、p68→p44 合并，新增 p91 文档一致性检查）、`verify-evidence` 9/9 | 2026-11-11 本机实跑 |
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
| "自动建 `supersedes` 边是安全的" | **不再成立**。四轮复验证明"模型给出目标 ≠ 用户授权"，0.8.7 改为**提案制**（默认 `supersedeMode=propose`），硬边只能由人确认。见 §4 第 1 条 |

## 4. 真正待办（按可解锁程度排序）

1. ~~更正不建修订链~~ **0.8.3 已修（C 路线），0.8.7 又改成更保守的 P 路线**：
   自动路径**不再写硬边**，只标 `review=supersede-proposed` 并带候选 id；旧决策仍是 head，短地图故意同时显示两边；
   确认走 `POST /nodes/<old>/supersede`，拒绝走 `POST /supersede-proposals/<id>/reject`，列表 `GET /supersede-proposals`；
   配置 `supersedeMode=auto` 可回到 0.8.6 行为（9 个旧守卫脚本 pin 了 auto）。
   **刻意没给模型加 `supersedes_id` 参数** —— 这是 0.8.7 报告里最需要复审表态的取舍（见 §2.3）。
   以下是修复前的原始记录：真机空库首轮两轮对话只落成 1 个 decision 节点、`supersededCount=0`、`supersedes` 边 `[]`，
   抽取走 merge 分支；证据 `.tmp/r3/evidence-clean-run-20261101-172142/`（仅本地，已不在用户工作区）。
2. **R3 第三片（同质量净费用）** 前置未满足：第二片要在真实宿主复跑通过（S3 长尾已于 11-01 复测通过，但需补 S2 的边级验证）。
3. **B站 E1-B**：依赖对方扩展点，我们单方面交付不了。
4. **REFERENCE 判分通道**：A5 剩 4/5，判分对"先否定后纠正"过严，缺人工语义复核。
5. **0.8.7 报告里 5 项"需要决策才能做"的事**（B/C 批按授权跳过的）：逐条列在
   [`0.8.7-REPORT`](../reviews/0.8.7-REPORT-2026-11-06.md) 三、四两节（B 收尾遗留 / C 技术债），做之前需要拍板，不要默认开做。
5. ~~内核版本按机器核对~~ **两台机器都已是 `0.9.0` 正式版**：办公机 2026-11-04（见 §11），
   Administrator 机 2026-11-05 用 `npm install` 对齐（此前 0.8.11）。以后仍按机器自查，别信本页。
6. ~~后续方向与 Super-agent 适配计划~~ **阶段 0 已落地 6/6**（B1/B2/B3/B4/B5 + 作用域）；见 §8 与 `ROADMAP-AND-SUPERAGENT.md`。
   **阶段 1 也已跑通**：并发实测、只读继承、Router 原型、批处理、待补写可见、三 Worker 验收（见 §10）。
   剩下的都不是"再写代码"能解锁的：Router 常驻化要宿主形态，B6 要你拍板。
7. ~~发布 0.8.4 需要先决策~~ **已发布**：走"只发前端"，分支 `release/0.8.4`，记录见 §9。
8. ~~发 0.8.5 前要补两次真机验证~~ **已补**（`S1/PRE-0.8.5-2026-11-04`）：
   ① `stuck{kind:"lock-stale"} → recovered{afterMs:35154}` 在真机成对出现，且是**跨会话**配对（靠变更记录 seed）；
   ② `full/147` 查明是**工作区级诊断 + 多会话覆盖**造成的读法歧义，不是缺陷；但 `lastMapInjection` 不带 session 仍是口径缺陷。
   仍未验证：`extract-timeout`（30 秒真实挂起）与 `replay-timeout` 两条分支。
9. **阶段 1 的开关已落地**（`scopeInheritance`，默认关，见 §10）：关掉时 `readInheritedMap` 返回 `disabled`、
   `startRouter` 抛 `SCOPE_DISABLED`，且**在打开句柄之前**就拒绝。开它需要改 `~/.dsh/trivium.json`。

## 5. 别再重复做的实验

| 实验 | 为什么别重做 |
|---|---|
| R3 第二片 S1（姓名/端口/金额） | 已通过，见 `R3-HOST-RESULTS` §四 |
| R3 第二片 S3（长正文尾部） | 10-29 失败、**2026-11-01 复测已通过**（0.8.2 尾部保底生效） |
| A5 / A10 | 已 n=5 / n=10，重复只增加费用 |
| C3 三臂（无记忆 / 图+工具 / 纯文本） | 旧结论已降级，重跑前先读 `COST-QUALITY-RESULTS` 的修正口径 |
| 用 Trivium 面板工作区下拉做隔离 | 实测**只切视图**：默认库 13→14，面板选的库 1→1 |
| 用会话「选择工作区」做隔离 | 实测未改变写入目标，会话 cwd 固定 `Documents/deepseek-harness/default-workspace` |
| 重做 B1/B2/B3/B5 或"作用域抽象" | 阶段 0 已完成（§8.1）；要改就改证据里写明的已知边界，不要从头再来 |
| 重做设置页四页化/命令面板 | 已在 0.8.4 发布（`release/0.8.4`）；只修实机缺陷，不要重新排版 |
| 按"每个会话都重发全量地图"估算 B3 收益 | 0.8.3 本来就只注入一次；B3 的对手是假想的每轮全量，对真实基线是"多几十 token 换新鲜度" |
| 重跑 0.8.6 放行验收 | 已放行并发布（`0.8.6-FINAL-RESULTS`）；再跑只是重复付费，除非代码有实质改动 |
| 再论证"自动建 supersedes 边" | 0.8.7 已定 P 路线（提案制）；再讨论请直接读 `0.8.7-REPORT` §2.3 的取舍，不要从零复现四个攻击案例 |

## 6. 真机实验的环境与方法（省下重新摸索的时间）

- Node 用桌面版自带运行时：`…\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（24.21.0）；系统 Node 只有 22，宿主起不来。
- 宿主：`node node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port <p>`，日志里会打印 `?token=` 的 URL。
- 截图：本机只有 Chromium 二进制、没有 playwright 包，用零依赖 CDP 脚本（`.tmp/r3/cdp-shot.cjs`）。Chrome 必须加 `--no-sandbox`；`/json/list` 比 `/json/new` 可靠。
- **工作区隔离**：换 `DSH_HOME` 不换工作区 —— 默认工作区在 `Documents/deepseek-harness/default-workspace`，要干净库只能备份后移走 `.dsh`（2026-11-01 已做一次，备份在 `.tmp/r3/backup-20261101-172142/`，md5 已核对）。
- 抓包顺序：先 `GET /api/dsh-trivium/status?cwd=<ws>` 看 `lastExtract`，再拷贝 `.dsh` 用只读脚本查节点与边（不要对宿主正在用的库双开）。

## 7. 文档地图（其余都是历史）

| 需要 | 看哪里 |
|---|---|
| 发布内容 | **`docs/release-0.8.7.md`**（中）/ `release-0.8.7.en.md`（英）；0.8.6 见 `release-0.8.6.md`，内核升级见 `release-0.8.5.md` |
| 放行与复审 | `docs/reviews/0.8.7-REPORT-2026-11-06.md`（A–C 批 + F87 返修）、`docs/reviews/0.8.7-FINAL-RESULTS-2026-11-10.md`（含 0.2.2 真机）；0.8.6 的放行记录在 `docs/archive/reviews/` |
| 现在该做什么 | `docs/next-memory/ROADMAP-AND-SUPERAGENT.md`、`docs/README.md` |
| 替代 / 确认的契约 | `docs/next-memory/SUPERSEDE-CONTRACT-OPTIONS.md` |
| 事实去重（语料与基线） | `docs/next-memory/IDENTITY-CORPUS-2026-11-11.md` |
| 成本口径 | `docs/next-memory/COST-MODEL.md` |
| 原始证据（真机/并发/写入来源） | `docs/next-memory/evidence-write-provenance/` |
| 设置页重构 | `docs/design/SETTINGS-PAGE-SPLIT-2026-11-03.md`、`docs/design/SETTINGS-REDESIGN-HANDOFF.md` |
| 历史（0.8.3 之前、A/B/C/D 实验、旧审计） | `docs/archive/`（入口 `docs/archive/README.md`） |

## 8. 历史版本记录

0.8.3 → 0.8.4 的阶段记录（四条工单、设置页四页化、0.8.4 发布回执）已移到
[`archive/next-memory/0.8.3-0.8.4-RELEASE-LOG.md`](../archive/next-memory/0.8.3-0.8.4-RELEASE-LOG.md)。
0.8.5 / 0.8.6 / 0.8.7 的发版回执见各自的 `docs/release-<版本>.md`。
