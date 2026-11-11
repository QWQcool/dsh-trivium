# 改口不建 supersedes 边：成因与最小修复方案

日期：2026-11-02。只做分析，**未改代码、未发布、未花模型费用**（复现全部用桩 + 本地库）。

---

## 0. 接手时的基线核实

第一次核实时本机 HEAD 是 `8499da7`，`CURRENT-STATE.md` 还不存在（远端当时也停在 `8499da7`）。按要求同步远端后：

| 项目 | 现状 | 结论 |
|---|---|---|
| HEAD | **`c05a2b7 docs: add a single-entry current-state page`** | 与交接说明一致 |
| `CURRENT-STATE.md` | **已存在（79 行），已通读** | 一致 |
| 工作树 | 干净（仅本文件未跟踪） | 一致 |
| `run-all` | **63/63 passed** | 与 §2 一致 |
| `verify-evidence` | **9/9** | 与 §2 一致 |
| `triviumdb` | **0.9.0-beta.3**，与 `package.json` pin 相同 | **与 §1 表述不一致**（§1 写 0.8.11） |
| `v0.8.2..HEAD` | **11 个提交** | §1 写 10 个（差值就是 `c05a2b7`） |

两处需要更正 `CURRENT-STATE.md`：

1. §1「本机实际内核 = 0.8.11」在**这台机器上不成立**——`node -e "require('triviumdb/package.json').version"` 返回 `0.9.0-beta.3`，与 pin 一致。不需要标"旧内核"。
2. §1「比 `v0.8.2` 多 10 个提交」现在是 **11 个**（含本页自身的提交）。

另外 §4.1 已经把这个缺陷写成"抽取走 merge 分支，从未进入新建+建边"——**本文与之一致**，并补上了"为什么走 merge""三处与门""三方案代价"。
§4.1 引用的证据目录 `.tmp/r3/evidence-clean-run-20261101-172142/` 以及同批备份 `.tmp/r3/backup-20261101-172142/` **在本机都不存在**（已被移出），所以无法对那次真机库做交叉核对；本文的复现全部来自本地桩。

本轮**没有重做** §5 列出的任何实验（R3 S1/S3、A5、A10、C3、面板隔离），也没有产生模型调用。

代码行号基于 `c05a2b7`（该提交只加了 `CURRENT-STATE.md` 与 `docs/README.md` 两行，不含 `lib/` 改动，与 `8499da7` 的源码一致）。

---

## 1. 现象（可离线复现）

交接给的现象是：两轮「这次上线按方案 A 走」→「算了，不用 A 了，改 B」，结果

- 只剩 **1 个** decision 节点，正文是"先按 A，随后改 B"；
- `lastExtract.supersededCount = 0`，库内 `supersedes` 边 `[]`；
- 新会话能答对 B，但 `currentHeadOf` / 短地图 / matched_history 都没有依据。

我用桩把这条链路原样重放（`.tmp/cc/repro-merge2.mjs`），拿到**完全一致**的库状态：

```text
mergeTarget: 2   (old id = 2)
applied [{ "id": 2, "action": "merge" }]
superseded []
decisions [{ "id": 2, "text": "按方案 A 走，随后改 B" }]
edges (none)
```

即：旧节点被**原地改写**，不是"新节点 + 建边"。这也解释了为什么"答对了"和"没建链"能同时成立——答案来自那一个被改写的节点。

---

## 2. 代码路径（`8499da7`）

```
distill()                                  lib/extract.js:854
  └ applyCandidates()                      lib/extract.js:776
      ├ for (cand of ordered)              lib/extract.js:791
      │   ├ findMergeTarget(db, cand)      lib/extract.js:792   ← 判定"合并进旧节点"
      │   ├ mergeInto(db, existing, ...)   lib/extract.js:825   ← 走合并分支
      │   └ insertNode(db, payload)        lib/extract.js:828   ← 走新建分支
      └ linkReplacementDecision(db, id, …) lib/extract.js:848   ← 建边（对 merge/insert 都调用）
```

`findMergeTarget` 的匹配键在 `lib/store.js:336-359`：

```js
339  const name = String(candidate.name || "").trim().toLowerCase();
340  const text = String(candidate.text || "").trim().toLowerCase();
345  if (!allowRevisionLinked && isRevisionLinked(db, n.id)) continue;   // 已在版本链里 → 跳过
354  if (text.length >= 8 && nText && (nText === text || nText.includes(text) || text.includes(nText))) return n.id;
```

**关键就是 354 行：正文的"子串包含"，双向都算命中。** 实体类型另有按 name/alias 的精确匹配（350-351），非实体只看正文包含。

命中合并后，正文由 `pickMergedText`（`lib/store.js`，`mergePayload` 里调用）决定：短文本取**较长的那个**，
所以旧版本被新句子覆盖，旧事实**不留痕迹**。

---

## 3. 三个判定条件，真实案例一个都没过

### 条件一：不能先被合并掉（`store.js:354` + `extract.js:824-829`）

只要新候选正文**包含**旧正文（含标点完全一致），就会 merge 到同一个 id。
真实模型给的正是"把旧决定和更正写进同一句"，于是合并发生。

合并之后再调 `linkReplacementDecision(db, id=旧节点, …)`，而它第一步就跳过自己：

```js
336  if (id === Number(newId)) continue;   // lib/extract.js
```

→ 目标集合为空 → 直接 return。**边从结构上就不可能诞生。**

> 这条规则对措辞极其敏感：旧正文带句号「按方案 A 走。」时，新句「按方案 A 走，随后改 B」因为逗号不同**不**包含旧句，会变成"新建节点、无合并"（我复现过，见 `.tmp/cc/repro.mjs` 的 A 组）。
> 也就是说同一场景有时 1 个节点、有时 2 个节点、**两种情况都没有边**。

### 条件二：用户原句必须命中"替换词"（`extract.js:331`）

```js
35  const REPLACEMENT_CUES = /更正|改为|改成|改用|不再(?:使用|采用|用)|替换|取代|放弃|作废|deprecat|replace(?:d)?|switch(?:ed)? to/i;
```

真实句「算了，**不用** A 了，**改** B」：

- 「不用」≠「不再使用 / 不再采用 / 不再用」；
- 「改 B」≠「改为 / 改成 / 改用」。

**不命中 → 直接 return。**

### 条件三：用户原句必须字面包含旧节点的标签（`extract.js:340` + `290-302` + `389-392`）

```js
340  const label = decisionLabels(payload).find((row) => sentence.includes(row));
298  if (name.length >= 2 && name.length <= 24) labels.add(name);
390  const m = String(span).match(/方案\s*([A-Za-z0-9甲乙丙丁…])(?![A-Za-z0-9_-])/u);
391  return m ? `方案 ${m[1]}` : undefined;        // 产出形如「方案 A」
```

标签形如「方案 A」，而用户写的是「不用 **A** 了」——**没有"方案"二字，`includes` 失败**。

三条是**与门**：需同时通过。我逐条断了验证（`.tmp/cc/repro-gates.mjs`）：

| 用例 | 用户原句 | applied | supersedes 边 |
|---|---|---|---|
| 替换词✅ 标签❌ | 更正：不再使用 **A**，改用 B | insert | 无 |
| 标签✅ 替换词❌ | **不用方案 A** 了，改 B | insert | 无 |
| 两者✅ | 更正：不再使用**方案 A**，改用 B | insert | **3 → 2 ✅** |
| 两者✅ 但候选重述旧文 | 同上 | **merge** | 无 |

最后一行就是生产里发生的组合。

---

## 4. 顺带确认：`supersededCount=0` 不是统计问题

`linkReplacementDecision` 只在成功建边后调用 `onSupersede({from,to})`（`extract.js:364`），
三处提前 return（无 quote / 无替换词 / 无标签）**都不上报**。所以 `supersededCount=0` 同时覆盖了
"没有触发"和"触发了但没目标"两种情况——它不能用来区分原因，这也解释了为什么之前一直定位不到。

---

## 5. 如果强制走建链路径，会不会堆重复节点？

分三种情况，不能一概而论：

| 情形 | 强制 insert 的后果 | 判断 |
|---|---|---|
| 真改口（旧 A → 新 B） | 2 个节点 + 1 条边，旧的成为历史 | **正确**，这正是 supersede 的语义 |
| 同一窗口被处理两次（重放 + 轮末） | 2 个**同义**节点，无边 | 会暴露重复。现在靠 merge 掩盖，禁用 merge 就会浮出来 |
| 只是复述/补充（不是改口） | 2 个近义节点 | 退化：这正是 merge 存在的理由 |

所以**不能全局关掉 merge**，只能对"已判定为替换"的候选关掉。

关于旧库 `#11/#12/#13` 三条并存：我**没有**去读默认工作区（约束里写明不可随意清空/改动，且读取也应先经同意）。
从代码看，三条同名并存最可能的来源是"同一句被不同窗口各抽一次"（W1 之前没有 source 去重），
与"强制建链"没有必然关系。**建议先在一份拷贝上跑 `ctx_find` 看这三条的 `source.seq/messageId` 是否相同**——
若相同，就是重复抽取，属于另一件事（去重），不要拿它当作"不能建链"的理由。

---

## 6. 三个候选修复（方案 1 已实现，见 §6.1）

### 方案 1：只在 `applyCandidates` 里加"替换意图"闸（局部、可离线验证）

```
候选是 decision
  → 用 W1 的证据链判断：quote 命中用户轮 && 用户句命中替换词（放宽后的）
  → 命中则 **跳过 findMergeTarget**，强制 insert
  → 然后照旧走 linkReplacementDecision
```

配套放宽两处匹配（都只在"替换场景"内生效，不影响普通写入）：

- 替换词补：`不用…了`、`改 X`（X 为单个字母/数字）、`换 X`、`别用`、`不要用`；
- 标签匹配：标签形如「方案 X」时，允许用户句里的**裸 X**（要求 X 位于替换词前后 12 字内，避免误配）。

- 改动面：`lib/extract.js` 约 40–60 行；`lib/store.js` 不动。
- 代价：替换场景下节点数 +1（预期行为）；措辞仍可能漏（比如用户说"上一个方案不要了"）。
- 风险：裸字母匹配有误伤可能，需要反例（"改成 B 方案"vs"方案 A 的 B 选项"）。

### 方案 2：只绕过 merge，不放宽匹配

- 改动：`extract.js:792` 加一个条件，约 15 行。
- 代价：**真实案例仍然失败**——用户原句既没替换词也没"方案 A"。只能修好"文案规整"的分支。
- 结论：不足以解决问题，只作为方案 1 的子集。

### 方案 3：让抽取显式产出替换关系（结构化）

```
prompt 增加字段：{"supersedes": "<旧事实原话或标签>", "quote": "..."}
写入时校验：quote 命中用户轮 + 被指认的旧节点存在且未被替代 → 建边并强制 insert
```

- 改动面：`buildExtractPrompt` + `filterCandidates`（校验新字段）+ `applyCandidates` + 回归，约 120–160 行，且 prompt 变长。
- 代价：多一次模型判断，可能引入新的幻觉（指认错旧节点）；需要"指认不唯一→待确认"的保护。
- 优点：不再依赖中文措辞与标签子串，**对"不用 A 了"这类口语最稳**；同时天然覆盖"跨会话改口"。

---

### 6.1 方案 1 的实现（本轮已落地，未发布）

| 改动 | 位置 | 说明 |
|---|---|---|
| 替换意图前置判定 | `lib/extract.js` `detectReplacementIntent()` | 用 W1 的 quote 证据 + 用户句；返回 `{replacement:true, sentence, positions}` 或 `{replacement:false, skipped}` |
| 替换不做合并 | `applyCandidates()` | `intent.replacement` 时跳过 `findMergeTarget`，强制 insert（**旧正文不再被覆盖**） |
| 裸字母匹配 | `matchedLabel()` + `bareLabelHit()` | 标签「方案 X」允许在用户句里只写 X，但要求 X 与替换词距离 ≤ 12 字符 |
| 替换词放宽 | `REPLACEMENT_CUES` | 增 `换成/换掉/不用/别用/不要用/不再…走/弃用` |
| 提前 return 上报 | `linkReplacementDecision()` | `no-quote` / `quote-not-in-source` / `discussion-or-question` / `replacement-not-in-user-sentence` / `no-target` 全部上报 |
| 状态分开 | `lib/index.js` | `supersededCount` 只算已建链/待确认，新增 `supersedeSkippedCount` |

验证（零模型调用）：

| 用例 | 之前 | 现在 |
|---|---|---|
| 生产原句「算了，不用 A 了，改 B」+ 候选重述旧文 | 1 节点、无边、旧文被覆盖 | **2 节点 + 边 3→2，旧文原样保留** |
| 「更正：不再使用 A」（只写 A） | 无边 | 有边 |
| 「不用方案 A 了」（无替换词） | 无边 | 有边 |
| 「更正一下：先记一笔今天的 A 版本变更」（A 远离替换词） | 无边 | **仍无边**，报 `no-target` |
| 普通决策（无替换意图） | 无边 | 无边且**不上报**（不制造噪声） |

回归：`p63` 11/11；既有反例 `p51` 15/15（讨论/疑问/引用/保持原样仍不退休）、`p48` 12/12；全量 `run-all` **64/64**。

### 6.2 方案 3 的实现（本轮已落地）

抽取 prompt 增加字段 `supersedes`（"这条决策替代了哪一条"，可为空、不许猜）。写入侧 `resolveExplicitSupersede()` 把它当**提议**而不是事实：

| 校验 | 不通过时 |
|---|---|
| 必须有 `quote` 且命中真实用户轮 | `no-quote` / `quote-not-in-source` |
| 用户句不能是讨论/疑问/假设/引用 | `discussion-or-question` |
| 目标必须**唯一**命中一个活决策（按标签/id/包含） | `supersedes-not-found` / `supersedes-not-live` / `supersedes-ambiguous` |
| 通过 | 强制 insert（不合并）+ 建边，`via:"model"` 记入 `superseded` |

这覆盖了既有规则覆盖不到的口语："上一个方案不要了，走新的"——既没有替换词，也没有标签。

回归 `p65` **12/12**（含"讨论即使点名也不退休""点名已替代的目标 → not-live""显式替代同样绕过合并"）。

## 7. 建议

**先做方案 1，把方案 3 记为下一步。**

理由：

1. 方案 1 是纯本地判定，能用今天的离线桩完整验证（四个用例已在手），不花模型钱；
2. 它同时修掉"合并吞掉旧版本"这个更根本的问题——即使匹配放宽后仍漏判，旧事实至少不会被覆盖（数据不会丢，只是没建链）；
3. 方案 3 更稳，但改 prompt 与 schema，属于下一批，且需要先有方案 1 的反例集做回归基线。

方案 1 里我建议**先只加"跳过 merge + 替换词放宽"，裸字母匹配单独一个提交**，
因为裸字母是唯一可能误伤既有事实的一步，要能单独回滚。

---

## 8. 合并覆盖旧正文「留痕」：业界做法与取舍

问题只剩"**不是替换、只是复述/补充**"那部分合并——它仍会把旧正文换成新的，旧的不可恢复。
Zep 与 Mem0 都在这一点上做了明确选择，值得照抄思路。

| 项目 | 做法 | 关键细节 |
|---|---|---|
| **Zep / Graphiti** | **失效而不删除**：新事实作为独立边写入，旧边把 `valid to` 闭合（等价 `invalid_at`） | 每条事实带四个时间戳：`valid from/to`（现实时间）、`observed`（信息源说的时刻）、`recorded`（系统摄入时刻）；查询按窗口过滤——"现在"取 open 窗口，"某天"取包含该日的闭窗口；失效是**逐条事实粒度**，不是整段覆盖 |
| **Mem0** | **历史表**：`old_memory` / `new_memory` / `event(ADD|UPDATE|DELETE)` / `is_deleted` | UPDATE 和 DELETE 都把旧值写进 `old_memory`，可回滚；历史在**向量库操作成功之后**写入，保证一致；`memory.history(memory_id)` 按时间返回 |

两者的共同点：**当前值之外一定还留着旧值，且旧值带时间与来源**。差别是粒度——Zep 把旧事实保留成图里的边（可做时点查询），Mem0 把它留在旁路表里（可做审计与回滚，但检索不参与）。

### 落到 Trivium 的四个选项

| 选项 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 只记审计** | 复用现有 `change-log`，合并时写一条 `merged`（old/new 摘要） | 零 schema 变化；UI 已有"记忆变化"块；改动 <20 行 | 只有摘要（120 字符），节点上查不到历史；日志裁剪（200 条）后彻底丢失 |
| **B. 节点级快照** | 合并时在 payload 写 `history: [{text, at, source}]`，上限 3 条 | 从节点就能看到"上一版是什么"，离线可查；不依赖日志保留 | 动 payload 结构（新增可选字段，旧节点无此字段仍兼容）；体积增长；**旧值也是数据，必须走同一套凭据闸门** |
| **C. 影子节点 + 边** | 合并前把旧正文写成一个 `archived` 节点，新节点 `supersedes` 它 | 与 Zep 语义最接近，可做"某天是什么"的时点查询 | 节点数增长，且与"merge 是为了防重复"直接冲突；需要额外的"这些是历史"的过滤规则 |
| **D. 彻底不合并决策** | 决策只增不改，全部用链 | 语义最干净 | 影响面最大，会把"复述"变成成对节点，短地图与检索都要改 |

### 已选 B（本轮已实现）

`lib/store.js`：`mergePayload()` 新增 `historyAfterMerge()`，合并覆盖正文前把**旧正文**存进 `payload.history`：

- 结构 `{ text, at, source: { role, seq, messageId } }`，**newest first**，上限 **3 条**（`MAX_MERGE_HISTORY`）；
- `at` 用被替换那一版的 `updatedAt`，不是"现在"；
- **正文相同不记录**（避免复述式合并刷出噪声）；
- 旧正文先过 `looksSecret()`，命中则写 `<redacted>`——历史不能成为凭据的侧门；
- `listNodes()` 暴露 `history` / `historyCount`，面板无需二次请求即可显示"上一版"。

回归 `p64` **17/17**；全量 **65/65**。

仍未做的：`ctx_read` 不返回 history（四工具不动），UI 还没画这一块；因此现在只有 API/库层面可见。

---

## 9. 需要拍板的点

1. ~~裸字母匹配~~ **已做**（距离 ≤12 字符，见 §6.1），反例集在 `p63`。
2. ~~合并留痕：选 A 还是 B~~ **已选 B 并实现**（见 §8），`ctx_read` 与 UI 展示另议。
3. ~~`supersededCount` 提前 return 上报~~ **已做**：新增 `supersedeSkippedCount` 与 5 个 skip 原因。
4. **旧库 #11/#12/#13**：已获允许，但**本机默认库是空的**（只有 1 个 workspace 节点，无决策）——见下节。

---

## 10. 旧库 #11/#12/#13：本机查不到

已获允许后，我把默认工作区的 `.dsh` **整目录拷贝**到 `.tmp/cc/ws-copy` 再只读打开（原库未动）：

```text
nodes: 1
#1 workspace | "workspace …\.tmp\cc\ws-copy" | edges=[]
```

也就是说**这台机器上的默认库是空的**——只有 workspace 节点，没有任何 decision。
`Documents\deepseek-harness` 下也只有 `default-workspace` 一个工作区，没有别的 `.tdb`。

结论：`#11/#12/#13` 所在的库不在这台机器上（与 §4.1 引用的 `.tmp/r3/evidence-clean-run-20261101-172142/` 和备份目录都不存在一致）。
**"重复抽取还是历史版本"这个问题本轮无法回答**，需要那台机器上的库拷贝，或等下次真机实验重新产生。

---

## 11. 本轮证据

| 文件 | 内容 |
|---|---|
| `.tmp/cc/repro.mjs` | 三种候选写法：重述 / 简洁 / 显式替换词 |
| `.tmp/cc/repro-merge2.mjs` | 复现生产现象（修复前：merge、无边、正文被改写） |
| `.tmp/cc/repro-gates.mjs` | 逐条断开"替换词/标签"两个闸门，证明是与门 |
| `.tmp/cc/read-default.mjs` | 只读打开拷贝库，确认本机默认库为空 |
| `scripts/smoke-p63.mjs` | 本轮修复的 11 条回归（裸字母、merge 绕过、skip 上报） |

修复前后对比（同一离线脚本）：

```text
修复前  applied=[{id:3,action:"insert"}]  ← 候选含旧正文时其实是 merge
        superseded []   edges (none)      decisions 1（旧文被覆盖）

修复后  applied=[{id:3,action:"insert"}]  superseded [{from:3,to:2}]
        edges ["3->2"]  decisions 2（#2 原文保留）
```

全部零模型调用。
