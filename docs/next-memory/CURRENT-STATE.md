# 当前状态（单一入口）

> **动手前先读这一页。** 历史文档里的"当前 / 未发布 / 下一步"以它自己的日期为准，不是今天的指令。
> 本页只写"现在是什么状态、什么已经验过、什么别再重复"，细节仍在各自文档里。

更新：2026-11-03。发布基线 `release/0.8.4` @ `d83450c`（tag `v0.8.4`）；main 最新 `9ee7a3c`。

## 1. 发布包与源码

| 范围 | 状态 |
|---|---|
| npm 发布包 | **`latest = 0.8.4`**（tag `v0.8.4` → `d83450c`，2026-11-03；shasum `7fe8265…`；GitHub Release 见 §9） |
| 发布分支 | `release/0.8.4` 从 `a0ffde9` 起，**只含设置页重构**（前端 + p78 + 文档/截图）；不含阶段 0 代码 |
| 当前 main | `0.8.3` 之后 **14 个提交**：5 个阶段 0 代码 + 3 个设置页重构 + 6 个文档。阶段 0 那 5 个**不在 0.8.4 包里**，见 §8 |
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
6. ~~后续方向与 Super-agent 适配计划~~ **阶段 0 已落地 6/6**（B1/B2/B3/B4/B5 + 作用域）；见 §8 与 `ROADMAP-AND-SUPERAGENT.md`。
   阶段 1 前半（A）也已完成：并发实测 + `inherit` 只读继承，见 §10。**下一步是后半（B）：Router 单点写**。
7. ~~发布 0.8.4 需要先决策~~ **已发布**：走"只发前端"，分支 `release/0.8.4`，记录见 §9。
8. **阶段 0 没有真机/真实模型验证**：B1/B2/B3/B5 只有离线夹具。下一步要么先在宿主里跑一轮会话
   （看 `lastMapInjection`、`screenedOut`、`stuck` 是否按预期出现），要么先做 B4；两者都不要跳过。

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

## 6. 真机实验的环境与方法（省下重新摸索的时间）

- Node 用桌面版自带运行时：`…\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`（24.21.0）；系统 Node 只有 22，宿主起不来。
- 宿主：`node node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port <p>`，日志里会打印 `?token=` 的 URL。
- 截图：本机只有 Chromium 二进制、没有 playwright 包，用零依赖 CDP 脚本（`.tmp/r3/cdp-shot.cjs`）。Chrome 必须加 `--no-sandbox`；`/json/list` 比 `/json/new` 可靠。
- **工作区隔离**：换 `DSH_HOME` 不换工作区 —— 默认工作区在 `Documents/deepseek-harness/default-workspace`，要干净库只能备份后移走 `.dsh`（2026-11-01 已做一次，备份在 `.tmp/r3/backup-20261101-172142/`，md5 已核对）。
- 抓包顺序：先 `GET /api/dsh-trivium/status?cwd=<ws>` 看 `lastExtract`，再拷贝 `.dsh` 用只读脚本查节点与边（不要对宿主正在用的库双开）。

## 7. 文档地图（其余都是历史）

| 需要 | 看哪里 |
|---|---|
| 发布内容 | `docs/release-0.8.4.md`（中）/ `release-0.8.4.en.md`（英）；历史见 0.8.3 / 0.8.2 / 0.8.1 / 0.8.0 |
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

**真机观测（2026-11-03）**：见 `evidence-write-provenance/S0/HOST-2026-11-03/README.md`。
已观测到 `full`（启动 131 token）→ `diff`×2 → `skip`×5、`version` 带条数与预算、抽取的
`screenedCounts`，以及"0 分 + 工具证据被升到 1 分"的现场。**未观测到**：`screen` 整窗口丢弃、
`stuck`/`recovered`、B2 热度写盘。

**B4（`MemoryWriter` 解耦）已完成**（`lib/memory-writer.js`）：抽取的四处写调用改走 `sink.insert/merge/link/update`，
纯桩 writer 下库不动而 `applied` 仍有值；p63/p65/p69 与 p79 全过（80/80）。**仍未做**：Router 实现、`index.js` 注入点、
导入/芯片/替代/编辑等其它写路径（它们不在抽取管线里）。证据：`evidence-write-provenance/S0/S0-B4/README.md`。

**没有做的事**：`stuck`/`recovered` 仍无真机值。

### 8.2 设置页四页化（`d0c7eb5` → `feb315e` → `9ee7a3c`）

一个宿主入口内拆成 记忆库 / 上下文 / 运行记录 / 设置；新增运行诊断卡与 Ctrl/Cmd+K 命令面板；
详情按卡片宽度分三档（≥1000 右栏 / 720–999 弹窗 / 更窄行内）；设计稿配色以 CSS 变量挂在卡片根节点。
p78 **54/54**，并在本机 DSH 宿主实跑（四页可切、命令面板可用、420px 行内展开、撑到 1120px 出现右栏）。
边界见 `docs/design/SETTINGS-PAGE-SPLIT-2026-11-03.md`。

### 8.3 发布 0.8.4（已完成）

从 `a0ffde9` 拉 `release/0.8.4`，只放前端三件套 + 文档/截图，bump 到 0.8.4 后发布。
代价：包内的运行诊断卡读不到 `stuck`/`recovered`/`lastMapInjection`（服务端字段在 main 上），
三行显示"没有记录"。**main 没有 bump 版本**，仍是 0.8.4 的源码 + 阶段 0，等下一版再发。

## 9. 0.8.4 发布记录（2026-11-03）

| 项 | 值 |
|---|---|
| npm | `dsh-trivium@0.8.4`，`latest`；44 个文件 / 222.9 kB；shasum `7fe82656dbbf99eeab87090ab64c28b88f8a0d85` |
| Git | 分支 `release/0.8.4`（tag `v0.8.4` → `d83450c`；其后只有 `0a75b84` 补英文说明） |
| GitHub Release | https://github.com/QWQcool/dsh-trivium/releases/tag/v0.8.4（正文中英并列） |
| 发布说明 | `docs/release-0.8.4.md`（中）/ `docs/release-0.8.4.en.md`（英） |
| README | 中英同步：版本行、四页说明、Changelog（补 0.8.3/0.8.4）、截图换成 0.8.4 实拍五张（`docs/screenshots/10..14`） |
| 反查 | 从 npm 拉回 tarball 校验：`package.json` 0.8.4，`lib/client.js` 含四页键/命令面板/`data-layout` |

**注意**：`npm publish` 后注册表边缘缓存约几十秒才刷新；期间 `npm view` 仍返回 0.8.3、重复发布报
`409 Cannot publish over previously staged version`，这两条都**不代表发布失败**，以
`https://registry.npmjs.org/dsh-trivium/latest` 为准。

## 10. 阶段 1 前半（A）：并发实测 + 只读继承（2026-11-03）

| 项 | 结果 | 证据 |
|---|---|---|
| 锁竞争实测 | 3 进程、800ms 轮间隔：抽取 50/400/1500ms 时撞锁率 **19.4% / 52.8% / 77.8%**，三档 **丢写 0**（落库数=成功数） | `S1/CONCURRENCY-2026-11-03/README.md`，`scripts/bench-lock-contention.mjs` |
| 更硬的限制 | 进程内**缓存读写句柄**，第二个进程直接 `TDB_ERROR: Database locked`；30s TTL 的文件锁在那之后形同虚设 | 同上；真机另见 §8 的 `locked by another DSH instance` |
| 只读继承 | `inherit` 从"抛错"变成"读父库、写自己"：`resolveScope` 返回 `mode:"read-parent"`，新增 `lib/inherit.js` 的 `inheritedParent` / `readInheritedMap`（只读打开、预算内建图、读完即关、失败降级不抛） | `S1/INHERIT-READ-2026-11-03/README.md` |
| Router 原型 | 新增 `lib/router.js`：每工作区一个端点（命名管道/套接字），持有唯一句柄，按到达顺序执行 insert/merge/link/update；`createRouterClient` 返回满足 `MemoryWriter` 端口的 writer，连不上就 `ROUTER_UNAVAILABLE` **不静默回退** | `S1/ROUTER-2026-11-03/README.md` |
| Router 效果 | 同样 3×10、800ms 轮间隔：锁模式落库 29/17/**8**（50/400/1500ms），Router 三档都是 **30/30**；墙钟更慢是因为把活干完了 | `scripts/bench-lock-contention.mjs --router` |
| 队列延迟 | 2/5/10 Worker × 50 写：落库全对，p50 8.4 / 24.1 / 50.4 s，**p95 最高 75.3 s**；根因是**每次写都 flush**（直写 188 ms/条、flush 91 ms/次），吞吐上限 ≈5 次/秒，队列本身不是瓶颈 | `S1/QUEUE-2026-11-03/README.md`，`scripts/bench-router-queue.mjs` |
| 批处理 | `runDeferredWrites` + `flushWorkspaceDb`：Router 每 tick 一批、flush 后才回包；同基准 p95 从 8.4/24.1/75.3 s 降到 **126/165/206 ms**，吞吐 11.8/10.3/6.6 → **518/1025/1462 次/秒**，落库仍全对 | 同上文末「修复后」 |
| 待补写可见 | `pendingSummary` + `GET /api/dsh-trivium/pending` + 运行记录页「待补写」卡片（窗口数/事件数/已确认/文件时间/每窗口 80 字预览），坏文件降级、读不写盘 | `S1/PENDING-VISIBILITY-2026-11-03/README.md` |
| 真机会话复测 | 两种结局都出现：0 分 + 工具证据 → 升 1 分、内容门 `tool-evidence`（「继续。」没被丢）；0 分 + 无工具 → 整窗丢弃 `skippedBy:"screen"`、`screenedOut:2`、**没有发生抽取调用**。一轮 `full/147 token` 原因未定位（未记 `reason`） | `S1/REAL-SESSION-2026-11-03/README.md` |
| 回归 | `smoke-p80` 22/22、`smoke-p81` 13/13、`smoke-p82` 13/13、`smoke-p78` 56/56、`smoke-p77` 21/21（3 条按新语义更新）、`run-all` **83/83** | — |

**为什么写回没做**：实测下 78% 的抽取会推迟，而 work item 目录是短命的——推迟到没人再开库就是静默丢事实。
写回上级必须由 Router 承担，这是后半（B）的内容。`inherit` 目前**没有任何调用方**，默认路径零变化。
