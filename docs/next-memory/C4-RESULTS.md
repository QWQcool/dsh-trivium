# C4 结果：两个对手的验装与同语料注入对照

日期：2026-10-29。基线 `534bcb1`（0.8.0 已发布）。预注册见 [C4-PLAN](C4-PLAN.md)，本文件只追加实测，
未修改预注册的场景、判据或臂。

> **后续更新**：本文件里的 4/6 是**修复前**状态。S05/S07 的两个缺陷已在 D0 修掉
> （长文本尾部保底进注入、去掉 `topK: 3` 的隐藏上限），同一协议复测为 **18/18**，见 [D0-RESULTS](D0-RESULTS.md)。
> 这里的数字保留原样，用作「修之前长什么样」的证据。

## 1. 一句话结论

**两个对手都装上了，也都走通了真实宿主钩子；但在 6 个同语料场景、同一判据下没有一个臂超过「同样事实写成一段文本」。**
差异的**机制**是清楚的：图记忆把「完整正文」留给工具读取、把注入压成摘要；在**不给工具**的条件下，
长事实与多条并列事实会丢；而纯文本臂在 360 token 内是全的。这与我方 C 批的结论同向，不是新发现，
但这次是**用两个第三方实现**复现出来的。

## 2. 验装（可复现）

| 项 | 结果 | 证据 |
|---|---|---|
| `dsh-goodmemory@0.1.2` | ✅ 装上（22 个包），managed bridge 733 ms 就绪，`contractVersion=phase-39.http-memory.v1`，`/healthz` 200 | `remember`/`recall-context` 均返回 200 |
| 其 peer 锁 | ⚠️ 精确锁 `@deepseek-ai/dsh-llm/agent/session@0.1.0-rc.8`、`cordis@4.0.1`；本机宿主 0.2.1-rc.4、cordis 4.0.5 | 必须 `--legacy-peer-deps`，运行时用宿主 peer 仍可 `apply()` 并注册 `agent/pre-step` |
| Bun 依赖 | ⚠️ **必须显式给 `GOODMEMORY_BUN_BINARY`**。它用 `process.execPath` 起 launcher，launcher 再 `spawn("bun")`；Windows 上 npm 装的 `bun` 只解析到 `bun.ps1`，spawn 直接失败 | 不给时报 `bridge exited before ready code=1`；给 `…\@oven\bun-windows-x64\bin\bun.exe` 后 733 ms 就绪 |
| `dsh-memory`（`34262315716`，HEAD `29c361a`，`0.20.0`） | ✅ 装上（48 个包）；`node:sqlite` + `sqlite-vec 0.1.9` 在 Windows 加载成功（`vec_version()=v0.1.9`） | `store.add` → `store.search` 命中；`apply()` 注册 `agent/pre-step` 并注入成功 |
| npm 同名包 | ⚠️ **`npm i dsh-memory` 装到的是另一个项目**（`0.1.0`，FTS5 + 3 工具，无 sqlite-vec） | 只能用 GitHub 源码；本轮用 `git clone` + `npm i --omit=dev` |
| 跑在什么宿主上 | 真实插件 `apply` + 真实 `agent/pre-step` + 宿主 peer 0.2.1-rc.4 的 `dsh-llm` | **不是**完整 `dsh web` 会话（见 §6） |

## 3. 对照设计（与预注册一致）

- 语料：`scripts/quality-fixtures.mjs` 同一份合成事实；取 S01/S04/S05/S06/S07/S09（排除需修订链/归档的 S02/S10/S08）。
- 每格独立临时库；写入前断言库路径在临时根下。
- 判据：`grade()` 严格字段比较；金标未改。
- 模型 `deepseek-flash`、关思考、`temperature=0`、`max_tokens=600`，每格 n=1。
- **所有臂都不提供工具**，只比注入/召回这一个变量。

## 4. 实测（42 次真实请求，¥0.0203）

| 臂 | 注入上限 | 通过 | 平均注入 token | 平均 prompt token | 估算费用 |
|---|---|---:|---:|---:|---:|
| `none` | 0 | **1/6** | 0 | 86 | ¥0.00128 |
| `plain-all`（同库完整投影） | 不截断 | **6/6** | 360 | 463 | ¥0.00614 |
| `trivium-inject`（我方 pre-step，autoRecall） | 300 | **4/6** | 76 | 156 | ¥0.00228 |
| `goodmemory-256` | 256（其默认） | **4/6** | 17 | 106 | ¥0.00157 |
| `goodmemory-300` | 300 | **4/6** | 17 | 106 | ¥0.00157 |
| `dsmmemory-800` | 800（其默认） | **2/6** | 12 | 102 | ¥0.00148 |
| `dsmmemory-800-min0`（post-hoc，见下） | 800 + `injectMinScore=0` | **5/6** | 296 | 455 | ¥0.00597 |

逐场景（通过 = 严格字段一致）：

| 场景 | none | plain | trivium | gm-256 | gm-300 | dshm-800 | dshm-min0 |
|---|---|---|---|---|---|---|---|
| S01 单条事实 | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| S04 跨库隔离 | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| S05 长正文取尾部 | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ |
| S06 无此事实（负例） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| S07 六条并列 | ✗ | ✓ | ✗(3/6) | ✗ | ✗ | ✗ | ✗(4/6) |
| S09 换述 | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

## 5. 失败机制（有注入文本为证，不是猜）

**S05（长正文，答案在尾部 500 字之后）**

- 我方：注入的是**摘要**（`autoRecall (summary; ctx_read for full text)`），尾部命令被截掉；设计上要靠 `ctx_read` 取全文——本轮不给工具，所以必失败。**这是工具面的代价，不是召回错误。**
- `dsh-memory`：整条正文进注入，但同样在 ~500 字处截断，命令不在上下文里。
- `goodmemory`：该事实**入库成功**（`accepted=1`），但 `recall-context` 直接返回 `itemCount=0`（同一 query 直连桥复测仍是 0），因此拿不到任何正文。

**S07（六条并列事实，要全列）**

- 我方：只注入 3 条（QA1–QA3，89 token）。预算没用满，说明是**去重/条数侧**把高度相似的三条折掉了。
- `dsh-memory`（min0）：注入 4 条；默认档 0 条。
- `goodmemory`：`itemCount=0`（12 条全部入库成功，含 6 条并列）。
- 纯文本：6 条全在，360 token 内。

**`dsmmemory-800` 默认档 2/6 不是「检索不到」**：其 `injectMinScore=0.02`，而单路 rank1 得分约 0.016，单条命中会被整条滤掉；诊断字段 `hitsAtZeroThreshold=6` 表明库里检索得到。为了把「门槛」与「检索」分开，追加了 **post-hoc 臂** `dsmmemory-800-min0`（只改这一个参数），通过数 2/6 → 5/6。该臂**不在预注册表内**，不作为主结论，只作为归因证据。

## 6. 这轮证明了什么 / 没证明什么

证明：

1. 两个对手在本机**可装、可跑、可注入**；三个「装不上」的旧假设（Bun 缺失、sqlite-vec 在 Windows 不可用、宿主版本不兼容）都不成立。
2. 在小库、单轮、无工具条件下，**注入更省 token 的臂并没有更好的质量**；质量缺口集中在「完整性」：长正文尾部、多条并列项。
3. 对手的**默认门槛**会改变结论：`dsh-memory` 默认 2/6，放宽一个参数就 5/6。**报「对手差」而不报参数，等于造假。**

没证明（预注册 + 本轮新增）：

- **工具面未对照**：`dsh-memory` 27 个工具、我方 4 个工具都没给模型；S05/S07 的失败很可能被 `ctx_read` 直接消除。**不许把本表当产品排名。**
- 修订链（S02/S10）与归档（S08）未对照：三方语义不等价。
- 抽取质量未对照：三方都直接种事实；`goodmemory` 走它自己的 `remember` 规则抽取（必须用 `记住：` 才被接纳，`explicit_fact`），入库形态由其策略决定。
- 未跑完整 `dsh web`（无 UI、审批、压缩、真实会话上下文）；未做多模型、多重复（n=1，方差未知）。
- `goodmemory` 对 S05/S07 返回 0 的**内部原因未定位**（只确认为桥自身行为，非本 harness 传参错误）；也未测其 LLM 辅助抽取档。
- 后台整理成本未测（`dsh-memory` 的 `batchExtract`、可选的 LLM 提取）。
- `trivium-inject` 的 autoRecall 是**测量条件**，不是我方默认（默认 `recallMode: off`）。

## 7. 对 D 批的直接输入

1. **摘要 + 工具读取是一体的**：只测摘要会低估它，只测工具会高估它。D 若要改召回，必须先决定「长正文是否总是进注入」，否则任何召回分数都不可比。
2. **相似事实折叠要加边界**：S07 只注入 3 条且预算没用满（89/300），所以折在**去重/条数侧**，不是预算。
   注意不要套用 C 批的旧结论：精确名称被图连通性挤出 top-8 的问题已由 P0（`534bcb1`，`exactCurrentName` 排序键 + `smoke-p30`）修掉，
   那是**检索层**；这里是**注入装配层**对「编号不同、结构相同」的事实做了折叠，是另一条路径，D 批要单独定位（目前未插桩证实具体阈值）。
3. **门槛参数必须先报后比**：对手一个 `injectMinScore` 就能把 2/6 变 5/6；今后任何跨插件对比都必须同时报默认值与放宽值。

## 8. 方法学教训（本轮最贵的两条）

1. **配置未生效是静默的**：`Config({})` 返回的是 cosmokit `Volatile`（只有 `get`），直接 `{...base}` 展开会把 `get` 带进配置对象，插件的 `getCfg()` 于是读到 schema 默认值而不是覆盖值——`dbFile` 被忽略，冒烟脚本把 12 条合成事实写进了**用户真实库** `~/.dsh/memory.db`。
   - 处置：已按 content 标记精确删除 12 行 + 12 条孤儿向量，复核库内 `memories=0`（该库此前为空）。
   - 固化：脚本现在在**任何写入前**断言库路径在临时根下；`Config({}).get()` 先取值再展开。
2. **测量脚本自己的错会伪装成产品结论**：`goodmemory` 首版注入为 0，原因是它的 recall query 取自 `next()` 的决策消息，而我把 `next()` 写成了空数组；`dsh-memory` 首版注入为 0，是因为用户消息缺 `role` 字段。两处都是 harness 的错，修完才有上面的数字。

## 9. 复现

```bash
# 一次性安装（gitignored）
mkdir -p .tmp/c4/goodmemory && cd .tmp/c4/goodmemory && npm init -y && npm i dsh-goodmemory@0.1.2 --legacy-peer-deps
export GOODMEMORY_BUN_BINARY=<path to bun.exe>     # Windows + npm 装的 bun 必须显式给
git clone --depth 1 https://github.com/34262315716/dsh-memory .tmp/c4/dsh-memory
cd .tmp/c4/dsh-memory && npm i --omit=dev

# 离线审计（0 元）：只装配注入，不发模型请求
node scripts/bench-c4.mjs --out=.tmp/c4/audit.json

# 真实对照（≤15 元，本轮 42 格共 ¥0.0203）
node scripts/bench-c4.mjs --run --budget=15 --out=.tmp/c4/online.json
```

预算与账本：每请求先按 UTF-8 字节上界预留费用并落盘，超预算不发请求；缺 `usage` 保留全额预留并停止。
