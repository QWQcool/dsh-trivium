# 实体范围只读后端：协议与验收

2026-11-12。基线 main@513745c，TDB 0.9.0。验收题目与本协议先在 `11fbe0c` 固定，再实现后端。本轮未 bump 或发布；ctx_find、自动召回、默认排序和 UI 保持原状。接口已实现并在隔离宿主验证，未部署到用户常用宿主。

独立入口为 `POST /api/dsh-trivium/entity-search?cwd=...`。工作区与 entityId 显式指定；仅借用已打开的宿主句柄，或读取显式捕获的固定快照。语义通道默认关闭，只有请求 semantic=true 且宿主 embedding 已配置时才调用。词面与语义候选分别返回，不提供融合总排名或答案置信度。

范围固定为双向业务一跳（about/decided/broke/fixed）加实体自身。当前、归档、期限和坏链沿用既有规则；当前版本没有范围内路径时仅报告关联缺口。embedding 等待期间不持写锁，返回后重校验句柄、范围、路径及相关正文；变化时返回可重试冲突，不自动扩大或重试。live 使用查询校验时刻，snapshot 使用捕获时间判断期限。

整个请求共用节点、边、读取字节、CPU 和响应预算；网络等待有独立可取消期限且受请求总期限约束。接口失败、超时、向量无效或配置关闭可退为同范围词面结果；取消、范围变化、坏链及工作预算失败不伪装成空结果。快照解析与向量评分放在可终止子进程，provider 凭据保留在宿主。

验收数据在实现前固定：[新语料](../../scripts/fixtures/entity-search-acceptance.json)，含 24 道有答案问题与 4 道无答案/无关系问题，正文和题目独立于旧 32 题。采用新服务领域、跨语言、精确标识符、数值/否定、共享事实和同题不同实体。标签为预先定义的合成真值，不宣称独立第三方人工评审。评分规则不根据这些结果调整。

工程验收覆盖边界、版本、错库、等待期间增删改边/正文/关闭重开、配置切换、取消、降级、预算与快照代际。至少执行离线契约 smoke、新题真实本地向量验收、全量回归、接口实机核对及脱敏检查。没有新增 UI 测试，scripts 保持文件上限。

## 实现与协议

- `entity-search.js`：校验固定输入、构造双向一跳集合、复用有界当前版本检查与已有词面评分。语义排名使用原生 `searchGraphFirst`，没有全库 Top-K 后求交或新融合权重。
- 预读与终读共用 1000 个不同 ID、10000 次边/探测、512 KiB payload JSON 和 150ms 执行窗口。work.cpuMs 按扣除 provider 等待的墙钟计时，不是操作系统 CPU 用量。HTTP 期限从处理器准入起为 15s，不包括宿主开始处理前的排队；provider 等待留出终读时间，响应体限制 64 KiB。请求/响应沿用 16 KiB / 512 KiB 上限。
- 等待期间不持写锁；终读与预读的相关 payload、合法路径及版本状态不同即 409，不返回旧候选或自动重试。句柄对象变化、embedding 配置变化也分别拒绝。live 期限按终读时刻，snapshot 按捕获时刻。
- `entity-search-snapshot.js` 与 worker：校验固定快照，在独立进程评分；宿主只接收一次 query embedding 请求。总超时/取消会终止 worker、取消 provider，等待实际退出才释放名额。worker 协议不传 provider 配置/密钥，常见凭据环境变量剔除。
- 结果包括两路候选、各自截断、真实路径、工作量、scope 摘要、降级及关联缺口。`answerability:not_assessed`；分数不当置信度，返回近邻不等于找到答案。默认调用不请求 embedding。

详细字段与错误码见[只读接口说明](../read-api.md#explicit-entity-search-unreleased-source)。现有固定查询仍不请求 embedding，本入口没有进入工具 schema 或自动召回。

## 固定新题验收

语料为 BuildRunner、ArtifactStore、AlertRouter、ReportAPI 和一个未使用服务，含 21 条事实、历史/归档/过期与未关联干扰节点，共 31 节点（含工作区根）。问题 SHA-256 按 UTF-8 LF 规范化为 `37199c8c2cd991a591e559011d0f8e9ed5e1e9381e03442f532f4d831fdcebfb`，与实现前提交一致。未改问题/标签或根据结果调整评分。

通过实际 `registerMemoryApi` HTTP 传输、宿主 writer 句柄和真实 immutable worker 执行每题。模型为已下载的 GTE-Qwen2-1.5B 同权重本地运行器，1536 维、query-only 指令；未调用生成模型。

| 24 道有答案题 | live Top-1 / Top-5 | snapshot Top-1 / Top-5 |
|---|---|---|
| 词面候选 | 5/24 · 5/24 | 5/24 · 5/24 |
| 语义候选 | 24/24 · 24/24 | 24/24 · 24/24 |

任一路命中的覆盖为 24/24，**这是两份候选列表的联合覆盖，不是融合 Top-5**。每路最多 5 条。新领域及固定问题独立于旧 32 题，但仍为小型合成集合、范围仅数条事实，不能据此宣称真实会话或大库准确率 100%。

3 道无答案问题都得到语义近邻，词面未命中，全部保留 `answerability:not_assessed`，没有生成或确认答案。只有元数据的未关联实体返回 `scope_anchor_only` 并跳过模型调用。同题在两个实体中分别找到 1 次与 3 次重试事实；共享审计事实、旧版本归一化及未关联同标识符干扰的排除均通过。

实际 provider HTTP 共 **79 次**：25 次构造事实向量，54 次 API 问题向量；报告输入 token 2116，非法向量 0，费用 **¥0**。真实 DSH 额外核对 2 次本地问题向量，费用仍 0。模型与宿主停止后，用缓存重放 54 次 provider 响应，模型 HTTP 0。

## 正确性、并发、降级与预算

`node scripts/smoke-p93.mjs` 中增加一个合并后端检查块，**35/35** 场景通过，覆盖：

- 当前事实、历史头、提案保留、被删除/复用 ID、元数据边排除和真实路径；范围内关联缺口不带入范围外正文。
- provider 等待期间改正文、增加/删除业务边、到期变化、关闭重开，以及其它工作区成为 activeCwd。相关变化拒绝，范围外无关变化保留查询。
- 配置切换、调用取消、真实本地 HTTP provider 断连/失败、非法维度/非有限值/零向量/f32 不可表示值、超大 provider 响应和超时。正常降级仍只返回原范围词面数据。
- 节点/边/payload/CPU/响应预算、1200 节点小范围、断开后的准入释放；预算失败与空候选不混同。
- 快照固定代际与捕获时间、live 写后再捕获不污染已选快照、损坏制品在 provider 前失败、parent 截止时间、取消后 worker 退出、跨 pipe 分块 UTF-8 完整性。
- 真实 HTTP schema、显式工作区、未知工作区不打开、origin fence、默认不调用模型。只读数据文件（排除 OS 锁）字节哈希一致。

新题真实向量及离线验收各 **257/257** 协议/边界检查通过。live 与 snapshot 同数据的候选 ID 列表逐题一致，数据库及快照文件哈希未变化。

额外在隔离的真实 DSH **0.2.2-rc.1** 中只使用 HTTP、未操作 UI：默认、live semantic、snapshot semantic 三次请求均 200。默认 embeddingCalls=0；两条语义请求的首选均为刷新规则 id=231，两路来源和答案状态正确。既有用户 memory.db mtime 保持不变，隔离凭据清除，试验宿主/模型运行器均已停止。

## 验证命令与交付状态

```powershell
node scripts/smoke-p93.mjs
node scripts/run-all.mjs
node scripts/verify-local-embedding.mjs --entity-search-acceptance --output .tmp/entity-live --budget 0 --nodes 0
node scripts/verify-local-embedding.mjs --entity-search-acceptance --query-cache .tmp/entity-live/query-cache.json --offline --output .tmp/entity-replay --budget 0 --nodes 0
npm pack --dry-run --json
```

全量回归 **85/85**；p93 同时保留原只读/TQL/CLI/快照检查。scripts 为 **120 个 .mjs**，没有新 smoke 文件、没有扩充冻结 UI 用例。`npm pack --dry-run` 为 **60 文件**，新 worker 在包中；本地版本保持 0.8.9，未生成新发行或发布。

`lib/tools.js`、`lib/index.js`、`lib/tool-defs.js`、`lib/client.js` 及默认 searchNodes 排序函数保持不变。store 仅增加复用词面评分的准备函数；embedding 适配器仅增加可选取消/期限/响应字节参数，旧调用保持原默认值。接口是显式新增入口，没有生产自动调用者。

[证据目录](evidence-entity-search-backend-2026-11-12/)含逐题候选、合同场景、真实宿主 HTTP 回执、输入与源码摘要；不提交数据库、缓存、profile 或凭据。已实现、已隔离验收、已部署分开记录；本轮未部署至用户常用宿主或 npm。

## 剩余边界

**F-EMB-04 仍开放**：本轮提供两路候选，没有选择融合排序、校准答案置信度或修复全局混合排序。无答案近邻仍需后续产品处理，不能自动据此回答或注入。

存量向量的模型兼容性与覆盖率仍需既有回填流程保证；同维度不等于同向量空间，本接口不自动证明这一点。范围只覆盖已记录的一跳关系，缺边可能漏事实。scope.complete 只表示该范围完整读取，关联缺口会给出警告。

live 的同步 native 阶段与 JS 评分为合作式超时，不能承诺硬实时中断；snapshot 可由父进程按墙钟期限终止，响应时机仍受宿主事件循环调度影响。新独立问题集不是第三方/真实用户盲测，后续真实使用反馈仍不可省略。UI、模型工具参数、自动召回与默认排序接入需另行讨论，不因本次验收自动开启。
