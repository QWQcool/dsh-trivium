# 工作交付报告（2026-10-30，供外部审查）

分支 `codex/r1-r2-reliability`，起点 `1fe67c4`。本文覆盖本日全部改动：**8 处产品代码修复 + 1 组新增能力（E0/E1-A）+ 5 处测量修正**，以及对应的实测证据、成本与已知风险。

未做：没有推送远端、没有合并 `main`、没有打 tag（发布 npm 由用户单独决定）。B 站插件源码一行未改；所有真实模型调用都在隔离 `DSH_HOME` 内，未登录真实账号、未评论/私信/发布。

## 一、结论先说

之前不是"只跑测试"。本日修掉的**产品缺陷**共 8 个，其中 4 个会**静默丢事实或给出过期答案**：

| # | 缺陷 | 后果 | 修前 → 修后 |
|---|---|---|---|
| 1 | 工具指令句整轮丢弃（`distillableTurns`） | 「按顺序调用工具，生产端口是 9443。」→ 事实直接消失 | 门控 `empty` → 正常抽取并落库 |
| 2 | 抽取空回答被当成"没有内容" | 模型思考耗尽预算返回空 → 窗口被消费、pending 清空 | 空回答 = 失败，pending 保留 |
| 3 | 抽取 `maxTokens=400` | 3/3 重试都 `stop_reason=max_tokens`、正文 0 字 | 400 → 900，并改 `reasoningEffort: "off"`，截断 12/18 → **0/18** |
| 4 | 凭据闸门只认英文关键词 | 中文「口令 verify-QA-71」原样入库 | 补供应商前缀/JWT/PEM/中文语境；`token 预算` 误伤同时修掉 |
| 5 | 改口不建替代链 | 「先别动方案 A」+「改用方案 B」并存，新会话答 **A** | 自动退休旧决策 + 短地图只列当前：3/5 → **10/10** |
| 6 | 先建短地图、后 fire-and-forget 重放 pending | 15 次里 3 次新会话拿到 `decisions=0`，答"没有记录" | 先 await 重放（≤8s）再建图：5/5 地图有事实、5/5 答对 |
| 7 | 幻觉绝对日期 | 落库文本写 `On 2026-04-06 …`（实际 10-30） | 与窗口原文比对，删日期保事实并上报 |
| 8 | （6 的回归保护）重放无超时 | 我引入的等待可能挂住会话启动 | 8 秒上限 + 后台继续，实测首步 +10.9s 发出 |

新增能力（非修复）：**E0/E1-A 偏好导出**（绑定、快照、渲染、撤回）+ **`prefs-export verify`**（消费端自校验）。B 站插件用**既有文件入口**读到偏好块，未改其源码。

## 二、逐项证据

### 1. 工具指令句吞事实（`lib/extract.js`）

修前实测：

```text
输入：按顺序调用工具，生产端口是 9443。
shouldExtractBatch → { call: false, reason: "empty" }
```

修法：整轮过滤 → **整句判定**（去掉指令短语与 `ctx_*` 名后只剩指令填充才算纯操作）。

验收：`p43` 17/17（修前同用例 4 条失败）；真实宿主复验 4/4：抽取请求发出、prompt 含事实、事实落库、会话可恢复。

### 2. 空抽取回答（`lib/extract.js`）

修前：`stop_reason=max_tokens`、`output_tokens=400`、正文 0 字 → 插件当成"没有候选"，消费窗口并清 pending。

修法：空白回答抛错 → `llmFailed` → 调度器保留 pending。显式 `{"candidates":[]}` 仍是成功。

验收：`p44` 13/13。

### 3. 抽取预算与 reasoning（`lib/index.js`）

A-2 报文级定位：**不是截断**——343 字符消息、缓冲、prompt 都完整；是模型把预算花在 reasoning 上。

改法：`maxTokens 400→900`，抽取调用 `reasoningEffort: "off"`（宿主不认该档位时**回退一次**去掉它，避免抽取彻底不可用）。

验收：`p45` 11/11；A-3 基线 12/18 截断 → **0/18**，抽取命中 5/9 → 9/9。

### 4. 凭据闸门（`lib/schema.js`、`lib/extract.js`）

修前规则只认 `api_key|secret|password|token|bearer|sk-`；中文「口令 verify-QA-71」直接入库（关掉 reasoning 后模型也不再自行隐去）。

修法：新增 `CREDENTIAL_VALUE_RE`（GitHub/AWS/Google/npm/Slack 前缀、JWT、PEM、中文"密码/口令/密钥 + 值"）；英文词从"裸词"收紧为"词 + 值"，修掉「token 预算 500」的误伤。拒绝时 `skipped[]` 上报，**密文不外泄**（`preview` 固定 `<redacted>`）。

验收：`p46` 34/34。

### 5. 决策版本（`lib/extract.js`、`lib/store.js`）

A-5 实测：CORRECTION 只有 3/5，失败样本答成已被撤销的方案 A。

修法：新决策正文含显式替换词（更正/改为/改用/不再使用/替换/取代/放弃/作废/replace/switch to）且点名了某个**活的**旧决策 → 建 `supersedes` 链（多目标按 id 串成链，保证每个旧节点恰好一个后继、不产生 fork）；短地图跳过已有后继的决策，`decisions=` 只算当前。

验收：`p48` 13/13；真实复验 CORRECTION 5/5 → **10/10**。

### 6. 重放与地图的顺序（`lib/index.js`）

证据：复用 15 份报文，其中 **3 份**新会话拿到的是全零地图，而同一轮结束时库里确有事实。

修法：`onAgentStart` 改为「打开库 → 若有 pending：并入缓冲 → savePending → **await** 重放 → 再建短地图」。

验收：桩模式确定性通过；真实 5/5 地图非零、5/5 答对。

### 7. 幻觉日期（`lib/extract.js`）

修法：候选里的绝对日期必须在**窗口原文**出现过；否则连包裹一起删除、保事实、`adjusted[]` 上报；删空则整条拒写（`unsupported-date`）。补了**相对时间放行**：窗口含相对表达且日期落在 `[now−7d, now+400d]` 时保留（“下周五”→`2026-11-06` 不再被误删）。

验收：`p49` 17/17。

### 8. 偏好导出与消费端校验（新增，`lib/consumer-preferences.js`、`scripts/prefs-export.mjs`）

- 绑定：工作区 + 消费方 + 用途 + 逐条授权（soft/hard），跨工作区/跨消费方拒绝；
- 快照：跟随后继链、跳过 fork/归档/过期/脏数据，≤8 条 且 ≤300 估算 token，超限**报错不截断**；`digest=sha256(规范化事实)`；
- 人设：原文件**一个字节不改**，另出 `persona-with-prefs.md`；
- 撤回：清空偏好块而非停止刷新，之后 `export` 一律 `binding-revoked`；
- `verify`：重算 digest、校验绑定/消费方/过期/块完整性/消费方文件/库指纹，退出码 0/3。

验收：`p42` 38/38、`p47` 16/16；E1-A 联动 30/30（含版本更新与撤回后两条真实可达路径）。

## 三、测试与证据

- `node scripts/run-all.mjs` → **50/50 passed**（p0–p49）
- 新增用例：p42 38、p43 17、p44 13、p45 11、p46 34、p47 16、p48 13、p49 17
- 真实模型运行合计 **8 组 / 约 101 次运行**，费用约 **¥1.23**（明细见各文档；其中约 ¥0.08 因采集脚本 bug 未记账，按"不可核账"处理）
- 证据文件：`docs/next-memory/evidence-bili/`、`docs/next-memory/evidence-r3/a2|a3|a5/`

质量轨迹（同一夹具）：CORRECTION 3/5 → 4/5 → 5/5 → **10/10**；LONG-TAIL / NAME-AMOUNT 5/5；NEGATION 10/10；REFERENCE 4/5（判分对"先否定后纠正"过严，未做人工复核通道）。

## 四、提交清单

```
736a3b6 fix(extract): let a correct relative-date resolution keep its date
8f5368f docs(bench): prove the capped setup turns were workspace exploration
4c4cccf docs(bench): correct the cause of the capped setup turns
069b406 docs(bench): re-run the correction and negation cases ten times each
261a534 docs(bench): measure cross-compaction recall behind request and time caps
6f8285d fix(extract): drop absolute dates the conversation never contained
190a9d0 fix(memory): cap the pending-replay wait so a slow extraction cannot stall session start
9cda735 fix(memory): replay pending extraction before building the short map
5d74e17 fix(memory): retire a decision when a newer one explicitly replaces it
7c78b4f docs(bench): widen the extraction baseline to five scenarios x five repeats
56d5869 feat(prefs): let a consumer check what is actually on disk
1a0db39 fix(hygiene): refuse credential values, not just English keywords
64afc61 fix(extract): ask for reasoning "off" so extraction stops truncating itself
b81fe8d fix(extract): stop treating an empty extraction answer as "nothing to store"
097017c feat(prefs): export approved consumer preferences; stop tool cues eating facts
```

## 五、风险与请审查重点

1. **`reasoningEffort: "off"` 的副作用**：抽取消除了模型自发的"隐去敏感信息"判断（同一夹具修前会隐去口令、修后会原样写出）。我们用确定性正则兜底，但**规则有覆盖上限**（自造口令如 `Zx9q2Wm7` 无前缀无线索时会漏）。这是本轮最需要外部判断的取舍。
2. **重放前置带来的启动延迟**：会话启动最多多等一个抽取调用（上限 8s）。一次性进程还会因为那次 HTTP 请求未结束而延迟退出（实测 22.7s）——长效宿主不受影响。
3. **替代链的判定是启发式**：只在显式替换词 + 标签命中时建链；多目标时串成链而不是拒绝，理论上可能把同一标签的两个旧决策都退休。
4. **日期闸门是字面比对**：不认美式 `04/06/2026`、英文月份、中文数字日期；相对时间放行用的是 `[now−7d, now+400d]` 区间近似。
5. **用户可见性缺口**：`skipped`/`adjusted`/`superseded` 只写进 `lastExtract` 与日志，UI 没有入口；E1-B 的强制点仍未落地（当前 `verify` 是可选手动命令）。
6. **依赖**：仍精确锁定 `triviumdb 0.9.0-beta.3`（与已发布的 0.8.1 相同，未变），上游 0.9.0 稳定版未发布；换内核需重跑兼容性验证。
7. **未覆盖**：自然增长触发的压缩、摘要质量单独判分、多模型、5/10/20 轮长会话。跨压缩召回只做了 3 次（注入溢出触发）。

## 六、文档索引

| 文档 | 内容 |
|---|---|
| [A1-FACT-LOSS-FIX](A1-FACT-LOSS-FIX-2026-10-30.md) | 工具指令句吞事实 |
| [A2-LONG-TEXT-DIAGNOSIS](A2-LONG-TEXT-DIAGNOSIS-2026-10-30.md) | 长文本漏记的报文级定位 |
| [A3-EXTRACTION-BASELINE](A3-EXTRACTION-BASELINE-2026-10-30.md) | reasoning off 与质量基线 |
| [A4-SECRET-VALUE-GATE](A4-SECRET-VALUE-GATE-2026-10-30.md) | 凭据值闸门 |
| [A5-WIDER-BASELINE](A5-WIDER-BASELINE-2026-10-30.md) | 5 场景 × 5 重复基线 |
| [A6-DECISION-SUPERSEDE](A6-DECISION-SUPERSEDE-2026-10-30.md) | 改口退休 |
| [A7-REPLAY-BEFORE-MAP](A7-REPLAY-BEFORE-MAP-2026-10-30.md) | 重放顺序 |
| [A8-DATE-GUARD](A8-DATE-GUARD-2026-10-30.md) | 日期闸门与放行 |
| [A9-COMPACTION-RECALL](A9-COMPACTION-RECALL-2026-10-30.md) | 压缩后召回 |
| [A10-REGRESSION-N10](A10-REGRESSION-N10-2026-10-30.md) | n=10 回归与实验条件修正 |
| [BILI-E0-E1A-RESULTS](BILI-E0-E1A-RESULTS.md) | 偏好导出与 B 站文件入口 |
| [E1B-CONSUMER-VERIFY](E1B-CONSUMER-VERIFY-2026-10-30.md) | 消费端校验 |
