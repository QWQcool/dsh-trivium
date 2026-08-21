# dsh-trivium 规划文档

> 以 TriviumDB 为基核的 DeepSeek Harness 本地记忆内核插件。  
> 状态：**v0.4.1**。内核仍是四工具 + 短地图；会话标题栏增加「会话图」（compaction 方框、DSH fork、可选记忆芯片）。Settings 仍管库、归档、开关。  
> 情节图规划见 [`PLAN-session-map.md`](./PLAN-session-map.md)。不是记忆图谱工作台。  
> 代码：GitHub `QWQcool/dsh-trivium`。npm：[`dsh-trivium@0.4.1`](https://www.npmjs.com/package/dsh-trivium)。  
> DSH 目标版本：`@deepseek-ai/dsh@0.1.0-rc.8`（必须钉死；rc.6 上验收过内核，rc.8 上复测设置 / 短地图 / 跨会话 find / 会话图标签）。

---

## 1. 一句话

进程内图记忆，一个 `.tdb` 文件：DSH 启动即打开工作区记忆库，按**节点和边**记，按需读，不另起服务。

对外标识一律用 **`dsh-trivium`**（仓库名、npm 包名、Cordis `id`、GitHub topic `dsh-plugin`）。内部可简称 TDB 内核，不要用 `TDBM_Dsh` 当对外名。

---

## 2. 定位与非目标

### 2.1 是什么

DSH 宿主平面上的**记忆内核**，不是独立上下文数据库，也不是 Mnemon 级记忆工作台。

- 存储：TriviumDB（向量 + JSON payload + 有向带权图，同一 `node_id`）
- 形态：Cordis 插件，随 DSH 进程加载
- 文件：`<workspace>/.dsh/trivium.tdb`（可配置）
- 用户感知：多四个工具 + 启动一张短地图；Settings 里能看见、能删记错的条目

### 2.2 对谁有竞争力

| 对比对象 | 我们赢什么 | 不跟什么 |
|---|---|---|
| 原装 DSH | 跨会话实体/偏好/决策 | — |
| JSON / FTS 记忆插件 | 图扩散、语义+稀疏混合、事务一致 | 功能清单堆工具 |
| Wiki 双链记忆 | 边是引擎一等公民，不是扫 `[[slug]]` | 9 工具 + Python 向量 |
| OpenViking / PowerContext | 无额外服务、延迟、少注入 | LoCoMo、解析农场、Skill 生态 |
| Mnemon | 单文件内核、召回带边路径 | 第一期不比 UI 完整度 |

### 2.3 明确不做（第一期）

- 独立 `trivium://` 文件系统、PDF/Zotero 文档 RAG
- 另起 Python / HTTP 记忆服务
- 每步自动召回约 2000 token
- Mnemon 级侧边栏工作台、跨 Agent 共享、三套存储编排
- 对标 OpenViking 的 L0/L1/L2 产品形态（分层加载的**原则**要，目录树不必抄）

---

## 3. 设计原则

1. **抽取记节点和边**，不把整段对话当长期记忆。
2. **少注入**：启动短地图；模型用工具下钻；自动召回默认关或极严。
3. **注入走 `agent.inject()`**，不写 system prompt（避免 `persona.complete: true` 静默丢上下文）。
4. **失败不挡主循环**：TDB / embedding / 抽取失败只记日志，Agent 继续。
5. **图是主键**：召回结果必须带路径（从哪个节点、沿哪条边过来）。
6. **可看见、可改错**：Settings 列表 + forget；人能纠正脏记忆。

这六条里，1–2 决定准和省 token；3–4 抄 OpenViking / GoodMemory 的接法；5 是 TDB 差异化；6 是从 Mnemon 借的「人要能看见」——第一期用一页列表，不借整套工作台。

---

## 4. 借鉴清单（机制，不是产品厚度）

| 来源 | 借鉴 | 落地 |
|---|---|---|
| OpenViking DSH 插件 | `pre-step` 注入、钉宿主 rc、pending 失败队列 | 宿主插件 + 同生命周期 |
| GoodMemory | 只在真实用户回合考虑召回；回写不含 tool/reasoning | 抽取过滤规则 |
| native-memory | 写入可审批、条目带来源、软删除 | `ctx_remember` 审批；payload 含 `source` |
| Mnemon | 记忆可见、可改、热/冷直觉 | Settings 页；短地图 = 热，`.tdb` = 冷 |
| U-Illll Wiki 图 | 召回带关系 | 用引擎边，不用 Markdown 双链 |
| 本仓库 DSH 预设 | skill_search 式按需加载 | 短地图 + `ctx_find` / `ctx_read` |

---

## 5. 架构

```
DSH Agent Loop
  │  agent/session-start · agent/pre-step · session/event · compaction/end
  ▼
┌─────────────────────────────────────────┐
│  dsh-trivium  (Cordis host plugin)      │
│  短地图注入 · 四个工具 · 抽取调度 · Settings │
└─────────────────┬───────────────────────┘
                  │ insert / search_hybrid / link / get
                  ▼
┌─────────────────────────────────────────┐
│  triviumdb (Node napi，进程内)           │
│  <workspace>/.dsh/trivium.tdb            │
└─────────────────────────────────────────┘
```

不引入第二进程。Embedding 第一期用 DeepSeek 兼容 API（与 DSH 同一 Key）；本地模型作为后续选项，缺 embedding 时允许「只建节点和边、向量为空」，`ctx_find` 退化为 payload 过滤 + 图遍历 + BM25（若 TDB 稀疏层可用）。

### 5.1 挂载位置

- **Host 平面**（`~/.dsh/profiles/web/cordis.patch.yml` insert），所有预设可见。
- 经现有 `dsh-extra/deploy-extra.cjs` 部署到 `~/.dsh/profiles/web/node_modules/`。
- 源码建议：`DeepSeek_Harness/dsh-extra/plugins/dsh-trivium/`。

### 5.2 依赖

| 依赖 | 用途 | 约束 |
|---|---|---|
| `triviumdb` | 存储内核 | 预编译 napi，与 DSH 同进程 |
| `@deepseek-ai/dsh-tools` 的 `defineTool` | 注册工具 | peer，走 profile fallback |
| `@deepseek-ai/dsh-llm` 的 message 构造器 | 注入可见消息 | 同 OV 插件，勿手搓 shape |
| DSH `0.1.0-rc.8` | 运行时 | **exact pin** |

---

## 6. 数据模型（按 TDB 特性）

每个记忆对象是一个节点：`node_id → vector + payload + edges`。

### 6.1 节点类型（payload.type）

| type | 何时写入 | payload 要点 |
|---|---|---|
| `entity` | 反复出现的人、仓库、服务、接口 | `name`, `aliases[]` |
| `preference` | 用户明确说「以后都这样 / 记住」 | `text`, `scope` |
| `decision` | 有对象、有约束、可能有期限 | `text`, `until?` |
| `experience` | 工具失败后修正成功 | `fail`, `fix` |
| `workspace` | 每个库恰好一个，作图根 | `path` |

第一期只这五类。对话原文、tool 结果、reasoning **不入库**。

### 6.2 边（label）

| label | 含义 | 示例 |
|---|---|---|
| `in_workspace` | 实体属于本工作区 | Entity → Workspace |
| `about` | 偏好/决策针对某实体 | Preference → Entity |
| `decided` | 对某对象做过决策 | Decision → Entity |
| `broke` / `fixed` | 失败与修复 | Experience → Entity |
| `same_as` | 去重合并 | 旧节点 → 留存节点 |
| `from_session` | 抽自哪次会话（溯源，不参与扩散默认路径） | * → 会话标记节点（可选） |

召回：`search` 锚定 → `expand_depth=1..2` 沿业务边扩散。`from_session` 默认不扩，以免整图被会话节点粘成一团。

### 6.3 Payload 公共字段

```json
{
  "type": "preference",
  "text": "鉴权走 header X",
  "uri": "ctx://pref/12",
  "source": { "sessionId": "...", "eventId": "...", "quote": "..." },
  "createdAt": "2026-08-19T00:00:00Z",
  "updatedAt": "...",
  "status": "active"
}
```

`status: archived` 为软删除（学 native-memory）。`uri` 仅作稳定引用，不是文件系统。

---

## 7. 抽取规则（写库）

在 `compaction/end` 或会话空闲时异步跑，**不在每一句上跑**。

### 7.1 写入白名单（宁可漏记）

- 用户说「记住」「以后都」「别再」→ `preference`
- 同一专有名在本会话出现 ≥2 次，或已在库中 → `entity`（同名合并同一 `node_id`）
- 「先别动 / 下周再改 / 采用方案 A」且能挂到实体 → `decision`（可带 `until`）
- 同一步骤内 tool 失败随后成功 → `experience` + `broke`/`fixed`
- 其余丢弃

### 7.2 禁止写入

- 整段对话、tool 参数/结果、thinking
- 密钥、token、`.env` 内容（命中则拒绝，学 native-memory）
- 一次性任务指令（「把这文件改了」）当成永久 preference

### 7.3 去重

新候选先 `search` 同类节点：过高相似 → `merge` 进已有节点并补边，不新插。第一期可用 embedding 阈值 + 同名精确匹配；没有 embedding 则只用精确名/别名。

### 7.4 第一期抽取实现策略

优先**规则 + 一次小 prompt**（只输出 JSON 候选，再由代码决定 merge/insert）。不要上 OV 那套完整 memory schema。抽取用的 LLM 调用失败则跳过本轮，不阻塞。

---

## 8. 少注入规则（读库进窗口）

| 时机 | 注入什么 | 预算 |
|---|---|---|
| `agent/session-start` | 短地图：实体数、偏好数、决策数 + 最多 8 个实体名 | **≤400 token** |
| `agent/pre-step` | 默认**不**自动召回 | 配置项 `autoRecall: false` |
| 模型调用工具 | `ctx_find` 只返回 L0（text 截断 + 边路径）；`ctx_read` 才给全文 | find 单条 ≤200 字 |

若日后打开 `autoRecall`：仅当本步含直接用户文本（GoodMemory 规则），且分数极高时最多 3 条 L0，总预算 ≤300 token。第一期保持关闭，强迫走工具下钻——这既是省 token，也是准（窗口不被近义噪声带偏）。

注入物必须是带 `source: { kind: 'plugin', pluginId: 'dsh-trivium' }` 的 session 事件，Trajectory 可见。

---

## 9. 工具（四个，不再加）

| 工具 | 作用 | 审批 |
|---|---|---|
| `ctx_find` | hybrid 检索 + 有限深度扩散；返回 id、type、L0、score、**边路径** | 否 |
| `ctx_read` | 按 id 读全文 payload | 否 |
| `ctx_remember` | 显式写入（模型或用户）；可带 `linkTo` | **是** |
| `ctx_link` | 两 id 之间建边 | **是** |

不提供 `ctx_forget` 给模型（避免误删）；删除只在 Settings。模型若认为过时，可 `ctx_remember` 写新决策并 `ctx_link(..., same_as)`，由人在 UI 归档旧节点。

工具 schema 保持短。描述里写清：先 find 再 read；不要把 find 结果全文复述进后续思考。

---

## 10. DSH 生命周期

| 钩子 | 行为 |
|---|---|
| 插件 `apply` | 打开或创建 `.tdb`；注册工具；挂 Settings 页 |
| `agent/session-start` | 确保有 `workspace` 根节点；`agent.inject` 短地图 |
| `session/event` | 缓冲 user/assistant 文本（截断、去图、去 tool） |
| `turn/end` | 不抽取；只把缓冲标成「待蒸馏」 |
| `compaction/end` | 触发抽取（主路径） |
| 进程退出 / 定时 | `flush()` TDB；抽取失败进 pending，下次 session-start 重放 |

workspace 切换：关掉旧库，打开新路径的 `.tdb`。记忆默认**按工作区隔离**。

---

## 11. UI（第一期最小）

Settings 一页「Trivium 记忆」：

- 按 type / `q` 筛选；过期决策默认隐藏，可勾选显示
- 点行展开业务边邻居（入边 `<-about-` / 出边 `about->`）；实体可「只看挂在这上面的」
- 列表显示 `until`、过期标记、path
- 改正文 / 改名 / 别名；同类型合并（`same_as` 后归档）
- 归档（软删，find 不再返回）/ 删除（从 `.tdb` 去掉）；页上写明区别
- 导出 / 导入 JSON 快照（按 `uri` 去重合进当前库）
- 开关：注入策略三选一（关 / `autoRecall` / 实体名折中，默认关）、抽取、远程 embedding（默认关，手填 URL）
- 显示当前 `.tdb` 路径与节点数

不在第一期做：记忆图谱工作台、Mnemon 式编辑器、本地 embedding。能看见、能改、能归档，就满足「人可纠正脏记忆」。  
情节方框（compaction / fork）是另一面，见 [`PLAN-session-map.md`](./PLAN-session-map.md)，不要和记忆列表揉在一起。

---

## 12. 分期

### P0 — 内核可跑（开工目标）

- 插件骨架：`package.json`、`cordis.patch.yml`、`apply(ctx)`
- 打开/创建 `trivium.tdb`
- 四个工具接上 TDB
- session-start 短地图
- deploy-extra 能装进 web profile
- 手工：会话 A remember + link，会话 B find 得到并带边

### P1 — 抽取与少注入

- compaction 后规则+小 prompt 抽取
- 去重 merge、密钥拒绝、pending 重放
- Settings 列表与归档
- 注入 token 计数（便于对照 context-doctor）

### P2 — 变准（已完成）

离线 `npm run smoke-p2`：**20/20**。本机 DSH（rc.6 / 3090）pending 重放抽取后，会话 B `ctx_find` 能命中；空库对照（vanilla analogue）无耐久命中。

| 组 | 题 | 结果 |
|---|---|---|
| 偏好 P1–P5 | 鉴权 header X / pnpm / README 英文 / 中文回复 / run tests | 命中 |
| 实体 E1–E5 | TriviumDB / AuthGateway / dsh-trivium / DeepSeek_Harness / X-Request-Id | 命中；`「鉴权」` 不再成实体 |
| 决策 D1–D4 | 下周改 AuthGateway（`until=下周`）/ 方案 A / 单文件 / until Friday | 命中；有对象的决策带 `decided` 边 |
| 经验 X1 | bash mkdir 失败后成功 | 离线命中；live 未造 tool 失败（不挡 P2） |
| 负例 N1–N5 | 天气 / 改这个文件 / sk- 密钥 / 实体「鉴权」 / 嗯好的 | 不入库或 find 不中 |

P2 调过的准头（相对 P1）：

- 专有名：CamelCase / `X-Request-Id` / `DeepSeek_Harness`；`「」` 不再当实体名
- 先插 entity 再挂 `about`/`decided`；只链**已有**实体，不因单次提及造 README 一类节点
- 决策/偏好按**正文**合并，不按实体名合并（避免「方案 A」被 Friday 覆盖）
- 一句一候选；密钥/一次性改文件只丢该句，不连坐整轮
- `in_workspace` 去重；短地图顺序 preference → decision(`until`) → entity → experience；约 130 token（≤400）
- 默认 `autoRecall` 仍关；无本地 embedding（关键词 + 边路径够这 20 题）

对照原装 DSH：空 `.tdb` 上同样的 `ctx_find("鉴权")` 无 preference。不在 P2 对标 OpenViking。

### P3 — 体验（已完成）

P2 说明：**抽得准、默认少注入已经够用**。不要开自动召回，也不要上图谱工作台。

已落地：

1. **Settings 搜索/过滤** — `?type=` + `?q=`；列表显示 `until` 与边 path（`about`/`decided`/…）。
2. **find 噪声** — 只保留 query 出现在 name/text/until 里的主命中，再沿 `about|decided|broke|fixed` 扩 1 跳；不再跟 `in_workspace` 把整图拖进来。`ctx_find` 按 type 分栏。
3. **方案名弱实体** — 「采用方案 A」会建 `方案 A` 实体并 `decided` 过去。
4. **空闲抽取** — `turn/end` 后约 12 秒仍 dirty 则再抽一次（compaction 优先；失败仍 pending）。
5. **Settings 看见边** — 点行展开 `incoming`/`outgoing`；实体「只看挂在这上面的」（`?about=`）；过期决策默认隐藏（`?stale=1` 打开）；归档 vs 删除文案。
6. **短地图 until** — named 最多 4 条偏好后预留最多 2 条未过期 `until` 决策，总预算仍 ≤400；提示用实体名 `ctx_find`。

仍默认关：`autoRecall`。仍不做：Mnemon 工作台、图谱画布、OV 板、本地 embedding。

### P4 — 内核（已完成）：find 用边和 until

面（图谱 UI / Mnemon / 新工具 / 默认 autoRecall）先不动。这一刀只改召回核：

- 业务边（`about`/`decided`/`broke`/`fixed`）权重大于 `in_workspace`，find 排序上提有业务边的命中
- 决策写入 `until` 的同时尽量解析 `untilAt`；**过期决策默认不出现在 find 里**，除非查询本身在问这个期限（如 `周五` / `下周`）
- 边权写入 TDB（`in_workspace=0.15`，业务边≈1）；引擎扩散若还不按 label 过滤，插件层继续只沿业务边扩 1 跳
- **实体名锚定** — query 精确等于或包含已有 entity 的 `name`/`aliases` 时，将该实体当锚点，只沿 `about`/`decided`/`broke`/`fixed` 扩 1 跳入/出边；邻居正文不必含 query。过期 `until` 仍默认隐藏。不加 `ctx_find` 新参数。离线 `smoke-p4` 已锁。

- **锚点入边 path** — `formatHit` / Settings 列表把入边（仅 `about`/`decided`/`broke`/`fixed`）写成 `<-decided-12(先别动…)`，与出边 `label->id` 并列。不加工具参数，仍自己扫入边。`find("AuthGateway")` 的 entity 行 path 含 about/decided 入边。
- **入边参与排序** — 实体只有出边 `in_workspace` 时，仍按入边业务边给 `rankBoost`，避免锚点排在未连边噪声后面。
- **过期入边默认不进 path** — 与 find 藏过期决策一致；query 在问期限时，实体 path 仍可出现该入边。
- **`same_as` 跟随** — 命中旧节点且存在 `same_as`→留存节点时，find 一并返回留存节点（不把 `same_as` 当业务扩散边）。
- **`ctx_read` 入边** — 返回 `incoming[]`（from/label/type/l0），全文读实体时能看见谁 `about`/`decided`/`broke`/`fixed` 过来。
- **抽取挂边** — preference 的 `about` 只取 **span 内**专有名，不再因邻句「TriviumDB 是内核」误挂。experience 从 fail/fix（或同 turn 用户句）取 `linkName` 并 `fixed`。

其后仍先核、后面；不要开记忆图谱工作台 / Mnemon / 默认 autoRecall / OV / 本地 embedding / 第五工具。情节会话图按 [`PLAN-session-map.md`](./PLAN-session-map.md) 开，不在 Settings 里做。TDB `expandLabels` / `getIncomingEdges` 仍绕开，等引擎露出再换。v0.2.0 已加：Settings 改名/合并/导入导出；注入三选一；可选远程 embedding（手填 URL）。v0.3.0 已加：只读 Markdown 导出、WorkBuddy MEMORY.md 一次性导入、每批限写 3000 字。v0.4.0 已加：会话图、记忆芯片、从检查点 fork。v0.4.1：宿主钉 `@deepseek-ai/dsh@0.1.0-rc.8`。

### 待 live 验收（新面回家再测）

只报缺陷、不加功能。钉 `@deepseek-ai/dsh@0.1.0-rc.8`。同一 `.tdb` 不要被两个 Node 进程同时打开（验收时不要再跑会 `openWorkspaceDb` 的 smoke）。脚本：`npm run verify-live-p2`（以及 `scripts/verify-live.mjs`）。

1. 插件已挂 web profile；不装 Python、不另开记忆端口。
2. 短地图 ≤400 token；默认 `autoRecall` 关；Trajectory 能看到 `dsh-trivium` 注入。
3. TDB / 抽取失败时对话仍可用。
4. 会话 A 记下「鉴权走 header X」并连实体；会话 B `ctx_find("鉴权")` 命中，path 含该实体。
5. 闲聊 / 一次性改文件 / 密钥 **不** 变成 preference；`「鉴权」` 不成实体。
6. Settings 能搜、能归档，归档后 find 不再返回。
7. P2 抽取 pending 重放后，E/P/D 题能命中；空库对照无耐久命中。X1（tool 失败再成功）live 仍缺，不挡已完成的 P2。
8. **P4 实体锚定：** 会话 B `ctx_find("AuthGateway")` 给出未过期决策/偏好（邻居正文可无实体名）；过期 `until` 决策默认隐藏；`ctx_find("AuthGateway 的决策")` 仍能锚定；不拖未连边的无关 pref（如 pnpm）。
9. **入边 path：** `ctx_find("AuthGateway")` 的 entity 行 path 含 `<-about-` / `<-decided-`，**不含**过期决策入边；`ctx_find("周五")` 时实体 path 仍可见该过期入边。
10. **`ctx_read`：** 读 AuthGateway 的 JSON 含 `incoming`，其中有 about/decided（及有对象的 fixed）。
11. **`same_as`：** 旧决策 `same_as`→新决策后，用旧决策正文 `ctx_find` 能拿到留存节点。
12. **抽取挂边：** 「记住，本仓库鉴权走 header X。TriviumDB 是内核。」抽出的鉴权 pref **不** `about`→TriviumDB；「记住，AuthGateway 日志走 header X。」则 `about`→AuthGateway。
13. **经验扩邻：** 对某实体有 `fixed`/`broke` 的 experience，在该实体上 `ctx_find` 能扩到它，实体 path 含 `<-fixed-` 或 `<-broke-`。
14. **Settings 面：** 能展开业务边邻居；AuthGateway 上「只看挂在这上面的」能看到未过期决策/偏好、看不到未连边 pnpm；过期决策默认不在列表，勾选后可见；页上能区分归档 vs 删除。
15. **短地图：** session-start 仍 ≤400 token，named 里能看到带 `until` 的未过期决策；默认 autoRecall 仍关。

### TDB 引擎缺口（可问作者 / 可提 PR）

插件能绕开，但核要「图检索一次返回」时会顶到这些 API：

1. **`neighbors(id, depth)` / `search*` 的 expand 不能按边 label 白名单扩散** — `JsSearchConfig` 没有 `expandLabels`。现在只能自己扫边，否则 `in_workspace` 会把整库粘在一起。希望：`neighbors(id, { depth, labels })` 或 search `expandLabels: ["about","decided"]`。
2. **没有入边 API** — `getEdges` 只有出边；反向 `about`/`decided` 要扫 `allNodeIds`。README 写过 Reverse Hash Net，Node 绑定没露出 `getIncomingEdges(id)`。
3. **`unlink(src, dst)` 不能按 label 删一条边** — 两点之间多种 label 会一起断。
4. **`searchHybrid`/`searchAdvanced` 的图扩散是否尊重 `weight`、负权抑制，文档未写清** — 我们已写入不同 weight，但 find 排序仍在插件层做。
5. **payload 日期没有一等过滤** — `untilAt` 是我们的 JSON。TQL `FIND { untilAt: { $lt: "..." } }` 若对 ISO 字符串/`$lt` 可用，可少扫节点；需要确认索引 + 比较规则。
6. **零向量 hybrid** — 全 0 向量时扩散/余弦几乎无意义，这是我们没用 embedding，不是引擎 bug。

对标 OpenViking 仍不做。本地 embedding 仍后置。

---

## 13. 验收（P0 + P1）

1. 不装 Python、不另开端口；双击现有 DSH 启动脚本后插件已挂载。
2. 会话 A 记下「本仓库鉴权走 header X」并连到仓库实体；新会话 B 中 `ctx_find("鉴权")` 命中，且路径含该实体。
3. 闲聊与一次性改文件指令**不**变成 preference。
4. session-start 短地图 ≤400 token；默认 pre-step 不再塞记忆全文。
5. Trajectory 能看到 `dsh-trivium` 注入来源。
6. TDB 打不开或抽取失败时，对话仍可用。
7. Settings 能归档错误条目，之后 find 不再返回。

---

## 14. 目录与发行

代码**不**放进 `DeepSeek_Harness/dsh-extra/plugins/`。本仓库即插件本体，测试时 junction 到 DSH web profile。

```
dsh-trivium/                    # GitHub QWQcool/dsh-trivium
  package.json                  # name: dsh-trivium  version 0.4.1  MIT
  cordis.patch.yml
  lib/index.js
  lib/store.js
  lib/schema.js
  lib/embed.js                  # optional remote embedding
  lib/settings.js               # ~/.dsh/trivium.json
  lib/tools.js
  lib/extract.js
  lib/markdown.js               # MEMORY.md export, WorkBuddy one-shot import
  lib/client.js                 # Settings
  lib/server.js
  scripts/link-dsh.mjs
  scripts/p2-cases.mjs
  scripts/smoke-p3.mjs
  scripts/smoke-p4.mjs
  scripts/smoke-p5.mjs
  scripts/smoke-p6.mjs
  PLAN.md
  PLAN-session-map.md           # 会话图（情节方框 + 芯片）
  README.md
  LICENSE
```

加载：

```sh
cd dsh-trivium
npm install
node scripts/link-dsh.mjs
```

然后重启本地 DSH web，选工作区即可。记忆文件在 `<workspace>/.dsh/trivium.tdb`。

---

## 15. 风险

| 风险 | 应对 |
|---|---|
| DSH 预览破 API | exact pin rc.8；注入只用官方构造器 |
| triviumdb napi 与 Node 版本 | 与 DSH 要求的 Node（`^22.19` 或 `>=24`）对齐并在 Windows 实测 |
| embedding 成本/失败 | 允许无向量退化；抽取低频（compaction 时） |
| 脏记忆被稳定召回 | 白名单抽取 + 人可归档 + 默认少注入 |
| 做成又一个 dsh-memory | 坚持四工具、图路径、短地图；命名不叫 memory |
| 范围膨胀到 Mnemon UI | P3 门闩：P1 验收未过不做工作台 |

---

## 16. 开工顺序（P0）

1. GitHub 建 MIT 仓库 `dsh-trivium`；Desktop 克隆/对应目录存放代码与 `PLAN.md`。
2. 插件骨架：`package.json`、`cordis.patch.yml`、`apply(ctx)`、四个工具接 TDB。
3. `agent/session-start` 注入短地图。
4. **做到工具可调用后**：`node scripts/link-dsh.mjs` 让本机 DeepSeek_Harness 加载，手工「A 记、B 找」。
5. P0 完成后再写 `extract.js` 与 Settings，不要并行铺 UI。
