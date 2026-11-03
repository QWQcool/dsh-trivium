# 当前状态（单一入口）

> **动手前先读这一页。** 历史文档里的"当前 / 未发布 / 下一步"以它自己的日期为准，不是今天的指令。
> 本页只写"现在是什么状态、什么已经验过、什么别再重复"，细节仍在各自文档里。

更新：2026-11-03。基线 `d0c7eb5`。

## 1. 发布包与源码

| 范围 | 状态 |
|---|---|
| npm 发布包 | **`latest = 0.8.3`**（tag `v0.8.3` → `b3f73da`，2026-11-02；shasum `7406c13…`） |
| 当前 main | `0.8.3` 之后有 **7 个未发布提交**：5 个阶段 0 代码（B1/B2/B3/B5/作用域）+ 1 个说明文档 + 1 个设置页四页化。见 §8 |
| 依赖 pin | `package.json` 要 `triviumdb@0.9.0-beta.3` |
| 本机实际内核 | `node_modules/triviumdb` 按机器不同：办公机 `0.9.0-beta.3`（与 pin 一致）；Administrator 机仍为 **0.8.11**（2026-11-02 复核）。跑测前先自己查一次，别信这行 |

自查命令：`git rev-list --count v0.8.3..HEAD`、`node -e "console.log(require('triviumdb/package.json').version)"`。

## 2. 已验证（按证据强度分层，别混用）

| 层 | 结论 | 证据 |
|---|---|---|
| 离线回归 | `run-all` **79/79**（p0–p78）、`verify-evidence` **9/9** | 本机可复现 |
| 真实模型 + 合成夹具 | A5：抽取命中 25/25、进库 25/25、新会话答对 21/25；A10：改口/否定各 10/10 | `A5-WIDER-BASELINE`、`A10-REGRESSION-N10` |
| 真实宿主 + 桩模型 | R3 第一片采集预检 16/16；注入/预算/过期/坏链在真宿主成立 | `R3-HOST-RESULTS` 第三片前 |
| 真实宿主 + 真实模型 | R3 第二片：S1 通过；S2 落库是改写句、新会话答对；**S3 长尾失败**（`verify-QA-71` 丢失） | `R3-HOST-RESULTS` §四 |
| 真机 UI | 设置页 1280 浅色可截；入口 = **账号菜单 → 设置**（`Ctrl+Alt+,`）→ 左侧「Trivium 记忆」 | 2026-11-01，`.tmp/r3/p1/` |

## 3. 已推翻或降级的结论（不要再引用旧说法）

| 旧说法 | 现状 |
|---|---|
| 抽取降本"省 80%" | **撤回**。D3 按实际保留请求重算 = 15→15、费用不变 |
| 图记忆相对纯文本"零增益 / 等效" | **降级为不可判定**。旧脚本库未隔离、判据太松、14.7× 是价格比不是 token 比 |
| "公开 API 造不出坏链" | **错**。`ctx_remember` 的 `link_label` 原本可写 `supersedes`，已修 |
| 查询复杂度 n^1.75 | **不成立**，阶段测量不支持该拟合 |
| "必须加 `session/disposed` flush" | **不需要**，已有 `savePending` + `pending-replay` |

## 4. 真正待办（按可解锁程度排序）

1. ~~更正不建修订链~~ **已在 0.8.3 修复**（替换场景改为新增节点 + 建边，旧正文进 `payload.history`）。
   遗留风险：自动替代仍是措辞启发式，可能误退休 —— 见 `SUPERSEDE-CONTRACT-OPTIONS.md`（P / P′）。以下为修复前的记录：
   真机空库首轮：两轮对话（先进方案 A、随后改 B）只落成 **1 个 decision 节点**，正文写成"先 A 后来改 B"；
   `lastExtract.supersededCount = 0`、库内 `supersedes` 边 `[]`。抽取走 **merge 分支**，从未进入"新建决策 + 建替代边"。
   影响：`currentHeadOf`、"短地图只列当前"、`matched_history` 全部落空 —— 而这些是产品唯一的差异化卖点。
   证据：`.tmp/r3/evidence-clean-run-20261101-172142/`（该目录已被移出用户工作区，仅本地）。
2. **R3 第三片（同质量净费用）** 前置未满足：第二片要在真实宿主复跑通过（S3 长尾已于 11-01 复测通过，但需补 S2 的边级验证）。
3. **B站 E1-B**：依赖对方扩展点，我们单方面交付不了。
4. **REFERENCE 判分通道**：A5 剩 4/5，判分对"先否定后纠正"过严，缺人工语义复核。
5. **内核版本按机器核对**：办公机已对齐（`0.9.0-beta.3`）；**Administrator 机仍是 0.8.11**，在那台机器上跑出的结论要标"旧内核"。
6. ~~后续方向与 Super-agent 适配计划~~ **阶段 0 已落地 5/6**（B1/B2/B3/B5 + 作用域），只剩 B4；见 §8 与 `ROADMAP-AND-SUPERAGENT.md`。
7. **发布 0.8.4 需要先决策**：阶段 0 的改动与前端重构在同一分支上，若"只发前端"需要单独拉发布分支（见 §8 末）。

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
| 按"每个会话都重发全量地图"估算 B3 收益 | 0.8.3 本来就只注入一次；B3 的对手是假想的每轮全量，对真实基线是"多几十 token 换新鲜度" |

## 6. 真机实验的环境与方法（省下重新摸索的时间）

- Node 用桌面版自带运行时：`…\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（24.21.0）；系统 Node 只有 22，宿主起不来。
- 宿主：`node node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port <p>`，日志里会打印 `?token=` 的 URL。
- 截图：本机只有 Chromium 二进制、没有 playwright 包，用零依赖 CDP 脚本（`.tmp/r3/cdp-shot.cjs`）。Chrome 必须加 `--no-sandbox`；`/json/list` 比 `/json/new` 可靠。
- **工作区隔离**：换 `DSH_HOME` 不换工作区 —— 默认工作区在 `Documents/deepseek-harness/default-workspace`，要干净库只能备份后移走 `.dsh`（2026-11-01 已做一次，备份在 `.tmp/r3/backup-20261101-172142/`，md5 已核对）。
- 抓包顺序：先 `GET /api/dsh-trivium/status?cwd=<ws>` 看 `lastExtract`，再拷贝 `.dsh` 用只读脚本查节点与边（不要对宿主正在用的库双开）。

## 7. 文档地图（其余都是历史）

| 需要 | 看哪里 |
|---|---|
| 发布内容 | `docs/release-0.8.2.md`（及 0.8.0 / 0.8.1） |
| 真实宿主闭环 | `docs/next-memory/R3-HOST-RESULTS.md`、`R3-HOST-PLAN.md` |
| 写入来源 / 审计 / 单写者 | `WRITE-PROVENANCE-RESULTS.md`、`F-W04-F-W05-RESULTS-2026-10-30.md` |
| 质量与成本 | `A5-WIDER-BASELINE`、`A10-REGRESSION-N10`、`COST-QUALITY-RESULTS`、`COST-MODEL` |
| 被推翻的旧测量 | `POST-081-REVIEW.md`、`R1-R2-RESULTS.md` |
| C 批（历史） | `C-RESULTS.md`、`C3-SCENARIOS.md`、`C4-COUNTERPARTS.md` |
| 阶段 0（Super-agent 借鉴） | 每单一份：`evidence-write-provenance/S0/S0-1..S0-5/README.md` |
| 设置页重构 | `docs/design/SETTINGS-PAGE-SPLIT-2026-11-03.md`、`docs/design/SETTINGS-REDESIGN-HANDOFF.md` |

## 8. 0.8.3 之后的未发布内容（2026-11-03）

### 8.1 阶段 0：Super-agent 借鉴（B1/B2/B3/B5 + 作用域）

| 提交 | 工单 | 做了什么 | 验收 |
|---|---|---|---|
| `d0bea13` | S0-1 / B2 地图热度 | `lib/usage.js` 旁路记引用（60 s 节流），地图热条目优先占槽 | p73 27/27；50 条只问 3 条 → 3 条进地图，token 70 不变 |
| `dc89a5e` | S0-2 / B3 增量注入 | 地图带 `mapVersion`，每轮按 full/diff/skip 决定 | p74 29/29；3 轮安静 225→0 token；变化时 37 token |
| `53f34d3` | S0-3 / B1 两级过滤 | `screenEvent` 0/1/2 + `screenTurns` 窗口筛选 | p75 43/43；语料调用 30→10（−66.7%），命中不变 |
| `fd99a7d` | S0-4 / B5 卡住检测 | `stuck`/`recovered` 事件、30 s 抽取预算、stale 锁探针 | p76 33/33（假计时器，未真等 30 s） |
| `693c505` | S0-5 作用域 | `resolveScope`：workspace 实现，parent/inherit 明确抛错 | p77 20/20；默认落库位置零变化 |

**没有做的事**：B4（`MemoryWriter` 解耦）未做；没有任何真机验证；`/status` 新增的 `stuck`/`recovered`/`lastMapInjection`
只有前端读取，未经宿主实跑。

### 8.2 设置页四页化（`d0c7eb5`）

一个宿主入口内拆成 记忆库 / 上下文 / 运行记录 / 设置；新增运行诊断卡；四类按需拉取改挂到
上下文与运行记录页。p78 35/35 结构级验证，**未在真宿主渲染过**。设计与实施边界见
`docs/design/SETTINGS-PAGE-SPLIT-2026-11-03.md`。

### 8.3 发布 0.8.4 的前置

阶段 0 与前端重构在同一分支。若要"只发前端"，需要从 `a0ffde9`（阶段 0 之前）拉发布分支，
把前端提交挑过去——但设置页的运行诊断卡读取的 `status.stuck/recovered/lastMapInjection`
正是阶段 0 加的字段（无值时显示"没有记录"）。**先决策再打包**，不要在同一条 main 上直接 bump。
