# 回交结果

对应 `IMPLEMENTATION_PLAN.md`、`REVIEW_CHECKLIST.md` 与 `ACCEPTANCE_CASES.json`。日期：2026-10-27。

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

1. **真实浏览器交互证据（截图/录像）缺失。** 本轮环境没有运行中的 `dsh web` 宿主，`lib/client.js` 只能在源码层做结构断言（`smoke-p18.mjs`：41 项，覆盖页签存在、按需请求、`role="dialog"`、Escape 关闭、焦点归还、提交中禁用、409 冲突文案、双开关分离）。1440/900/390 宽度、深色主题、真实键盘走查与「替代→撤销→409→刷新」的实际点击链路**未在真实宿主中执行**。这是审查清单「必须提供的证据」里唯一没补齐的一项，需要在一台能起 DSH WebUI 的机器上补做。
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
- 打包消费项目验证：`dist/dsh-trivium-0.5.0.tgz`（34 个文件）装入临时消费目录，用真实 `@deepseek-ai/dsh-llm@0.2.1-rc.3` / `dsh-tools@0.2.1-rc.3` 运行 `scripts/verify-package.mjs`，`status: passed`（版本、原生绑定、宿主模块导入、v4 来源形状、四工具注册、显式期限、仅当前事实检索、多词检索、清空期限）。
  - 说明：`npm install` 在该临时目录报 ERESOLVE，原因是目录里手工铺的 peer 包 `package.json` 版本读不出来（`Found: dsh-llm@undefined`），与本包 peer 范围无关；因此改为把 tarball 内容直接铺进 `node_modules/dsh-trivium` 再验证，等价于安装结果。
- 桌面/窄屏/暗色截图与交互证据：**未提供**，原因见「未完成项」第 1 条。
- console/network 异常：无真实宿主会话，因此没有 console/network 记录可给。
- `ACCEPTANCE_CASES.json` 逐项结果：CTX-01..10、SRC-01..03、TRACE-01..04、REV-01..11、IO-01..03 全部有对应断言并通过（分布在 p16-p20）。UI-01/UI-02 只有源码级断言，缺真实浏览器证据。

## 需要审查者重点检查的地方

1. **轮标识回退路径。** 宿主不给 message id 时，用消息对象身份区分轮次（`turnKeyOf`）。这避免了「按文本判轮」和「按调用计数判轮」两种错误，但依赖宿主在同一个工具循环里复用同一消息对象。这是本轮最需要拿真实宿主日志核对的一处假设。
2. **共享 300 的截断粒度。** 超预算的整条记录被丢弃并记 `over-budget`（`deferred` 里也有一份），不做条目内截断。好处是永远不会有半条记录；代价是长条目可能挤掉几条短条目——贪心继续尝试后面的短记录，但没有做最优装箱。
3. **历史正文保护的边界。** 只保护 `text`。名称、别名、期限、来源仍可改，因为计划把「来源补充等不改变事实的字段」视为可编辑。如果审查认为名称也属于事实，需要收紧到 `name`。
4. **来源 `unavailable` 的判定。** 只有「本进程见过该会话」或「该工作区有对应 episode 节点」才算可达；重启之后老记录会显示 `unavailable`。这是刻意保守的取舍，避免把不确定说成可用。
5. **v2 降级不可原地回退。** 见上；这是格式升级的真实代价，已在 README 写明。
6. **导入不做半提交，但节点与边分两次写。** 结构校验在任何写入之前；节点写入后，替代边用一次事务提交。若这一次事务失败，节点留在库里（它们本身是合法事实）并报告 `revisionConflicts`，不会留下半条链。
