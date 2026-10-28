# 回交结果

> **历史回交与受理记录（0.5.0）**：保留最初完成声明、发现缺陷后的修正与发布时间线。正文里的“当前”“latest 是 0.5.0”、拆分 P1 修复建议及部分成功导入描述均不是现行结论。三个 P1 后续随 0.5.1 修复，当前发布基线为 0.7.0，见 [文档入口](../README.md)。不要用旧完成声明覆盖后续审查。

对应 `IMPLEMENTATION_PLAN.md`、`REVIEW_CHECKLIST.md` 与 `ACCEPTANCE_CASES.json`。日期：2026-10-27。

---

# 评审回执与当前状态（2026-10-28 02:15）

回应 `REVIEW-2026-10-28.md`（针对 `ac588f6`，结论「不建议直接发布 0.5.0」）。

## 1. 结论已受理，两个 P1 我独立复现成立

不是照抄评审结论。我写脚本直接跑规划器与账本，实测如下。

**P1-1 同轮预算不记账 —— 成立**

```
record.tokens = [undefined, undefined]   plan.tokens = 123
commit 后: spent = 0, remaining = 300
```

`selectContextRecords()` 只算块级总量，从不给单条 record 写 `tokens`；`reserve()` 里 `Number(r.tokens) || 0` 全部归零，`spent` 恒为 0。评审指出的「测试夹具手工塞 tokens 掩盖接线缺失」也成立 —— `smoke-p16` 的 CTX-07 正是这么绕过去的。

**P1-2 新 id 配旧正文 —— 成立**

```
record id = 5
record l0 = "CookieLegacy 是旧鉴权方案。"
#5 实际正文 = "HeaderCurrent 是新的唯一鉴权方案。"
```

换 id 的分支只写 `matchedHistory` 和 `record.id`，`l0/until/stale/path` 仍是旧候选；`makeRevisionResolver()` 也根本没把正文带回来。

**P1-3 导入合并成自环 —— 只做代码路径确认，未跑完整复现**

`importGraph()` 预检按导出 id 验结构，落盘却回退到 `findMergeTarget(allowRevisionLinked:true)` 的文本包含匹配；两条 URI 不同、正文为「后一版包含前一版」的版本节点会映射到同一 id，随后直接 `upsertEdge` 成自环（无 `src === dst` 守卫）；事务失败分支仍返回 `ok:true`。评审的复现结论与我读代码的判断一致，但我没有独立跑出那条 `created:1, merged:1` 的记录，这里如实标注。

## 2. 仓库与发布实际发生了什么（含偏离）

| 项 | 状态 |
|---|---|
| `main` | `ac588f6`，已 fast-forward 合并并推送（`b0a5355..ac588f6`），`ls-remote` 交叉验证一致 |
| 本地分支 | 只剩 `main`；`feat/next-memory` 与 `codex/fix-memory-recall-0.4.22` 确认是 main 祖先后已删除 |
| tag | `v0.4.22` → `818306b`、`v0.5.0` → `ac588f6`，均已推送 |
| npm 0.5.0 | **2026-10-27T17:53:09Z 已发布并占 latest** |
| npm 0.4.22 | 2026-10-27T18:09:44Z 发布，给 `^0.4` 线补 issue #3 修复，**不在任何 dist-tag 上** |

**必须记录的偏离：0.5.0 先于 P1 修复上线了。** 这与评审建议相反。过程是：先决定「按评审先发 0.4.22」，但 0.5.0 在 17:53:09Z 已被发布为 latest（我在 17:52:33Z 查过一次，早了 36 秒没看到，随后误判为「没发出去」，属于我的判断错误）。0.4.22 随后发布时误带 `--tag latest`，一度把 latest 压回 0.4.22，已用 `npm dist-tag add dsh-trivium@0.5.0 latest` 修正，复查 `dist-tags: {latest: '0.5.0'}`。

**所以：latest 现在就是带三个 P1 的 0.5.0。** 这是已知风险，不是意外，也不掩饰。

## 3. 修复计划与验收断言

| P1 | 改哪里 | 怎么改 | 验收断言（必须跑真实规划器/真实导入） |
|---|---|---|---|
| 1 | `lib/context-budget.js` `selectContextRecords()` 末尾 | 按前缀边际成本给每条 record 写 `tokens`（`measure(0..i) - measure(0..i-1)`），保证 `Σtokens === plan.tokens`，标题/包装计入 | 3 条长芯片 + 同一轮 3 次 pre-step，累计 ≤ 300；`records.every(r => r.tokens > 0)`；不得手工构造 record |
| 1b | `lib/turn-ledger.js` `commit()` | 补幂等守卫：已 `committed` 直接返回，避免重复扣费 | 连续 `commit()` 两次，`spent` 只加一次 |
| 2 | `lib/revisions.js` `makeRevisionResolver()` + `lib/context-budget.js` 换 id 分支 | resolver 返回投影后的 `{currentId,type,l0,until,stale,dirty,path}`；换 id 后用新值覆盖，旧 id 只留在 `matchedHistory`；path 取不到就清空 | 断言**新正文出现**、旧正文不以新 id 出现；自动召回、只读预览、`ctx_find` 共用同一归一 |
| 3 | `lib/store.js` `importGraph()` | ① URI 身份优先，有 URI 找不到就新建，不走文本合并（文本回退只留给无 URI 的旧导出）② 落盘前校验「映射后 + 现库」完整拓扑 ③ `insertWithId` + `upsertEdge` 放进**一个** `commitTransaction` ④ 失败返回 `ok:false, status:409` | 文本包含、完全相同正文但不同 URI、与现库拼接成环、事务失败四种形态 |

顺序建议：先 1 / 1b / 2（小改，发 0.5.1），再 3（较重，发 0.5.2）。

## 4. 仍未做（与评审一致）

- `queueCorrection()` 仍只在测试里调用，生产写入/归档/替代路径未接入。
- 390 宽在宿主侧栏约束下不可读 —— 已实测（弹窗 342px = 宿主 NAV 188 + 内容 154，插件卡片 101px），`scrollWidth === innerWidth` 但不可用；不接受把「无横向滚动」当窄屏通过。
- 逐个 Tab 键盘走查、真实双窗口并发（409 用客户端注入过期 ETag 制造）仍未覆盖。

## 5. 请评审确认

1. P1-3 是否接受「自己分配 id + 一次 `commitTransaction`（`insertWithId` + `upsertEdge`）」的方案？还是要求导入失败时回滚已写入的节点？
2. 已发布的 0.4.22 是否需要 `npm deprecate` 指向 0.5.0？
3. 仓库里三个评审文件（`REVIEW-2026-10-28.md`、`review-evidence-*.json`、`review-repro-*.mjs`）是否要一并提交？

---

## 基线与提交

- 基线 manifest 校验结果：`BASELINE.json` 55 个文件，55/55 内容一致。其中 4 个文件字节数偏大，差异为纯 CRLF（Windows `core.autocrlf`），按 LF 归一后 sha256 全部吻合：`docs/issue-3-reply.md`、`docs/release-0.4.22.md`、`scripts/smoke-p15.mjs`、`scripts/verify-package.mjs`。没有覆盖 issue #3 的改动，也没有回退到远端 0.4.21。
- 起点：分支 `codex/fix-memory-recall-0.4.22`，HEAD `818306b`（未提交 0.4.22 修复集的检查点提交）。工作分支 `feat/next-memory`。
- 提交（按里程碑拆分）：
  - `5b00235` M0：`plan one context budget per user turn`
  - `0e81a79` M1：`say where a memory came from and why it was recalled`
  - 后续一个提交承载 M2 与文档（见 `git log`）。
- 最终插件版本 **0.5.0** / TriviumDB **0.8.11**（`^0.8.11`，锁文件 0.8.11，未升级到 0.9 beta）。
- 是否修改 package lock、数据格式、默认配置：
  - `package-lock.json` 只改版本号，依赖不变。
  - 数据格式：JSON 图导出 `version` 1 → **2**；Git JSONL `v` 1 → **2**。两者都是**增量**：新增 `supersedes` 边与 `metadata`，旧 v1 文件仍可读（详见「数据兼容与降级」）。
  - 默认配置：**未变**。芯片、自动召回、会话层、Git 旁路、embedding 默认仍为关闭。

## 完成范围

### M0 预算与去重（`5b00235`）

- 新增 `lib/context-budget.js`：`selectContextRecords()` / `renderContextRecords()` 纯函数。先取结构化候选，再统一排除归档/脏数据/失效/已替代，然后合并、去重、分配预算，最后渲染。**不再从 `buildPinInject()` 截断后的字符串反解析节点。**
- 新增 `lib/turn-ledger.js`：每轮账本。轮标识只来自宿主用户消息的 id（`id`/`messageId`/`seq`/`source.*`），没有 id 时按消息对象身份区分，**不用 `Date.now()`、查询文本或 pre-step 自增计数**。`reserve → 组装 → commit`，失败 `rollback`，只记录成功交付的条目与内容指纹。
- 芯片与召回共用 300：芯片优先，召回只用剩余额度；同一节点跨渠道只出现一次（保留渠道记录供 UI 解释）；地图已包含的同一正文不再重复注入（地图只有标签时允许后续补摘要）。
- `lib/pins.js` 改为提供 `pinCandidates()` 结构化候选，300 token 的独立截断路径删除；`buildPinInject()` 变成薄封装，保留原标签与返回值形状。
- `lib/index.js`：pre-step 接统一规划器；compaction 后清账本与地图（可重建）；fork 用不同 session id，天然不继承。
- `lib/tool-output.js` + `lib/tool-defs.js`：`ctx_find` 默认上限 1200 估算 token，超预算**丢弃整条记录并给出截断提示**，不切半条 JSON、不截 id；`ctx_read` 改为白名单投影 payload，新增来源/版本字段不会撑大默认输出；四工具定义冻结为纯数据，schema 估算仍为 **529**（等于基线）。
- `scripts/smoke-p16.mjs`：CTX-01..CTX-10，55 项检查。

### M1 来源与召回解释（`0e81a79`）

- 新增 `lib/provenance.js`：`payload.source` 投影，可选字段 `kind`（manual/extract/chip/import/tool）、`sessionId`、`messageId`/`eventSeq`、`quote`、`capturedAt`、`importPath`；沿用旧 `via` 并映射到 `kind`。三种状态：`missing`（未记录）、`recorded`、`unavailable`（会话无法确认）。**不补造会话、作者或引文**；引文限 240 字符并去控制字符与 bidi 覆写。宿主没有会话定位接口，因此 `jump` 恒为 `false` 并解释原因，不拼 deep link。
- 新增 `lib/recall-trace.js`：内存诊断。每工作区+会话最多 20 条、10 分钟 TTL、单条 ≤64KiB、每阶段最多 100 条节点摘要并标 `truncated`。跨 workspace/session 查同一 traceId 返回 404，过期返回 410。
- `lib/store.js`：`searchNodes()` / `namedRecallHits()` 增加 `onStage` 观测点，只上报**实际产生候选**的分支（native-hybrid / keyword-fallback / entity-anchor / business-expand / same-as-normalize / deadline-scan）。不编造 BM25/向量贡献百分比，也不把融合分数叫置信度。
- 新增 `lib/recall-preview.js` 与路由 `GET /nodes/:id/detail|provenance|history`、`GET /recall-traces[/:id]`、`POST /recall-preview`。预览只走本地文本/图通道：不写库、不跑工具、不请求 embedding，`semantic` 恒为 `not_run`，query 上限 500 字符。
- `lib/extract.js`：写入 `kind` 与 `capturedAt`，与旧 `via` 并存。
- `lib/client.js`：记忆条目 / 召回检查两个页签；详情内 内容 / 来源 / 决策历史 三个页签；预算条按估算 token 显示；展示「将发送给模型的文本」；来源与历史**只在点开对应页签时才请求**。
- `scripts/smoke-p17.mjs`（51 项）、`scripts/smoke-p18.mjs`（UI 契约）。

### M2 人工确认的替代关系

- 新边 `new --supersedes--> old`，放在独立 `REVISION_EDGES`，**没有**进入 `BUSINESS_EDGES` 默认扩展白名单（否则每次召回都会把整条历史带回来）。
- 新增 `lib/revision-graph.js`：纯结构校验（自环、循环、分叉、跨库/缺失节点、非 decision、归档端点、32 跳）。导入可以先用它整体预检，再决定是否落盘。
- `lib/revisions.js`：`supersede()` / `revokeSupersession()`，由 `withWorkspaceQueue()` 串行化「读取 → 校验 → 原生事务」。校验在队列内重新读图；ETag 失配返回 409；`operationId` 记在边 metadata 上，重试幂等；提交成功但响应丢失时靠重读关系识别已应用。事务失败两端保持原状。
- 撤销只删指定 `supersedes` 边（`unlinkLabel`），其它边保留；后继已有更新版本时拒绝，避免拆错链。
- 历史正文保护：`updateNode` 正文变更、`mergeInto` 正文覆盖、`deleteNode`、`mergeNodes` 都拒绝链上节点（`REVISION_PROTECTED` / `REVISION_LINKED`）；`findMergeTarget()` 默认跳过链上节点，自动抽取会新建决策而不是悄悄改历史。非事实字段（名称、别名、期限、来源补充）仍可编辑。
- 旧版本归一：自动召回把旧版本命中映射到当前头并去重，带一条 `matched_history=#17 → current=#42` 短指针；`ctx_read(id)` 仍可读旧正文。人工 pin 的旧节点**不改写**，标为历史并显示「可改为当前版本」，提示计入同一 300 预算。
- 后继归档或到期时不复活旧决策，自动召回直接不输出该链，UI 仍可查看历史与状态。
- `lib/store.js` 列表：默认只显示当前头，`includeSuperseded`（HTTP `superseded=1`）与 `includeStale`（`stale=1`）是两个独立开关，UI 也是两个独立勾选。
- `scripts/smoke-p19.mjs`（76 项）、`scripts/smoke-p20.mjs`（45 项）。

### 未完成项与原因

1. ~~真实浏览器交互证据缺失~~ → **已补齐**，见下节「真实宿主证据」。1440/900/390 宽度、深色主题、「替代 → 409 → 刷新 → 成功 → 撤销」的实际点击链路都在运行的 DeepSeek Harness（`dsh@0.2.1-rc.4`）上跑过。仍未覆盖的只有真实**双窗口**并发（409 是在客户端边界注入过期 ETag 制造的）和逐个 Tab 的键盘走查——Escape 关闭与焦点归还目前只有源码级断言。
2. **`withWorkspaceQueue` 是进程内队列。** 单进程足够（DSH 插件本来就跑在宿主进程里）；多进程同时写同一个 `.tdb` 不在本轮范围，也没有声称支持。
3. **Git 旁路删除链关系不自动生效。** 文件里缺少一条本地已有的替代关系时，按计划「先报告冲突」，不静默撤销；要撤销必须在 UI 里显式操作。这是有意取舍，已写进 README。
4. **没有完整的不可变操作审计日志。** 只有边 metadata 上的 `reason` / `at` / `operationId`，撤销即丢失。计划明确首版不承诺审计日志。
5. **性能基准未做。** 计划明确本轮不做速度/负载测试；预算断言是固定小 fixture 的正确性测试。

## 上下文证据

估算工具：`lib/tokens.js` 的 `estimateTokens()`（CJK ≈ 1，ASCII ≈ 1/4），**不是模型 tokenizer，也不是计费口径**。脚本：`node scripts/smoke-p16.mjs`。

| fixture | 输入 | 输出 | 估算 token | 去重 / 未入选原因 |
|---|---|---|---|---|
| 默认关闭 | 芯片 + 自动召回都关 | 只有会话地图 | 地图 ≤400 | 两个通道都在规划前返回，不产生附加文本 |
| 双通道开启 | pins=[A,B]，recall=[A,C]，A/B 各约 100 token | pins 块 A、B；recall 块为空 | 224 / 300 | A 只出现一次（`duplicate-node`）；C `over-budget` |
| 同轮第二步 | 同上，第二次 pre-step | 无新增 | 0 | 账本已记录指纹，全部 `duplicate-in-turn` |
| 同文本新用户轮 | 两条相同文本、message id 不同 | 重新选中 | 224 / 300 | turnKey 不同，不按文本跳过 |
| compaction | 注入后压缩 | 下一轮可重建 | 224 / 300 | `clearAfterCompaction` 清账本与地图；在途 reservation 因 generation 变化无法提交 |
| fork | 子会话 | 无注入 | 0 | session id 不同，账本与 pins 都不继承 |
| 旧版本命中 | recall 命中 A，A 已被 B 替代 | 只出现 B | 由 300 共享 | `matched_history=#A → current=#B`；A 不重复出现 |
| 旧 pin 被替代 | 用户钉了 A | A 标历史 + `superseded->#B` | 与召回同池 | pin 不被改写；召回侧映射到 B |

投递账本何时标记成功：`reserve()` 只建声明，消息组装成功后 `commit()` 才写入已交付指纹与已用额度；组装或返回路径抛错则 `rollback()`，未写入任何指纹，下一次 pre-step 会重新选中同一内容（`smoke-p16` 用「失败 → 不标记 → 重试仍有内容 → 成功后不重复」四步证明）。宿主没有注入成功回调，所以 commit 与 enter 返回在同一受控路径内、commit 是返回前最后一个动作。

来源/版本字段如何避免进入工具默认输出：`ctx_read` 只输出 `CTX_READ_PAYLOAD_KEYS` 白名单里的旧字段，`source` 只保留 `{ sessionId }`（0.4.22 就有的形状）。给同一 payload 塞入 4000 字 `source.quote`、`revision`、`history` 后，默认输出除 `updatedAt` 外逐字节不变（`CTX-08`）。

## 版本关系与数据证据

脚本：`node scripts/smoke-p19.mjs`、`node scripts/smoke-p20.mjs`。

- 替代成功：一条 `B --supersedes--> A`；A 正文与 `until` 未被改写、未归档；`revisionStateOf(A).currentId === B`。
- 撤销：只删 `B→A` 的 `supersedes`，同一对节点间的 `about` 边保留；A、B 重新独立。
- 循环拒绝：`B→A` 之后再试 `A→B` 返回 `code: cycle`，不写半条关系。
- 分叉拒绝：A 已有后继再连第二个返回 `already-superseded`；后继自己已有前驱返回 `successor-has-predecessor`。
- 32 跳：34 节点线性链可解析到头部；再接一条超过上限返回 `too-long`，且不给出不完整的当前版本。
- 并发 409：两个窗口带同一旧 ETag，第二个返回 409 且原关系不变。
- 事务失败：注入 `commitTransaction` 抛错后，两端 `successorOf`/`predecessorOf` 都为空，返回 `transaction-failed`。
- 响应丢失重试：同一 `operationId` 重试返回 `alreadyApplied: true`，`supersedesIn(A).length` 仍为 1。不同 `operationId` 但同一对节点同样识别为已应用，不产生平行边。
- 链上节点编辑：正文变更 → `REVISION_PROTECTED`；名称变更 → 允许；自动抽取的 `findMergeTarget()` 返回 `null`；`mergeInto()` 正文覆盖 → `REVISION_PROTECTED`。
- 链上节点删除/合并：`deleteNode` → `REVISION_LINKED`；`mergeNodes` → `status: 409, code: REVISION_LINKED`；HTTP 分别是 409。
- JSON v2：导出带 `version: 2` 与边 `metadata.reason`；导入到全新库后按 URI 重映射、方向与 metadata 均保留；无非 URI 的旧节点仍走文本回退。
- JSONL v2：头部 `v:2`，含 `"type":"supersedes"` 与 `"meta"`；节点行不含 `source`（本地来源与引文不进可提交文件）；v1 文件仍可解析，边没有 metadata。
- 冲突导入：循环/分叉/非 decision/缺节点在**写入前**被 `validateRevisionStructure` 拦下；链上正文覆盖返回 409 并指明 `chain-body`；被拒后节点数不变、没有半条记录；文件缺少本地已有关系时只报告、不删除。

0.8.11 的事务与文本索引边界：`commitTransaction()` 的 `upsertEdge`（含 `metadata`）与 `updatePayload` 在同一原生事务里；**文本索引与 JSONL 文件不在同一事务**。图是权威，事务成功后由 `persistAfterRevision()` 触发 flush 与旁路调度；旁路失败通过 `GET /status` 的 `derived.sidecar` 暴露，重新打开工作区时 `syncSidecarOnOpen()` 修复。不宣称跨文本、事实文件完全原子。

新增字段/边与格式版本：

- payload 新增可选 `source.kind` / `capturedAt`；旧字段不变。
- 边新增 `supersedes`（权重 0.8），metadata 为 `{reason, at, operationId}`。
- JSON 图 `version: 2`；JSONL `v: 2`。

降级方式：v2 文件对旧 0.4.22 不是安全往返——旧版本会忽略 `supersedes` 边与 metadata，写回时把它们丢掉。要降级必须恢复升级前备份的文件组（`.dsh/trivium.tdb` + `.dsh/trivium.jsonl`），而不是让旧版重写一遍。

## 测试与界面

- 基线回归日志：`node scripts/run-all.mjs` → **21/21 通过**（16 组基线 + p16-p20）。`smoke-p15` 的 48 项 issue #3 检查仍全过，没有改期望值掩盖退化。
- 新增正确性测试日志：p16 55 项、p17 51 项、p18 41 项、p19 76 项、p20 45 项。
- 打包消费项目验证：`dist/dsh-trivium-0.5.0.tgz`（34 个文件）装入临时消费目录，用真实 `@deepseek-ai/dsh-llm@0.2.1-rc.3` / `dsh-tools@0.2.1-rc.3` 运行 `scripts/verify-package.mjs`，`status: passed`（版本、原生绑定、宿主模块导入、v4 来源形状、四工具注册、显式期限、仅当前事实检索、多词检索、清空期限、**运行时 pre-step 注入**、**同轮去重**）。
  - 说明：`npm install` 在该临时目录报 ERESOLVE，原因是目录里手工铺的 peer 包 `package.json` 版本读不出来（`Found: dsh-llm@undefined`），与本包 peer 范围无关；因此改为把 tarball 内容直接铺进 `node_modules/dsh-trivium` 再验证，等价于安装结果。
- 桌面/窄屏/暗色截图与交互证据：**已提供**，`docs/next-memory/evidence/`（16 张截图 + `run.json` / `run-conflict.json` 逐步日志 + `README.md` 逐图说明）。宿主为 `@deepseek-ai/dsh@0.2.1-rc.4`，插件是本仓库 0.5.0 源码 junction，模型 DeepSeek-V4.1-Flash 真实调用。
  - 900 宽：宿主设置弹窗仍是 800px（NAV 188 + 内容 612），插件卡片 559px，与 1440 完全一致，可用。
  - 390 宽：**无横向溢出**（`scrollWidth === innerWidth`，实测数据见 `evidence/measure-narrow.json`），但宿主设置弹窗保留固定 188px 侧栏，内容列只剩 154px、插件卡片 101px，中文被压成一字一行。插件自身的布局已经会收缩（两个页签换行堆叠、两列栅格退成单列），但物理宽度不足，靠插件 CSS 无法解决。**这一条记为已知边界：900 以上的窄桌面可用，390 只证明不产生横向滚动，不证明可用。**
  - 深色主题：`16-dark-1440.png`。
  - 真实注入：`13-trajectory-injection.png` 的轨迹里能看到 `dsh-trivium autoRecall (L0 only; ...)` 与 `dsh-trivium memory map (...)` 两条插件上下文，模型随后用 `ctx_read` 读了这两条 id。
- console/network 异常：插件 API 全程 200/400/404/409，没有 500；未捕获浏览器端异常。这是「目视 + 逐步返回值」级别的证据，不是完整 console 录制。
- `ACCEPTANCE_CASES.json` 逐项结果：CTX-01..10、SRC-01..03、TRACE-01..04、REV-01..11、IO-01..03 全部有对应断言并通过（分布在 p16-p20）。UI-01 的点击链路已在真实宿主走通（替代 → 409 → 刷新重试 → 成功 → 撤销，截图 04-09）；UI-02 的宽度与深色有截图（1440/900 可用；390 无横向溢出但受宿主侧栏限制不可读，见证据说明），键盘走查只有源码级断言。

## 真实宿主证据

真机跑一轮暴露了两个离线套件抓不到的问题，都已修复。

1. **`remainingOf is not defined`**。`lib/index.js` 的 pre-step 用了 `remainingOf` 却没有 import；`agent/pre-step` 在第一个真实轮次就抛错并被兜底 catch 吞掉，症状是「芯片/召回打开了却什么都不注入」。离线套件只对源码做正则断言，识别不出未定义标识符；`smoke-p16` 直接测账本模块，也绕过了 `index.js`。
   - 修复：补 import。
   - 防回归：`scripts/verify-package.mjs` 新增**运行时** pre-step 检查——用真实 peer 构造 coordinator，驱动一次 `agent/pre-step`，断言注入块存在、含 `dsh-trivium autoRecall`、每块 ≤300 估算 token，且同一轮第二次 pre-step 不重复注入。检查清单里已加入 `runtime pre-step injection` 与 `same-turn de-duplication`。
2. **409 提示文案重复**。冲突横幅把「内容已在别处变更（409）…」和同义的服务端句子拼了两遍。现在 `code` 为 `etag` 时只显示前者，其它 409 原因（循环、线性链限制）仍带服务端说明。

另外确认了两件之前只有推断的事：

- **映射到真实宿主**：`GET /api/dsh-trivium/status` 在 `dsh@0.2.1-rc.4` 下返回 `version: "0.5.0"`、`turnTokenBudget: 300`、`derived.sidecar`、`preStep`，说明 M0/M2 新增字段在真实宿主里可用。
- **注入真的进模型**：轨迹视图（`13-trajectory-injection.png`）同时显示 `dsh-trivium autoRecall` 与 `dsh-trivium memory map` 两条上下文消息，随后模型对注入的节点连续调用 `ctx_read`，并在回答里引用了它们的正文。`ctx_read` 的输出只有 id 与 payload 白名单字段，没有 `source`、`revision` 等元数据。

证据与逐图说明：`docs/next-memory/evidence/README.md`。


## 需要审查者重点检查的地方

1. **轮标识回退路径。** 宿主不给 message id 时，用消息对象身份区分轮次（`turnKeyOf`）。这避免了「按文本判轮」和「按调用计数判轮」两种错误，但依赖宿主在同一个工具循环里复用同一消息对象。这是本轮最需要拿真实宿主日志核对的一处假设。
2. **共享 300 的截断粒度。** 超预算的整条记录被丢弃并记 `over-budget`（`deferred` 里也有一份），不做条目内截断。好处是永远不会有半条记录；代价是长条目可能挤掉几条短条目——贪心继续尝试后面的短记录，但没有做最优装箱。
3. **历史正文保护的边界。** 只保护 `text`。名称、别名、期限、来源仍可改，因为计划把「来源补充等不改变事实的字段」视为可编辑。如果审查认为名称也属于事实，需要收紧到 `name`。
4. **来源 `unavailable` 的判定。** 只有「本进程见过该会话」或「该工作区有对应 episode 节点」才算可达；重启之后老记录会显示 `unavailable`。这是刻意保守的取舍，避免把不确定说成可用。
5. **v2 降级不可原地回退。** 见上；这是格式升级的真实代价，已在 README 写明。
6. **导入不做半提交，但节点与边分两次写。** 结构校验在任何写入之前；节点写入后，替代边用一次事务提交。若这一次事务失败，节点留在库里（它们本身是合法事实）并报告 `revisionConflicts`，不会留下半条链。
