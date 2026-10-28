# 0.5.1 开工计划（执行版）

日期：2026-10-28
依据：`REVIEW-2026-10-28.md`、`FIX_PLAN-2026-10-28.md`、`RESULT.md`、`FIX_HANDOFF_PROMPT.md`、`ACCEPTANCE_CASES.json` 与当前代码。
本文件是「怎么干」的执行排期，不替代 FIX_PLAN 的设计约束；两者冲突时以 FIX_PLAN 的验收断言为准。

## 0. 当前事实基线（已核对）

| 项 | 值 |
|---|---|
| 远端 / 本地 main | `a0ba565`（`git ls-remote` 一致，工作区干净） |
| 插件版本 | `package.json` 0.5.0（源码基线，未升） |
| 内核 | 已升 `triviumdb@0.9.0-beta.3`（精确锁定），`npm test` 21/21 通过 |
| npm `latest` | **0.4.22**（0.5.0 已于 2026-10-27T17:53:09Z 发布，但不在 latest） |
| 已发布 tag | `v0.4.22`→`818306b`，`v0.5.0`→`ac588f6`（不可移动） |
| 0.5.0 状态 | 功能完整，但带 3 个 P1；审查结论「不建议发布」 |

> 注意：`RESULT.md` 中「latest 是 0.5.0」是较早快照；`docs/release-0.5.0.md` 中「尚未发布」已过时。两者都需要在本轮修正，但不能删除历史记录。

## 1. 待办三张清单

### 1.1 待验证 / 待修复的 Bug

| ID | 级别 | 现象 | 位置（评审给出，需复核） | 修复后的验收断言 |
|---|---|---|---|---|
| B1 | P1 | 同轮累计预算不记账：`spent` 恒 0，3 步各 217=651 | `lib/turn-ledger.js` reserve/commit；`lib/context-budget.js` `selectContextRecords()` | 真实规划器产出 3 条长 pin，首步 217、剩余 83，后续不再投递；累计 ≤300 |
| B2 | P1 | 新版本 id 配旧正文：模型看到新 id 却读到被替代的指令 | `lib/context-budget.js` 换 id 分支；`lib/revisions.js` `makeRevisionResolver()` | 自动召回 / 只读预览 / `ctx_find` 都断言「新 id + 新正文 + 新状态」，旧正文只能出现在显式历史读取 |
| B3 | P1 | 导入按正文合并版本节点：两条不同 URI 被并成一个，写出 `supersedes` 自环，事务失败仍 `ok:true` | `lib/store.js` `importGraph()` / `findMergeTarget()`；JSONL 同步路径 | 不同 URI 保持两个节点；映射后整图（含现库）预检；一次事务；失败 `ok:false` 且逻辑快照不变 |
| B4 | P1 附带 | `commit()` 不幂等，重复调用可能重复扣费 | `lib/turn-ledger.js` | 连续两次 `commit()` 只记账一次 |
| B5 | P1 附带 | 显式 `budget=0` 回落成 300 | `lib/context-budget.js` / `lib/turn-ledger.js` | 0 预算返回空计划；非法值按统一策略拒绝 |
| B6 | P2 | 两个在途 pre-step 可能同时消费同一份剩余额度 | `lib/turn-ledger.js` 并发路径 | 并发 reserve 只有一个成功，或重新规划后总额不超 |
| B7 | P2 | compaction 后额度语义含糊（可能免费重置） | `lib/index.js` compaction 钩子 | 同一用户轮 compaction 不突破 300；新用户轮正常重置 |
| B8 | P1（已修） | `remainingOf is not defined` 使真实宿主首轮注入被吞 | `lib/index.js` | 已补 import；`verify-package` 有运行时断言，防回归 |
| B9 | P2（已修） | 409 提示文案重复 | `lib/client.js` | `code=etag` 只显示一句 |
| B10 | P2 | 指纹只含 id+l0，状态变了但正文没变不会重新投递 | 账本指纹 | 状态字段进入指纹；来源备注类编辑不触发重复注入 |
| B11 | P2 | `queueCorrection()` 只在测试里调用，生产写入/归档/替代未接入 | `lib/index.js`、`store` 写路径 | 生产路径产生待投递更正；成功投递才消费；失败保留 |
| B12 | P2 | 失败导入仍更新 sidecar 已同步 hash | `lib/sidecar.js` | 导入失败不更新 hash，不覆盖未应用的输入文件 |
| B13 | P2 | 0.5.0 用户库可能已有自环/错误合并，无检查手段 | 新增只读检查 | 只读诊断自环/循环/分叉/重复 URI，不自动修 |
| B14 | 既有 | issue #3 的期限误判修复需保持 48 项回归全绿 | `scripts/smoke-p15.mjs` | 不改期望值掩盖退化 |

### 1.2 待开发

| ID | 内容 | 依赖 | 规模 |
|---|---|---|---|
| D1 | 共用 `resolveRecallRecord()`：一次读取产出 id/type/l0/until/stale/archived/dirty/path；三种用途（automatic / explicit find / manual pin）分开 | B2 | M |
| D2 | 账本改为按「实际渲染总量」reservation（`totalTokens`），单条 tokens 仅作 UI 派生 | B1/B4/B5 | M |
| D3 | 稳定用户轮标识：宿主 message id / event seq；WeakMap 仅作降级并给出可观测说明 | 需真实宿主日志（S2） | M |
| D4 | `import-plan.js`：URI 身份优先 → 一对一映射 → 整图校验 → 单事务提交（`insertWithId` + `upsertEdge`） | B3、S1 | L |
| D5 | 接通生产更正队列：更新/归档/替代/撤销/成功导入；专用短消息；与 pins/recall 共用 300 | B11 | M |
| D6 | 0.5.0 v2 数据只读检查（自环/循环/分叉/缺失端点/重复 URI/不可解析头） | S5 | S |
| D7 | `verify-package.mjs`：真实 `agent/pre-step` 多步骤累计、同轮去重、新 id/新正文一致 | D1/D2 | M |
| D8 | UI 状态收尾：剩余额度/待下轮生效、当前与历史正文、导入拒绝、事实已提交但旁路待恢复 | D2/D4/D5 | M |
| D9 | 文档纠偏：release-0.5.0、README、issue #3 文案；新增 0.5.1 发布说明 | 全部 | S |

### 1.3 待探索（带退出条件的 Spike）

| ID | 问题 | 退出条件 | 规模 |
|---|---|---|---|
| S1 | 0.9.0-beta.3 的 `insertWithId` 能否安全预分配 id 并与 `upsertEdge` 同事务？ | 在独立库验证：id 范围/安全整数/不碰撞、同事务边引用、失败后重开逻辑快照不变、成功后普通 `insert` 不覆盖、高 id 与空洞不异常。不满足则提交替代方案 | M |
| S2 | 宿主是否稳定提供用户消息 id / event seq？ | 真实宿主多工具循环 + 消息重建两种场景都能认出同一轮；否则给出保守降级并记录 | M |
| S3 | 390 宽是否继续作为验收项？ | 拿到「仅支持桌面」的范围变更，或给出不破坏宿主的全宽详情方案；不得用「无横向滚动」冒充可用 | S |
| S4 | 真实双窗口 409 与键盘走查能否补齐？ | 两个真实窗口产生 409 并恢复；Tab/Escape/焦点归还逐项走通，或明确记为未覆盖 | S |
| S5 | 只读检查能否用 0.9 的 `accessMode: 'readOnly'/'immutable'` 实现，而不触发索引写入？ | 在临时库验证打开后无文件变更；不行则改用导出文件离线解析 | S |
| S6 | 0.5.0 已损坏数据可恢复到什么程度？ | 明确「可从升级前文件组/原始导出恢复」与「已被覆盖的正文不可重建」，写进发布说明 | S |
| S7 | 0.9 beta 作为已发布插件的依赖是否可接受？ | 明确锁精确版本 + 稳定后切 `^0.9.0` 的策略；本轮不暴露 ResourceRuntime/快照等新能力 | S |
| S8 | 性能/负载测试 | 本轮明确不做；只记录固定小 fixture 的正确性断言 | — |

## 2. 里程碑与提交边界

每个 R 单独提交（代码 + 回归 + 结果），前一个 R 的验收不过不进下一个。

### R0 固定失败回归（S）
- 新增 `scripts/smoke-p21.mjs`：三条 P1 用真实规划器/真实账本/真实原生导入复现，**不得手工塞 `record.tokens`**。
- 保留 `review-repro-2026-10-28.mjs` 作证据，不用它的 exit 0 证明修复。
- 交付：修复前红灯输出（651 / 旧正文 / 自环）+ 断言清单。
- 验收：三条测试在当前代码上失败，且失败原因是缺陷本身，不是 fixture 写错。

### R3 导入身份与原子性（L，优先做，数据风险最高）
- 新增 `import-plan.js`；JSON 与 JSONL 只负责解析与各自同步语义。
- URI 优先；不同 URI 不因正文相同/包含而合并；缺 URI 的版本节点必须一对一或报冲突。
- 映射后 + 现库组合成整图再校验（自环/循环/分叉/类型/端点/32 跳/正文保护）。
- 一次 `commitTransaction` 提交事实；失败 `ok:false`，不得 `ok:true + revisionConflicts`。
- 事实成功后再维护文本索引/sidecar，失败要可观察、可重试、重开能恢复。
- 验收：文本包含、完全相同正文不同 URI、拼库成环、事务失败、重复导入幂等、JSON/JSONL 双路径。

### R1 统一版本投影（M）
- `resolveRecallRecord()`；新 id 必须配新正文/状态/path；旧 id 只进 `matchedHistory`。
- 仓库内三处（自动注入、预览、`ctx_find`）共用；人工旧 pin 与 `ctx_read(oldId)` 语义不变。
- 验收：B2 的断言 + 「同时命中新旧只出一条当前事实」+ 期限/归档变化后不输出失效链。

### R2 预算与账本（M）
- reservation 保存本次渲染总量；`commit` 幂等；`rollback` 不扣费；0 预算不回落。
- 并发 reserve / 旧 generation / 旧 turn 不写入新账本。
- compaction：同一用户轮累计 300，只使用剩余额度；地图 400 是一次性预算，不重复追加。
- stable turn id 按 S2 结论落地。
- 验收：217/83、双 commit、并发、compaction、同文本不同事件。

### R4 更正通知与数据检查（M）
- 指纹纳入状态；更正作为专用短消息，不重发旧全文，共用 300，不足留到下一轮并显示待生效。
- 只读检查（S5 结论）；只报告，不自动删边/拆节点。
- 验收：更新/归档/替代/撤销/导入五条路径都能产生并可消费更正；重复事件合并。

### R5 验收与发布候选（M）
- 21 组旧测试 + issue #3 48 项 + p16–p21 全绿。
- 全新消费目录用官方 registry 安装最终 tarball + 真实 DSH peers（不手工铺包、不使用 force/legacy-peer-deps）。
- `verify-package` 覆盖多步骤 pre-step、累计预算、新 id/新正文。
- 真实宿主：多工具循环、双窗口 409、Tab/Escape/焦点（S4）。
- 证据：修复前后同一 fixture 输出、实际注入文本、导入前后逻辑快照与重开结果、截图/日志。

### R6 发布 0.5.1（S）
- 版本号 0.5.0 → 0.5.1；lock 同步；README/CHANGELOG/发布说明/旧数据处理说明。
- `npm pack` → 内容核对 → 干净安装 → `npm publish --dry-run`。
- 实际发布、dist-tag、deprecate、issue #3 回复：**必须单独拿到明确指令后执行**。
- 记录源码 commit 与最终 tarball 校验值；打包后再改源文件必须重新打包验证。

## 3. 顺序与依赖

推荐：**R0 → R3 → R1 → R2 → R4 → R5 → R6**

- R0 是硬门槛：没有红灯就没有修复证据。
- R3 提前：0.5.0 已在公共 registry，导入路径的破坏是「静默损坏数据」，优先级高于展示类问题。
- R1 是 R4 更正消息的前提（更正也要正确投影）。
- 备选：R0 → R1 → R2 → R3（按 FIX_PLAN 默认顺序），代价是危险导入多开放一段时间。

规模汇总：R3 是唯一的 L；R1/R2/R4/R5 为 M；R0/R6 与多数 Spike 为 S。S1/S2 是唯一可能改变设计的外部未知项。

## 4. 三条 P1 的红→绿对照（发布门槛）

| 门槛 | 修复前必须复现 | 修复后必须成立 |
|---|---|---|
| 累计预算 | 3 条长 pin 连续 3 步 = 217+217+217=651，`spent=0` | 首步 217、剩余 83，后续 0 追加；`spent` 单调且 ≤300 |
| 版本投影 | `#2 CookieLegacy` 被 `#3 HeaderCurrent` 替代后，输出新 id + 旧正文 | 新 id + 新正文 + 新状态；旧正文只在历史读取 |
| 导入身份 | 两个 URI 版本被合并，`supersedes` 自环，`ok:true` | 两个节点、一条合法新→旧边；失败无部分写入且 `ok:false` |

## 5. 本轮明确不做

- 不新增产品功能（0.9 的 ResourceRuntime/快照/限时关闭等只作为可选项评估，不接线）。
- 不做性能/负载测试。
- 不重画页面；只改正确性相关的状态提示。
- 不操作真实用户库；全部用临时库与合成数据。
- 不升级到 0.9 稳定版（等其发布后单独评估）。

## 6. 风险与红线

1. **不得弱化测试**：不能把 P1 改成「已知限制」，不能只断言 id 变化或函数有返回值。
2. **不得手工伪造 `record.tokens`** 绕过规划器。
3. **不得移动已发布 tag**（`v0.4.22`、`v0.5.0`），不覆盖已发布版本。
4. **不得把 0.5.0 当可降级目标**：v2 数据对 0.4.22 不是安全往返；降级需恢复升级前文件组。
5. **失败必须保持数据原状**：事实事务失败不得留下半条链或部分节点。
6. **来源/引文不补造**：`unavailable` 就写 `unavailable`，不拼 deep link。
7. **内核 beta**：本轮依赖 `0.9.0-beta.3`；发布说明必须如实写明，稳定后再切 `^0.9.0`。

## 7. 开工前需要确认的决定

1. **内核版本**：实际使用 `0.9.0-beta.3`（2026-10-28 发布，修事务/WAL/索引一致性），而非 `beta.2`；是否接受精确锁定？
2. **窄屏范围**：390 宽是「仅支持桌面」还是继续投入全宽详情方案（S3）？
3. **发布动作**：0.5.1 正式发布后，是否 `npm deprecate dsh-trivium@0.5.0` 指向 0.5.1？0.4.22 保持不 deprecate。
4. **issue #3**：0.5.1 发布验证后再回复并关闭，还是先补一条「0.4.22 已发布」的进展说明？

## 8. 每步工作流

- 分支：`codex/fix-0.5.1-correctness`（从核对后的 main 创建）。
- 提交：R0 红灯 → 每个 R 一个 commit（代码 + 测试 + 结果摘要）。
- 回归：每次提交前 `npm test`（21 组）+ 对应 p21 断言；R5 再加真实宿主与 tarball。
- 证据：修复前后同一 fixture 的输出写进 `docs/next-memory/`，不把旧快照伪装成当前状态。

## 9. 第一轮进展（2026-10-28）

### 已完成

| 项 | 结果 |
|---|---|
| 内核 | `triviumdb@0.9.0-beta.3` 精确锁定；升级前后 21/21 均通过 |
| R0 | 新增 `scripts/smoke-p21.mjs`；修复前红灯准确命中「record 没有 token 成本」与「两个 URI 被并成一个」 |
| R1 | `makeRevisionResolver()` 返回完整当前节点投影（type/l0/until/stale/archived/dirty），自动召回、预览、`ctx_find` 三处共用；人工 pin 与 `ctx_read(oldId)` 语义不变 |
| R2 | `selectContextRecords()` 按前缀边际成本写 `record.tokens` 且求和等于计划总量；`reserve(..., { totalTokens })` 按实际渲染总量记账；`commit()` 幂等；显式 0 预算保持 0；compaction 不再重置同一轮 spend；pre-step 在异步检索后重读账本防并发双花 |
| R3 | `importGraph()` 改为 URI 身份优先 → 预分配 id → 映射后整图校验 → **单个** `commitTransaction`（insertWithId/updatePayload/upsertEdge）；失败返回 `ok:false` 且不留节点、不留正文覆盖、不留边；无 URI 的普通 v1 节点仍走文本回退；版本链上无 URI 的节点明确报 `ambiguous-identity`；JSONL 旁路 `applySidecar()` 同步移除正文回退，只按 URI 识别身份 |
| 回归 | `npm test` **22/22**（含 p21 的 54 条断言）；`insertWithId` 之后的普通插入与重开均正常（S1 的最小验证） |
| 打包级运行时 | `verify-package.mjs` 用真实 peer `dsh-llm/dsh-tools 0.2.1-rc.4` + beta.3 驱动 `agent/pre-step`：注入、同轮去重、**同轮累计 ≤300** 全部通过；内核断言改为跟随 `package.json` 固定值 |
| 真机 | DSH `0.2.1-rc.4` Web（3091）加载本仓库 junction：设置出现「Trivium 记忆」，17 节点库正常列出，只读检查返回 `id=4 / 33 tokens`（修复前该字段恒 0） |

### 真机发现（已处理 UI 文案，读写并发仍未支持）

- 桌面端与 Web 宿主同时打开**同一个工作区**时，后打开的一方在设置页显示原始
  `TDB_ERROR: 数据库已锁定 ... incompatible access mode`，`/api/dsh-trivium/status` 返回 500。
- 已修：API 返回 `409 DB_LOCKED` + 一句可读说明（点名「另一个 DeepSeek Harness 实例」并给出关闭/切工作区两条出路），原始错误只放在 `detail` 里；真机已复验，页面不再出现 `TDB_ERROR`。
- 仍未支持：同一工作区的**多宿主并发写入**。这是内核的单写者契约（排他锁），不是插件能重试解决的；可选方向是 0.9 的 `accessMode: 'readOnly'` 只读查看，或单一宿主代理，均需单独 spike。

### 下一轮（R4/R5/R6）

- R4：`queueCorrection()` 接生产写入/归档/替代/撤销/导入五条路径；指纹纳入状态。
- R5：真实宿主多工具循环、双窗口 409、Tab/Escape 焦点走查；最终 tarball 干净安装。
- R6：版本 0.5.1、`npm pack` + dry-run、发布说明；发布动作等明确指令。

## 10. 第二轮进展（R4 / R5）

- **R4 完成**：账本新增已投递事实表；更新/归档/删除/合并/替代/撤销/导入均会排队更正；指纹纳入状态；更正有独立消息块、投递成功才消费；JSONL 旁路只按 URI 识别；新增只读体检 `lib/integrity.js` + `scripts/check-integrity.mjs`（`accessMode: readOnly`）。
- **R5 完成（除真实双窗口与 390 范围决策）**：`npm pack` 35 文件 → 干净安装 → `verify-package` 13 项通过；真实宿主验证了多工具轮次、更正注入、过期 ETag 409、键盘与 390 宽度。
- 详细数据、截图索引与未覆盖项见 `docs/next-memory/R5-VERIFICATION-2026-10-28.md`。
- 回归：`npm test` 22/22，`smoke-p21` 86 条。
- 剩余：R6 发布工程；真实双窗口与 390 宽范围确认。

## 11. 第三轮进展（0.6.0）

- 0.5.1 已发布（2026-10-28T04:42:43Z，latest），issue #3 已复验并关闭。
- A1：`dsh-trivium-check` / `dsh-trivium-clear-until` 进入 `bin` 与 `files`，包内 37 个文件；干净安装后可执行。
- B1：两个真实标签页完成「A 改 → B 用旧 ETag 得到 409 → 刷新后成功」。
- B2：真实会话日志确认用户消息带稳定 `id`，轮标识不依赖对象身份。
- C2：清理工具默认 dry-run，`--apply` 只清「期限也在正文里」的，`--all` 才清显式期限。
- 回归：`npm test` 23/23，`smoke-p22` 25 条。
- 证据：`docs/next-memory/R7-VERIFICATION-2026-10-28.md`。
