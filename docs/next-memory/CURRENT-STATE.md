# 当前状态（单一入口）

> **2026-11-06 收尾更新**：0.8.6 快筛只记分，p88 已合并到 p74/p75，部分提交未知计数为 null。
> 最新验证与放行结论见 [最终放行记录](../reviews/0.8.6-FINAL-RESULTS.md)；下文保留历史阶段记录。

> **动手前先读这一页。** 历史文档里的"当前 / 未发布 / 下一步"以它自己的日期为准，不是今天的指令。
> 本页只写"现在是什么状态、什么已经验过、什么别再重复"，细节仍在各自文档里。

更新：2026-11-10。发布基线 **0.8.7**（tag `v0.8.7`）；main 只比标签多 3 个文档提交，**没有未发布的代码**。
本页 2026-11-09 版写的是 0.8.6 / 0.8.7 开发中，已按 0.8.7 放行记录与本机实跑更新。

## 1. 发布包与源码

| 范围 | 状态 |
|---|---|
| npm 发布包 | **`latest = 0.8.7`**（tag `v0.8.7`，2026-11-09；放行记录见 [`0.8.7-FINAL-RESULTS`](../reviews/0.8.7-FINAL-RESULTS-2026-11-10.md)、发布说明 `docs/release-0.8.7.md`） |
| 发布分支 | `release/0.8.4`、`release/0.8.5` 保留为当时的发布快照；两个 store 修复已用 parity 提交搬回 main（`8801fd6`、`4b0ad42`），**不需要合并** |
| 当前 main | 比 `v0.8.7` 多 3 个**文档**提交（README 指向、发布回执、宿主验证 + 清理已废弃计划文档），无未发布代码 |
| 依赖 pin | `package.json` 要 `triviumdb@0.9.0`（正式版） |
| 本机实际内核 | 两台机器都已是 **`0.9.0`**（Administrator 机 2026-11-05 用 `npm install` 对齐，之前是 0.8.11）。跑测前仍建议自己查一次 |
| 宿主基线 | `@deepseek-ai/dsh@0.2.2-rc.1`（2026-11-10 实机启动验证）；README 里的 `0.2.1-rc.4` 已同步改掉 |

自查命令：`git rev-list --count v0.8.7..HEAD`、`node -e "console.log(require('triviumdb/package.json').version)"`。

## 2. 已验证（按证据强度分层，别混用）

| 层 | 结论 | 证据 |
|---|---|---|
| 离线回归 | `run-all` **87/87**（119 个脚本，目录上限 120；p88 已并入 p74/p75，新增 p89/p90）、`verify-evidence` **9/9** | 2026-11-06 本机实跑 |
| 0.8.6 放行 | 收尾时 `run-all` **88/88**、`npm pack --dry-run` 49 文件、付费调用 0 次（¥0） | [`0.8.6-FINAL-RESULTS`](../reviews/0.8.6-FINAL-RESULTS.md) |
| 0.8.7 放行 | `main@f9d72e9` 上的拒绝保护阻塞项已修；真实插件入口回归（含 pending replay 全链路）与日期反例通过；脚本仍 119 | [`0.8.7-FINAL-RESULTS`](../reviews/0.8.7-FINAL-RESULTS-2026-11-10.md) |
| 真实模型 + 合成夹具 | A5：抽取命中 25/25、进库 25/25、新会话答对 21/25；A10：改口/否定各 10/10 | `A5-WIDER-BASELINE`、`A10-REGRESSION-N10` |
| 真实宿主 + 桩模型 | R3 第一片采集预检 16/16；注入/预算/过期/坏链在真宿主成立 | `R3-HOST-RESULTS` 第三片前 |
| 真实宿主 + 真实模型 | R3 第二片：S1 通过；S2 落库是改写句、新会话答对；**S3 长尾失败**（`verify-QA-71` 丢失，0.8.2 修复后 11-01 复测通过） | `R3-HOST-RESULTS` §四 |
| 真机 UI | 设置页 1280 浅色可截；入口 = **账号菜单 → 设置**（`Ctrl+Alt+,`）→ 左侧「Trivium 记忆」 | 2026-11-01，`.tmp/r3/p1/` |

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
| 发布内容 | **`docs/release-0.8.6.md`**（中）/ `release-0.8.6.en.md`（英）；内核升级见 `release-0.8.5.md`；设置页见 `release-0.8.4.md`；更早见 0.8.3 / 0.8.2 / 0.8.1 / 0.8.0 |
| 放行与复审 | `docs/reviews/0.8.6-FINAL-RESULTS.md`（放行结论）、`0.8.6-REVIEW-PACKET.md`、**`0.8.7-REPORT-2026-11-06.md`**（A–C 批，含需拍板的取舍） |
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
| 批量导入 | `importExternal` / `addChipsFromText` 包进 `runDeferredWrites` + finally flush：22 条从 2020ms/47 次 flush 降到 **110ms/2 次**（18.4×） | `S1/IMPORT-BATCH-2026-11-03/README.md` |
| 真机会话复测 | 两种结局都出现：0 分 + 工具证据 → 升 1 分、内容门 `tool-evidence`（「继续。」没被丢）；0 分 + 无工具 → 整窗丢弃 `skippedBy:"screen"`、`screenedOut:2`、**没有发生抽取调用**。一轮 `full/147 token` 原因未定位（未记 `reason`） | `S1/REAL-SESSION-2026-11-03/README.md` |
| **三 Worker 验收** | 3 个子进程各在 `repo/item-N`：三条相同的「发布窗口」只存 **1 条**（另两次 `merge`），4 条不同事实全落库，父库种子不重复，三个 item 目录**都没有**自己的库 | `S1/THREE-WORKERS-2026-11-03/README.md` |
| 继承的读路径 | 实测：Router 持有句柄时，Worker 的只读打开**必然 `unreadable`**（引擎拒绝第二个句柄）→ `readInheritedMap` 改为回退到 Router 的 `map` 操作，返回值新增 `via: "file"｜"router"`；无 Router 时仍返回原来的失败 | 同上 |
| Router 新操作 | `apply(candidates)`（去重/合并必须在持有数据库的进程里做）与 `map(budget)`（Worker 不必开第二个句柄） | 同上 |
| 回滚开关 | `scopeInheritance`（默认关）：关掉时 `readInheritedMap` → `reason:"disabled"`、`startRouter`/`createRouterClient` → `SCOPE_DISABLED`，都在**开句柄/连管道之前**；`allow` 参数可显式覆盖文件（两个方向都测了）；默认写路径与 0.8.3 逐字节一致 | `smoke-p85` 17/17 |
| 回归 | `smoke-p80` 22/22、`smoke-p81` 16/16、`smoke-p82` 13/13、`smoke-p83` 12/12、`smoke-p84` 14/14、`smoke-p85` 17/17、`smoke-p78` 56/56、`smoke-p77` 21/21、`run-all` **86/86** | — |

**为什么写回没做**：实测下 78% 的抽取会推迟，而 work item 目录是短命的——推迟到没人再开库就是静默丢事实。
写回上级必须由 Router 承担，这是后半（B）的内容。`inherit` 目前**没有任何调用方**，默认路径零变化。

## 11. 内核 0.9.0 适配（2026-11-04）

| 项 | 结果 |
|---|---|
| pin | `triviumdb` 从 `0.9.0-beta.3` 升到 **`0.9.0`** 正式版 |
| 通过数 | 0.9.0 下改前 **30/86** → 现在 **86/86** |
| 根因 | 0.9.0 的类型化存储**拒绝 `undefined`**（beta.3 静默丢弃）；我们的 payload 全是展开可选字段造的 |
| 改法 | `hardenEngine` 在引擎边界统一 prune，写面取自 `triviumdb.d.ts`：`insert / insertWithId / updatePayload / updateEdge / commitTransaction` |
| 导入 | `commitTransaction` 是第五条写路，p5 的第二次导入曾报 `TRANSACTION_FAILED` |
| peer | `npm install` 会删掉 `@deepseek-ai/dsh-llm`、`dsh-tools`（registry 只有 0.0.1-rc.1，不满足 peer 范围），`scripts/link-peers.mjs` 在 run-all 启动时自愈 |
| 性能 | 单写更快（188→155.5 ms/条，flush 91→73.7 ms）；**批量路径更慢**（队列 p95 206→483 ms，吞吐 1462→559 次/秒），仍 0 丢写 |
| 只读并发 | 0.9.0 **没有**解锁"另一个进程只读打开"：p84 三个 Worker 仍 `via:"router"`，`readInheritedMap` 的回退必须保留 |

证据：`evidence-write-provenance/INFRA/TDB-0.9.0-2026-11-04/README.md`。
