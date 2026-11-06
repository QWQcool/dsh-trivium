# 0.8.6 真机验收（2026-11-06）

范围：只验数据正确性、协议契约、错误降级、持久化与并发安全、token/费用。没有新增 UI/UX、
样式、布局、视觉基线或开屏时间类测试（仓库 `AGENTS.md` §5）。A3 的「卡片与文件一致」是
读两张卡片里的**文本**做数据比对，不是渲染断言。

- 宿主：DSH `--profile web --port 5199`，本地 Chrome（CDP 驱动对话）
- 模型：`deepseek-flash`（`request/header` 里实测 `provider=deepseek-official`）
- 工作区：`dsh-trivium` main @ `6f30256`，`package.json` 0.8.6 / `triviumdb` 0.9.0
- 记忆库：仓库 `.dsh/`。实验前整组备份到 `.tmp/db-backup-2026-11-06/`（13 个文件）
- 原始 JSON 全部在 `raw/`，下面每条结论都能在对应文件里逐字核对

结论摘要：**5 项里 4 项通过，A2 的「一轮只走 1」失败**（实测一轮走 3）。另发现一个
诊断字段盲区（见 §7）。费用**估算**约 ¥0.88（基于未核实的 12k 输入 token/请求假设，非账单、
也非证明过的上界）。

---

## 1. A1 事件快筛的两种结局

### 1.1 整窗丢弃 — 通过

原始值（`raw/13-aborted-turn-screen.txt`，2026-11-06T04:55:02.344Z）：

```json
"extract": { "applied": 0, "skippedBy": "screen", "screenedOut": 1,
             "screenedCounts": { "scored0": 1, "scored1": 0, "scored2": 0 },
             "gate": { "skipped": true, "reason": "screen-empty" } }
"screen":  { "dropped": 1,
             "audit": [{ "rule": "filler", "score": 0, "text": "ok", "turns": 1, "dropped": true }] }
```

> `skippedBy:"screen"`、`screenedOut:1`、`audit[0].dropped:true` 三项同时成立。

**「无抽取调用」是结构性的，不是观察到的巧合**：`lib/index.js` 的 `runExtract` 在
`if (!screened.turns.length)` 分支里直接 `return true`（第 527–543 行），而 `llmCall` 只在
后面的 `distill` 分支构造。走到这个分支就不存在模型请求。

**成因必须说清楚**：这轮是靠「发送 `ok` 后 1.2 秒点击『停止生成』」造出来的。不中止的话，
这轮会调 `ctx_find`（见 §1.2），窗口里有工具轮，筛不掉。中止的那次请求可能已经发出，
无法从本地确认是否计费。

### 1.2 0 分 + 工具证据保留 — 通过

原始值（`raw/06-turn3.json`，用户文本就是 `继续`）：

```json
"extract": { "applied": 0, "screenedOut": 0,
             "screenedCounts": { "scored0": 0, "scored1": 1, "scored2": 0 },
             "gate": { "skipped": false, "reason": "tool-evidence" } }
```

同一输入喂给同一函数（`raw/17-screen-score-pure.txt`）：

```json
{"text":"ok","score":0,"rule":"filler"}
{"text":"继续","score":0,"rule":"filler"}
```

证据链：用户文本 `继续` 得 0 分（filler）→ 该组含工具结果被提到 1 → 窗口不是「整窗为 0」
→ 不丢弃、`gate.reason = "tool-evidence"` → 模型仍被调用（`applied 0` 说明这轮确实没有
可写事实，不是被跳过）。

**测到的口径缺陷**：`lastScreen.counts` 统计的是**工具证据提升之后**的组分数，所以这里读
`scored1:1` 而不是 `scored0:1`；`audit` 只记录「最终仍为 0」的组，于是「一个 0 分轮被保留」
这件事在 status 里**没有任何字段直接表示**。见 §7 建议。

---

## 2. A2 地图 `full → skip → diff` 与 `turnsSince`

### 2.1 三态 — 通过

`raw/02-turn1-maphistory.json`（同一个用户轮次内依次出现）：

| at (UTC) | mode | reason | tokens | turnsSince | version |
|---|---|---|---:|---:|---|
| 04:33:37.838 | full | session-start | 123 | 0 | `mapv-fnv1a-16d80997-7-400` |
| 04:34:51.783 | skip | unchanged | 0 | 1 | 同上 |
| 04:34:57.536 | diff | changed | **42** | 2 | `mapv-fnv1a-cb600d61-8-400` |
| 04:34:58.765 | skip | unchanged | 0 | 3 | 同上 |

`diff` 的触发是真实的记忆变化：这轮模型自己调 `ctx_remember` 写了一个节点（change log 里
没有它，因为不是抽取写的），版本从 7 条变 8 条。`diff` 42 tokens vs `full` 146 tokens。

`raw/08-turn4-maphistory.json` 在同一进程里又走了一次 `full → skip → skip`（新会话
04:49:07 full，04:49:22 skip t=1，04:49:26 skip t=2）。

### 2.2 一轮对话 `turnsSince` 只走 1 — **失败**

一轮用户对话（04:34:51 → 04:36:03 抽取结束）里 `turnsSince` 走了 **0 → 1 → 2 → 3**，
即 +3。复现两次：

| 轮次 | 该轮内的 turnsSince 轨迹 | 增量 |
|---|---|---:|
| T1（`raw/02-turn1-maphistory.json`） | 1 → 2 → 3 | +3 |
| T5（`raw/09-turn5-maphistory.json`） | 2 → 3 → 4（前缀 1 来自上一轮） | +3 |

这正是历史上出现过的「一轮走 4」缺陷，**当时没有修好**。后果是成本而不是数据：
`turnsSince` 到 6 就强制 `full` 刷新，实际变成每两轮一次全量（146/154 tokens），而不是每六轮。

**T5 的完整轨迹**（`raw/09-turn5-maphistory.json`，共 **22 条**快照，工作区级 `mapHistory`）：

- 第 1 条 `04:54:01.672Z skip t=1` 属于前一个（中止轮次的）会话，**不是 T5**；
- 其余 21 条从 `05:35:41.203Z` 起属于 T5 所在
  `session-c61cf2e9-13e7-4fd6-b9f9-b17570474a60`（会话 id 见同轮 `trivium-pending.json`）：
  `t=2 @05:35:41` → `t=3 @05:35:45` → `t=4 @05:35:51` → `t=5 @05:35:53`
  → **`full/refresh 154 tok @05:35:55 (t→0)`** → `t=1..5 @05:36:02..10`
  → **`full/refresh 154 tok @05:36:15 (t→0)`** → `t=1..5 @05:36:17..27`
  → **`full/refresh 154 tok @05:36:32 (t→0)`** → `t=1 @05:37:26` → `t=2 @05:38:30`
  → `t=3 @05:38:31` → `t=4 @05:38:39`。
- 三次全量的版本全程都是 `mapv-fnv1a-24fde35f-10-400`（地图内容没变），纯粹由计数触发。
  上面表格里的「+3」只是这段轨迹的一个切片，**不是完整轨迹**。

**根因（修复时确认）**：`refreshShortMap` 的守卫是 `if (turnKey && previous.turnKey === turnKey) return null`，
只跳过*相等*的轮次键；工具循环后续 pre-step 不带用户消息、`mapTurnKeyOf` 返回 `""`，
空串与任何 key 都不相等，于是每个这样的 pre-step 都算一轮。当时猜测的
「channels-off 提前返回导致 `currentTurnKey()` 恒为 `""`」只是**同一现象的另一个侧面**，
不是守卫失效的直接原因；以 §9 的修复说明为准。

> 验收后已按第二种修法修掉，见 §9。**真实宿主上的复测没有做**（要再花一次模型调用），
> 所以 §2.2 的失败值仍然是这次真机的实测值，不代表修复后的行为。

### 2.3 另一处口径边界：`mapInjections.full` 不含会话起始

`mapInjections` 只在 `refreshShortMap` 里累加，`ensureShortMap` 注入的
`full / session-start` **不计入**。直接证据（`raw/02-turn1.json`）：04:36:03 时
`mapInjections = {"full":0,"diff":1,"skip":2}`，而同一进程在 04:33:37 已经注入过一次
`full / session-start`（`lastMapInjection` 还留着它）。按名字理解成「一共注入了几次全量」
会系统性少算，建议补计或改名。

---

## 3. A3 诊断字段与「运行记录」页待补写卡片

`raw/09-turn5.json` 里 `lastScreen` 与 `lastMapInjection` 都有值：

```json
"lastScreen": { "at": "2026-11-06T05:38:44.596Z", "dropped": 0,
                "counts": { "scored0": 0, "scored1": 0, "scored2": 1 }, "audit": [] }
"lastMapInjection": { "at": "2026-11-06T05:38:39.252Z", "mode": "skip",
                      "reason": "unchanged", "tokens": 0, "turnsSince": 4,
                      "version": "mapv-fnv1a-24fde35f-10-400" }
```

卡片 vs 文件 vs 接口（`raw/15-pending-card-vs-api.txt`，同一次读数）：

| 来源 | 窗口数 | 事件数 | 已确认 | 文件更新于 |
|---|---:|---:|---:|---|
| `GET /pending` | 1 | 51 | 144 | 2026-11-06T05:38:44.942Z |
| 卡片 DOM 文本 | 1 个窗口 | 51 条事件 | 144 | 2026-11-06 05:38:44 |

卡片预览文本 = 该窗口第一条用户消息原文（`…LOCKBUSY-2026-11-06…`）。诊断卡同一屏给出：

```
上次抽取 2026-11-06 05:38:44 batch 写入 0 · lock-busy
卡住     2026-11-06 04:40:05 lock-stale age=614s pid=999999
已自愈   2026-11-06 04:41:31 lock-stale 86021ms
上次地图注入 2026-11-06 05:38:39 skip unchanged 0 估算
```

**这个 1 窗口/51 事件是真实产生的**，不是我写进文件的：当时用一个**存活**进程
（pid 12780）持有 `.dsh/trivium-write.lock`，抽取按设计不等待 → `skippedBy:"lock-busy"`、
`applied:0`、窗口留在 `trivium-pending.json`（`error:"llm failed"`，51 条事件）。
顺带的行为证据：模型自己重试 `ctx_remember` 6 次全部拿到 `workspace write busy`，没有
谎称写入成功，而是把意图写到 `.tmp/pending-memory-writes/LOCKBUSY-2026-11-06.json`
并保留原话（`raw/12-agent-written-pending-note.json`）。

---

## 4. A4 真实导入一次 CLAUDE.md

`raw/14-claude-md-import.txt`，隔离工作区（`.tmp/s0-ws`，已注册、独立记忆库，主库零改动）：

```
file:   CLAUDE.md · Claude Code · claude-workspace · 869 bytes · 24 行
import: HTTP 200 · elapsedMs 259 · created 4 · merged 0 · linked 4 · skipped 7 · applied 4
nodes:  1 → 5（+4，全部 type=preference，id 2..5）
```

- **真实等待时间 259 ms**（含 HTTP + 解析 + 写库 + 建边；不是模型调用，这条路不进 LLM）
- **写入条数 4**，跳过 7 条——导入器的「偏严宁漏」按设计生效（没有规则线索的段落不写）
- 同一接口对**未注册**的工作区返回 `400 {"ok":false,"message":"还没有打开工作区"}`；
  这条没有原始文件（当时脚本输出被下一次运行覆盖），只作为过程记录，不作为结论。

不能拿来证明「批量写入 22 条 110ms」那个数：本次只有 4 条，口径也不一样（导入 vs 抽取写回）。

---

## 5. A5 陈旧锁 → `stuck` → `recovered`

第 1 段（`raw/03-status-after-restart-stale-lock.json`）。做法：停宿主 → 写入
`{"pid":999999,...}` 并把 mtime 设到 10 分钟前 → 重启宿主（会话启动时读锁）：

```json
"stuck": { "kind": "lock-stale", "at": "2026-11-06T04:40:05.951Z",
           "detail": "age=614s pid=999999", "open": ["lock-stale"] }
```

第 2 段（`raw/05-status-after-turn2.json`）。之后跑过一轮成功抽取（`llmFailed:false`）：

```json
"recovered": { "kind": "lock-stale", "at": "2026-11-06T04:41:31.972Z",
               "afterMs": 86021, "open": [] }
```

配套事实：锁文件在抽取时被回收并删除（`Test-Path` → False）；change log 有配对的两行
（`raw/16-changes-stuck-recovered.jsonl`）：

```
{"reason":"stuck","opId":"…:stuck:lock-stale","detail":"lock-stale"}
{"reason":"recovered","opId":"…:recovered:lock-stale","detail":"lock-stale"}
```

另有一次失败尝试值得记：第一次植锁无效。原因是当时点的是侧栏「在“dsh-trivium”中新建会话」，
它**没有真的建新会话**（`~/.dsh/sessions/` 下没有新目录），新一轮落进了开机时已创建的
agent，`agent/created` 不会再触发，`staleLockInfo` 自然没跑。改用全局「新会话」按钮
（`Ctrl+Alt+N` 那个）后立刻产生 `session-830d0b54…`，也才有了 §2.1 的第二次 `full`。

---

## 5.1 顺带测到：地图热度（B2）确实在写，且有一个清理缺口

不在 A 的清单里，但因为同一次会话自然覆盖到了，记录原始值。

`.dsh/trivium-usage.json` 前后对比（`raw/19-usage-before.json` / `raw/20-usage-after.json`）：

| | 条目数 | 节点 3 | 节点 4 | 节点 8 | 节点 15 | 新增条目 |
|---|---:|---:|---:|---:|---:|---|
| 实验前（11-04 06:13） | 13 | 6 | 7 | 2 | 8 | — |
| 实验后（11-06 05:36） | 16 | 7 | 8 | **4** | 9 | 32 / 33 / 34 |

- 引用计数按次递增、`updatedAt` 被 60s 节流为一次（05:36:45 一次），与 `lib/usage.js`
  的设计一致；
- **缺口**：32/33/34 是本次写进去又删掉的节点，删节点**不会**清掉热度边车里的条目。
  也就是说 `.dsh/trivium-usage.json` 会长期保留已删节点的计数。它只是排序信号、不参与
  事实事务，所以不影响正确性，但会让「热度榜」出现幽灵条目。

为不留测试痕迹，实验后已把该文件恢复成 11-04 的快照（13 条）。

## 6. 费用

`raw/18-cost-estimate.txt`：3 个会话共 **30 次**模型请求（assistant 消息计数），输出字符
34,864。宿主的 `session_projcache` 里**没有**这几场的 `usage`（进程是被 Stop-Process 杀掉
的，stats 没落盘），所以只能给**估算值**：

| 口径 | 值 |
|---|---:|
| 请求数 | 30（+2 次抽取调用） |
| 输出 token 估算 | ≈ 13.9k（字符/2.5） |
| 提示 token **假设** | 12k/请求（实测工具+系统提示头 31,118 字符 ≈ 8k tokens，再加历史；**未经计量**） |
| **峰价估算** | **≈ ¥0.88** |
| 谷价折算 | ≈ ¥0.44 |
| 预算 | 单次 ≤¥3、当日 ≤¥10；本次 ≤¥1 自查 |

**这不是账单，也不是经过证明的费用上界**：12k/请求是复核发现的未核实假设，缓存命中、
短请求、上下文复用都会让实际值偏离（复审材料修正项已指出）。按 `COST-MODEL.md` 的峰价表
只能说"在这个假设下约 ¥0.88"。

---

## 7. 未覆盖与口径边界

1. **地图热度（B2）只有落盘证据，没有排序效果证据**。边车文件的计数与节流都实测到了
   （§5.1），但「热度有没有让地图/召回的排序变好」这次没有对照，不能宣称。
2. **身份模糊合并默认关闭**（`identityMerge`），Router / inherit / scope 无调用方；但
   **MemoryWriter 默认就在抽取写路径上**（`lib/extract.js` 的 `memoryWriterFor`），
   `identity.js` 的类型/否定/数值守卫**默认参与** `findMergeTarget`（`lib/store.js`）。
   复审 F86-04 纠正了"整组零调用方、零默认行为"的申报；这几条路径本次仍无真机效果数据。
3. **没有多进程并发写验证**。`lock-busy` 是「外部存活进程占锁」造出来的，不是两个 DSH
   实例同时写；两个实例抢同一库的路径这次没跑。
4. **事件快筛在真实宿主上几乎不会整窗丢弃**：模型每轮（连 `ok` 都算）都会调 `ctx_find`，
   工具证据把窗口救回来。这次的「整窗丢弃」是靠中止轮次造出来的。
5. **`lastScreen` 缺「0 分被工具证据保留」的直接字段**（§1.2）。建议加一个计数器
   （例如 `keptByToolEvidence: n`），否则 A1b 这种结论只能靠「原文 + 纯函数 + gate.reason」
   三条线拼，验收时容易被质疑。
6. **`mapInjections.full` 不计 session-start**（§2.3），建议要么补计，要么改名说明范围。
   本次没有把 `full` 拆成 `session-start` 与 `refresh` 两类，所以「全量注入了几次」这个数
   在 status 里查不全。
7. **`turnsSince` 一轮 +3 是本次唯一失败的验收项**；验收后修过两轮（§9），但**真机未复测**。

## 8. 收尾（已核对）

- 测试写入的 3 个节点（32/33/34）已删，节点回到基线 8 条、id 集合与实验前一致
  （`raw/00-nodes-before.json` vs `raw/11-nodes-after-cleanup.json`）
- `.dsh/trivium-pending.json` 已恢复为实验前快照（`windows:0`），避免下次会话付费重放测试窗口
- `.dsh/trivium-usage.json` 已恢复为 11-04 快照（13 条），清掉测试造成的计数增量与幽灵条目
- `.dsh/trivium-changes.jsonl` 已恢复为实验前快照（15 行），去掉本次 5 行测试记录
  （`written 33/34`、`stuck`/`recovered`、`lock-busy`）；这些行的原文留在
  `raw/16-changes-stuck-recovered.jsonl`，上面的结论不依赖它们留在库里
- `.dsh/trivium-write.lock` 不存在；5199 端口无残留进程
- 临时目录 `.tmp/a4-ws`、`.tmp/pending-memory-writes`、`.tmp/chrome-profile-a` 已删；
  `.tmp/s0-ws` 恢复原状（还原了被改名备份的 `.dsh`）
- `git status` 只有本证据目录

## 9. 修复记录（验收之后，共两轮）

### 第一轮（`38a91ff`）

`refreshShortMap` 的守卫只跳过*相等*的 key，而工具循环后续 pre-step 不带用户消息、
`mapTurnKeyOf` 返回 `""`，空串与任何 key 都不相等 → 每个这样的 pre-step 都加一次。
改成「空 key 属于已打开的那一轮」，与 `resolveTurnKeyForLedger` 同一规则；`smoke-p74`
29 → 33。防恒真：守卫改回旧的一行 → p74 **31/33**（`4 !== 3`，多注入一次），改回 33/33。

### 第二轮（复审 F86-01 之后）

Astra 在 `470f7b4` 上用真实消息构造器复现出两个遗漏：

| 反例 | 修复前 | 修复后 |
|---|---|---|
| 从未拿到键的会话，连续 6 次空 pre-step | `1→2→3→4→5→0`，第六步 `full/refresh` | `1,1,1,1,1,1`，无 full |
| 无 host id、正文在 `content[]` 的两条不同消息 | 都得到 `t:1` | `t:1` / `t:2` |

根因与第一轮同源：`previous.turnKey` 会被写成 `""`，**无法区分「第一次空观察」与
「已经处理过的空观察」**；而 `mapTurnKeyOf` 的回退只读 `last.text`，真实 DSH v4 消息把正文
放在 `content[]`。

修法：地图状态加独立的 `sawTurnKey` 锚点（只有第一次观察能推进计数），
`mapTurnKeyOf` 从 `content[]` / `message.content[]` 读文本。正向对照未退化：有键宿主六个
用户轮（每轮 3 个空续步）仍是 `1,2,3,4,5,0`，只在第六轮全量。

**回归**：`p74` 33 → **36**、`p86` 15 → **16**；另补 `p82` 13→14（损坏 pending 的接口级
失败）、`p83` 12→14（重开持久性 + 部分提交回执）、`p87` 20→22（模糊合并真正走入口）。
全量 `node scripts/run-all.mjs` → **89/89**。

**诚实边界**：从不在任何窗口暴露用户消息的宿主拿不到轮次键，会停在第一次观察、不触发
6 轮强制全量。离线契约复现通过，真机样本仍为零。

**没做的**：没有在真实宿主上复测「一轮只走 1」（要再花一次模型调用）。§2.2 的失败值
仍是本次真机的实测值，不代表修复后的行为；逐条修复值与完整 T5 轨迹见
`docs/reviews/0.8.6-REVIEW-PACKET.md` §九。
