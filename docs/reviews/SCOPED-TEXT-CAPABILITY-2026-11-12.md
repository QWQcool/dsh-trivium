# TDB 候选 ID 文本能力与范围内 payload 评测

2026-11-12，生产基线 `b55369b`，Node 24.15.0、npm 11.12.1、TDB 0.9.0，原生二进制 SHA-256 与上一轮一致。本轮只修改开发评测脚本、夹具与文档。**ctx_find、自动召回、默认排序、UI、内核、预算、版本和发布渠道均未修改，未发包。**

## 原生能力结论：通用 ID 集合不支持，payload 条件有条件支持

不能概括成“TDB 完全不能先过滤文本”。实际安装包的 Node/Console/TQL 公开入口支持按现有 payload 字段过滤，稀疏候选会在排序、截断前经过该过滤；但没有接受任意实际 NodeId 集合的文本排名接口。

在三个隔离库中，候选集合固定为 `[10]`，节点 10 的文本相关度较低，范围外节点 20 的相关度更高。节点 10 的 `payload.id=999`，节点 20 的 `payload.id=10`，用于区分物理节点 ID 与 JSON 字段。

| 入口 / 对照 | 实测 |
|---|---|
| 全库文本 Top-1 | 返回节点 20 |
| `searchHybrid` 的 `payloadFilter.id in [10]` | 返回节点 **20**；过滤的是 JSON 字段，不是 NodeId |
| 已有 `fixtureScope=inside` payload 条件 | 返回节点 10；证明字段过滤发生在 Top-K 截断前 |
| 候选节点 URI 唯一、齐全 | URI 白名单返回节点 10，可作为有前提的映射 |
| 范围外节点与候选节点 URI 重复 | URI 白名单返回节点 **20**，不能等价于 ID 白名单 |
| 候选节点无 URI | URI 白名单返回空，不能解释为该范围没有文本结果 |
| TQL：`TEXT TOP 1` 后按 `hit.id == 10` 过滤 | 返回空；把全库 TOP 扩到 3 才能找回节点 10 |
| TQL：先 `FIND` 建 seed，再进入 `TEXT` | 当前安装包返回 `TDB_QUERY_PARSE`，不是可用的候选集输入 |
| `searchGraphFirst` 对实际 ID 集合 `[21]` | 返回 21；同向量的全库搜索返回 10。它的 ID 约束适用于向量通道 |

源码核对：`TextSearchClause` 没有候选集合字段；`TextSearchSource.apply` 不消费输入 NodeSet，直接从全局文本索引取分数。Node `searchHybrid` 只提供 payload filter；核心稀疏流程在排序前执行该 filter，但 BM25 统计和 posting 查询仍属于全局索引。[TQL 文本源](https://github.com/YoKONCy/TriviumDB/blob/v0.9.0/src/query/pipeline.rs#L803) · [原生稀疏过滤位置](https://github.com/YoKONCy/TriviumDB/blob/v0.9.0/src/database/pipeline.rs#L509) · [Node 接口](https://github.com/YoKONCy/TriviumDB/blob/v0.9.0/src/bindings/nodejs.rs#L2405)

因此：若数据库已有可验证的非空唯一 URI，未来可以单独评估原生 payload-filter 路径；本轮不向真实节点补字段、写分组标记或建索引来制造这个前提。现有节点创建接口没有统一强制该约束，任意 ID 集合的方案仍需 fallback。

补充的 1200 节点对照成功执行 TEXT 并返回唯一相关节点。这也修正了实验中一个被实际结果否定的假设：Console `maxOperations=1000` **不是 TEXT 输入节点数上限**。该值还参与查询行数与批次操作限制；源码默认 PipelineBudget.max_nodes 为 100000。不能从一个小范围结果推断执行只访问了该范围，也不能将不同预算字段混同。本轮没有调整这些默认值。[Console 约束](https://github.com/YoKONCy/TriviumDB/blob/v0.9.0/src/database/console.rs) · [PipelineBudget](https://github.com/YoKONCy/TriviumDB/blob/v0.9.0/src/query/pipeline.rs#L393)

## 带关系真值的 fallback 实验

复用原 36 条合成记忆正文，加入实体、未关联干扰、归档/过期/历史/提案节点，共 **52 节点、8 个实体、83 条声明关系**。[关系与答案标签](../../scripts/fixtures/scoped-text-relations.json)预先列出边、每个实体的完整一跳集合和可用事实集合，不由模型推断。它是开发诊断夹具，不是独立人工审查的真实用户留出集。

范围只沿双向 1 跳 `about / decided / broke / fixed` 构建，随后应用现有期限与当前版本规则。共享的预算事实可同时属于两个实体；一个广义实体关联原 36 条全部记忆，保留同实体内部的通用词干扰。另有：

- 同一句“How many retries are allowed?”分别选择 UploadWorker 与 MailSender，正确事实分别为 3 次与 5 次。
- 高度匹配 X-Request-Id 的未关联干扰节点，以及只由 in_workspace / from_session 连接的节点。
- 归档与过期条目、同范围内的新旧决定、当前版本缺少关联边的缺口、尚未确认的替代提案。
- 只有实体自身的范围，以及没有答案的三个问题。

先在可写阶段建立夹具，关闭后用 **readOnly** 句柄评测。范围内两种文本方法都完整读取已准入 ID 集合的 payload，再排名、截断；每题核对读取 ID 与读取次数，文本阶段不调用 `get()` 搬运向量。没有全库 Top-K 后求交，也没有自动扩大范围。

比较方法：

1. **直接复用词面规则**：从生产 store 的临时副本导出 `primaryScore/queryTerms`，在候选集合中执行；按分数、NodeId 确定性排序。
2. **范围内 payload BM25**：只在该集合正文上用 ASCII 单词 / CJK 2-gram、k1=1.2、b=0.75 计算 BM25。没有 AC、调参或新停用词表；它是临时实验实现，**不是原生 BM25 的等价封装**，语料统计也只来自该范围。
3. **范围内向量**：复用真实本地 GTE 向量，以 `searchGraphFirst` 在可用 ID 中精确排名。七个新增实体元数据锚点使用零向量，不参与语义候选；原 AuthGateway 内容节点有真实向量。
4. **实验组合**：分别把上述两种文本结果与独立向量候选按既有 1:2.4 排名权重组合。没有测试新权重、末位保护或生产排序替换。

### 32 道复用问题，在新图语料上

| 方法 | Top-1 命中 | Top-5 命中 | 返回的范围外候选 |
|---|---:|---:|---:|
| 当前全库 searchNodes 对照 | 24/32 | 27/32 | 81 |
| 范围内直接复用词面规则 | 8/32 | 8/32 | **0** |
| 范围内 payload BM25 | 23/32 | 26/32 | **0** |
| 范围内纯向量 | 26/32 | 32/32 | **0** |
| 范围内词面规则 + 向量 | 28/32 | 32/32 | **0** |
| 范围内 payload BM25 + 向量 | 28/32 | 32/32 | **0** |

全库对照没有收到实体限制，其范围外计数是对照观察，不是现有功能违约。新增了图、干扰与版本节点，此处 24/27 与前轮无业务边小库的 27/31 **不是同一实验**，不能据此宣称生产检索退步或优化收益。命中指至少一条已标注相关事实，非回答准确率。

直接复用规则的覆盖率很低，原因包括长问题的词面覆盖门槛、同义改写与跨语言。范围确定后，孤立使用该规则仍不足以替代完整检索；保留独立向量候选有明显必要性。

### 额外关系诊断

额外 10 题中，6 题有标注答案，1 题只有实体元数据，3 题无答案，分开统计。

| 六道有答案诊断题 | Top-1 | Top-5 |
|---|---:|---:|
| 范围内直接词面规则 | 3/6 | 3/6 |
| 范围内 payload BM25 | 5/6 | 5/6 |
| 范围内纯向量 | 6/6 | 6/6 |
| 词面规则 + 向量 | 6/6 | 6/6 |
| payload BM25 + 向量 | 5/6 | 5/6 |

同一句重试问题在两个实体中分别返回各自的事实，没有相互混入。元数据独立实体返回 `scope_has_anchor_only`。三道无答案题中，BM25 有 2 题仍返回候选，向量/组合有 3 题返回候选，均标记候选资格，不据此确认答案。没有生成模型回答。

广义实体保留了原 F-EMB-04：维度契约在范围内向量第 **1**，在 payload BM25 中没有字面命中，融合后第 **19**，仍不进 Top-5。直接词面规则在该题没有文本候选，组合便保留向量结果。这个差异不能解读为词面规则普遍更优；它说明**范围约束不能替代对范围内文本噪声的处理**。

## 验证、费用与复现

- 原生探测、关系真值、四类业务边、共享事实、期限/版本、关联缺口、截断拒绝、读取集合及结果边界：**338/338**。
- 42 题、5 个范围内实验方法，共返回 **624 条候选，范围外为 0**。文本两方法每题各只读完整候选集一次，文本评分阶段向量读取为 0。
- 所有只读阶段前后数据库文件 SHA-256 相同；实验未使用真实记忆库或凭据。
- 使用已有真实向量缓存，本轮新增本地 embedding **15 次**，费用 **¥0**，付费模型生成 0。停止模型运行器后，从完整缓存离线重放全部结果，HTTP **0**。
- `node scripts/run-all.mjs` → **85/85**。scripts 仍为 120 个 .mjs；冻结 UI 测试、lib/、package.json、lockfile 未改变。没有新增 UI 或 smoke 文件。
- 初次离线预跑因新夹具缺少缓存而拒绝联网；一次预算探测断言被 1200 节点实际结果否定，已修正并保留上述边界说明。未将这些预跑算成通过的正式结果。

```powershell
# 模型运行器启动方法沿用 LOCAL-EMBEDDING-READ-RESULTS 报告；仅 loopback、预算 0
node scripts/verify-local-embedding.mjs --scoped-text --output .tmp/scope-text-live --budget 0 --nodes 0
# 停止模型后重放，缺缓存立即失败
node scripts/verify-local-embedding.mjs --scoped-text --query-cache .tmp/scope-text-live/query-cache.json --offline --output .tmp/scope-text-replay --budget 0 --nodes 0
```

也可通过 `--query-cache` 复用已有相同模型、指令及原语料缓存，新增正文/问题才请求向量。模型固定为上一轮同一份本地权重。证据见[目录](evidence-scoped-text-2026-11-12/)；不提交数据库、向量缓存或临时导出模块。历史评测脚本指纹固定到其原提交，避免后续扩展脚本引起历史证据校验误报。

## 结论与剩余边界

**F-EMB-04 的任意 ID 文本能力验证和 payload fallback 开发评测完成，生产方案尚未实现。**可继续讨论“有界 payload 文本通道 + 独立向量候选”，但不能直接把当前词面规则当作完整替代，也不能仅凭本夹具选择 BM25 融合上线。

仍需独立关系/真实问题集、范围内无答案处理与混合保护的验证；本轮没有验收实体歧义、live 并发改边、会话接入、自动召回或 UI。F-EMB-04 的同实体文本噪声仍开放。URI 条件性原生路径若要采用，需另立非空唯一标识契约与数据验收；当前不做真实数据迁移。
