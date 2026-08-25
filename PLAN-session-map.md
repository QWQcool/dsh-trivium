# 会话图（Session Map）规划

> 挂在芯片标签下的**可选情节层**：把 DSH 已有的 compaction 检查点与 fork 谱系画成横向方框图。  
> 状态：**默认关。** 须先在 Settings 打开「芯片标签」，再打开其下的「会话层」。标题栏标签叫 **芯片**（`conversation.view`，`id: chips`），不是「会话图」。内核仍是四工具 + 短地图；本面不替代压缩，不新建聊天窗口。  
> 宿主：`@deepseek-ai/dsh@0.1.1-rc.2`（兼 `0.1.0-rc.8`）。  
> 主规划仍是 [`PLAN.md`](./PLAN.md)。本文只覆盖会话层；与主规划冲突时以主规划的内核规则为准。

---

## 1. 一句话

芯片标签默认关。打开后用来钉选记忆片段。会话层（方框 / 检查点 / 分叉画布）再嵌一层开关，默认关；压缩仍由 DSH 做。

---

## 2. 是什么 / 不是什么

### 2.1 是什么

- **情节图**：时间顺序上的会话分段（检查点 + 当前尾部），可分叉。
- **记忆芯片**：未归档的 preference / decision / entity（experience 不进列表）。勾选钉进当前会话下一轮；芯片条可新增、批量归档 / 删除。改名 / 合并仍走 Settings。
- **主入口**：Settings 打开「芯片」后，会话标题栏「对话 / 轨迹」旁出现第三个标签 **芯片**（`conversation.view`，`id: chips`，`order: 20`）。会话层画布默认不画。

### 2.2 不是什么

- 不是记忆编辑器、不是 Mnemon 工作台、不是 Settings 里的无限画布。
- 不是第二套压缩引擎。不按消息条数 / 256k 再切方框。
- 不是「总结完就新开一个聊天窗口」。fork 走 DSH `session.fork`，子会话出现在侧边栏，输入框仍在当前壳里。
- 不加第五工具。`ctx_find` / `ctx_read` / `ctx_remember` / `ctx_link` 不动。

### 2.3 和内核的关系

| 层 | 谁拥有 | 图上长什么样 |
|---|---|---|
| 情节 | DSH compaction + fork；我们投影 | 中间横向方框 + 连线 |
| 语义 | 现有 `.tdb` 节点和边 | 顶上可选芯片 |

两套图分开画，不揉成一张「记忆图谱」。

抽取规则不变：对话原文仍不进长期记忆。`episode` 只存检查点摘要、切点 seq、会话 id，当情节索引，不当 preference。

---

## 3. 方框到底图什么

同一条直线上切方框，按价值是：

1. **检查点** — 标出 DSH 已经把更早原文从模型窗口里换成摘要的位置。
2. **fork 切点** — 点这个方框 = 从该检查点对应的已完成轮次末尾开分支。
3. **导航** — 点方框可跳回「对话」里对应的压缩检查点（第一刀可后置，fork 优先）。

方框**自己不压缩**。质量提升来自 DSH 已经做的 `surfaceOp: replace`。我们不在 fork 后再总结一遍，避免叠两层摘要。

### 3.1 直线（同会话，未 fork）

```
方框1（被压缩的前缀） ──compaction──► 方框2（当前尾部，还在聊）
```

模型实际看到的是：`[方框1 的摘要检查点] + [保留尾部] + [方框2 的新轮次]`。  
人在「对话」页仍能翻到原文（折叠标记）。没压过就只有一个「当前」方框。

### 3.2 分叉（从某方框 fork）

DSH `session.fork({ sessionId, atSeq })` 把切点之前已完成的前缀拷给子会话，包括当时窗口里已经压缩过的摘要。子会话不是空白窗，我们也**不再写第二份总结**。

```
方框1 ──continues──► 方框2（同一会话）
   │
   └──forks_from──► 方框2′（子会话；切点 = 方框1 的 atSeq）
```

### 3.3 什么时候出现新的历史方框

| 触发 | 行为 |
|---|---|
| `compaction/end` 且无 error | 收成一个历史方框（摘要来自对应 `compaction/summary`） |
| 尚无 compaction | 只有「当前」方框 |
| 人点「生成检查点」 | 把当前「后续」收成左边一格（`atSeq` = 对话最新轮次）；不调用 DSH 压缩 |
| 人点「更新检查点」 | 把当前对话里已有的压缩标记 + 侧边栏 fork 谱系投影进图（旧会话补洞；幂等） |
| 插件自定条数 / token 阈值 | **不做自动切** |

---

## 4. 芯片：即插即用，不是「下一个方框才生效」

勾选写入的是**当前会话的钉选列表**。下一轮模型请求（`agent/pre-step`）注入钉选条目的 L0，不需要等 compaction，也不需要 fork。

| 操作 | 生效时机 |
|---|---|
| 勾上某条记忆 | 当前这段里你再发的**下一条**带上它 |
| 取消勾选 | 再下一轮不再带 |
| 新增 | 点一次写入一条；整段粘贴也是一条，并钉选当前会话 |
| 选择 → 归档 / 删除 | 归档软删除；删除从 `.tdb` 去掉 |
| 已经发出去的轮次 | 不回写 |

约束：

- 短地图照旧在 `session-start` 自动带（热记忆，不占芯片位）。
- 芯片默认**不全勾**。
- 钉选注入单独预算 **≤300 token**；超出按勾选顺序截断，UI 提示「已截到预算」。
- 与现有注入三选一（关 / autoRecall / 实体名折中）**并存**：钉选是白名单，三选一是自动召回；钉选优先占预算，自动召回吃剩余（第一刀若实现冲突，先只做钉选 + 短地图，三选一逻辑不删）。
- 归档节点从芯片列表消失，已钉选的自动剔除。

---

## 5. 入口与交互

### 5.1 入口（已选定）

| 位置 | 第一刀 |
|---|---|
| 图 3 · 轨迹旁边 | **主入口**：`conversation.view` 标签「会话图」 |
| 图 3 · 标题栏空白 | 不做（后期可加切到本标签的小按钮） |
| 图 3 · 新会话下面 | 不做 |
| 图 2 · Trivium 记忆旁 | 不做。Settings 仍只管库、归档、开关 |

`package.json` 的 `dsh.client.inject` 需加上 `@deepseek-ai/dsh-client-ui-conversation`（声明 `conversation.view` 的包），现有 `dsh-client-ui-settings` 保留。

### 5.2 画布

- 横向布局：左 → 右为时间。
- 滚轮缩放整体；按住空白拖动画布（第一刀用 CSS transform，不做完整无限画布引擎）。
- 底栏左右滑条预览会话长度：**第一刀不做**，有横向滚动即可。
- 当前方框有描边；历史方框显示摘要前两行 + 相对时间。

### 5.3 Fork：两种交互并存，主路径在我们的图上

| 方向 | 谁先动 | 第一刀 |
|---|---|---|
| **主路径** | 画布点历史方框 → `useSessions().fork({ sessionId, atSeq })` → 打开子会话 → 图上长出分支 | 做 |
| **并存** | 人在对话气泡上用 DSH 自带 fork → 我们读谱系把分支画上 | 做（薄：只同步，不抢主按钮） |

点「当前」方框：fork 到最后一个已完成轮次（与 DSH 省略 `atSeq` 一致）。进行中的开放轮次不可切，失败则提示，不造假节点。

fork 后**不**二次总结切点前的内容。

---

## 6. 数据模型

在现有五类节点之外增加情节类型。find / 短地图 **默认不收录** `episode`（避免把检查点摘要当成长期偏好召回）。

### 6.1 节点 `episode`

```json
{
  "type": "episode",
  "sessionId": "…",
  "compactionId": "…",
  "atSeq": 124,
  "summary": "本段：鉴权改为 header X，并修了登录超时。",
  "kind": "checkpoint | tail | fork",
  "status": "active",
  "createdAt": "…",
  "uri": "ctx://episode/<sessionId>/<atSeq>"
}
```

- `checkpoint`：一次成功的 compaction。
- `tail`：该会话尚未压缩的当前尾部（可每会话至多一个，compaction 后再写新 tail）。
- `fork`：因子会话诞生而记下的切点投影（若与 checkpoint 同一 `atSeq` 则复用，不双写）。

### 6.2 边

| label | 含义 | 权重 |
|---|---|---|
| `continues` | 同会话：检查点 → 下一段 | 0.4 |
| `forks_from` | 子会话头 → 切点方框 | 0.6 |

不把 `continues` / `forks_from` 算进 `BUSINESS_EDGES`（`about` / `decided` / `broke` / `fixed`）。`ctx_find` 默认不沿这两条扩。

### 6.3 钉选（不进图）

存在 `~/.dsh/trivium.json` 的 `pinsBySession`：

```json
{
  "pinsBySession": {
    "<sessionId>": ["<nodeId>", "<nodeId>"]
  }
}
```

按会话隔离。工作区切换不串名单。第一刀不做跨会话继承芯片；fork 出的子会话名单为空，人在新分支上自己勾。

---

## 7. 宿主钩子（只接，不替换）

| 钩子 / API | 我们做什么 |
|---|---|
| `compaction/end`（无 error） | 写入 / 更新 `episode` checkpoint；刷新该会话 tail |
| `compaction/summary` | 取摘要正文（没有则方框只显示「已压缩」） |
| `agent/pre-step` | 注入当前会话钉选 L0（≤300 token） |
| `agent/session-start` | 短地图照旧；确保该会话有 tail episode |
| `session.fork` | 画布主路径调用；成功后写 `forks_from` 并 `open(childId)` |
| 会话列表谱系（parent / 边界 seq） | 同步原生 fork 进图 |

失败不挡主循环：写 episode / 注入钉选失败只打日志。

---

## 8. 分期

### 第一刀 — 可看见、可 fork、可钉选（开工目标）

1. `conversation.view` 标签「会话图」。
2. 只读图画：每个成功 compaction 一个历史方框 + 当前 tail 方框；横向；滚轮缩放。
3. 点历史方框 → `session.fork`；点当前方框 → fork 最后一个已完成轮次。
4. 原生 fork 出现时图上补分支。
5. 顶上芯片：列出未归档的 preference / decision / entity（experience 第一刀可先不进芯片，避免太吵）；勾选 ↔ `pinsBySession`；`pre-step` 注入。
6. `episode` 入 schema / store；find 与短地图排除。
7. 离线 smoke：episode 写入、find 不命中 episode、钉选列表读写截断到 300 token。

### 第二刀 — 图画好用

- 点方框跳到对话页对应检查点。
- 芯片可搜、可按「当前方框邻居」预勾建议（仍默认少勾）。
- 底栏滑条；分叉后自动把视角滚到新分支。
- fork 子会话可选「继承父会话钉选」（默认关）。

### 第三刀 — 打磨主交互

- 画布上的 fork 成为明显主按钮；对话页原生 fork 仍同步进图。
- 方框标题可人手改（只改 episode.name，不动 DSH 摘要）。
- 与轨迹页的 inspect 互跳（可选）。

仍不做：插件自定压缩阈值、新聊天窗口、Settings 画布、第五工具、默认 autoRecall、Mnemon 工作台。

---

## 9. 文件

拟新增 / 改动（第一刀）：

```
PLAN-session-map.md          # 本文
lib/schema.js                # NODE_TYPES + continues/forks_from
lib/episode.js               # compaction → episode；谱系同步
lib/pins.js                  # pinsBySession 读写 + 注入文本
lib/index.js                 # pre-step 钉选；compaction 写 episode
lib/settings.js              # 持久化 pinsBySession
lib/store.js                 # find/短地图跳过 episode
lib/server.js                # GET/POST /api/dsh-trivium/map 、 /pins
lib/client.js                # 保留 Settings；另注册 conversation.view
package.json                 # client.inject 增加 ui-conversation
scripts/smoke-p7.mjs         # episode + pins 离线锁
```

客户端若 `client.js` 继续膨胀，第一刀仍可写在同一文件后部（与 Settings 一样的 ModuleLoader 工厂）；第二刀再拆 `lib/session-map-view.js`。

---

## 10. 验收（第一刀）

钉 `@deepseek-ai/dsh@0.1.1-rc.2`（兼 rc.8）。同一 `.tdb` 不要被两个 Node 进程同时打开。

1. 会话标题栏「对话 / 轨迹」旁出现 **会话图**；点开是横向画布，不是 Settings。
2. 从未压缩的会话：只有一个当前方框。
3. 发生一次成功 compaction 后：左边历史方框（有摘要或「已压缩」）+ 右边当前方框。
4. 点历史方框：侧边栏出现子会话，图画布出现分叉；对话窗口不另弹一层。
5. 在对话页用原生 fork：刷新 / 切回会话图能看到对应分支（允许需手动刷新一次，第一刀不强制直播）。
6. 勾选芯片后发一条用户消息：Trajectory 能看到 `dsh-trivium` 来源的钉选注入；取消勾选后再发则不再带。
7. `ctx_find` 不把 episode 当普通记忆命中。
8. 钉选合计超 300 token 时截断，对话仍可用。
9. TDB / 注入失败时对话仍可用。
10. 四个工具、短地图、Settings 列表行为与 v0.3.0 相比不回退。

---

## 11. 风险

| 风险 | 应对 |
|---|---|
| `conversation.view` 拿不到 `forkAt` | 用会话标准工具包 `useSessions().fork`，与聊天页注入的 `forkAt` 解耦 |
| 图谱做成记忆工作台 | 芯片只勾选、不在画布上改节点；改错仍走 Settings |
| 钉选 + autoRecall 叠预算 | 钉选优先；第一刀可暂时忽略 autoRecall 的叠加，只保证钉选 ≤300 |
| episode 污染 find | 类型排除 + 边不进 BUSINESS_EDGES |
| 和主规划「不做图谱」打架 | 本文是情节图，不是记忆图谱；主规划 §11/§12 改为指向本文 |
| DSH fork 要求切点在已完成轮次 | 开放轮次禁用 fork 并提示 |

---

## 12. 开工顺序（第一刀）

1. schema：`episode`、`continues`、`forks_from`；store 排除 find/短地图。
2. `episode.js` + 在现有 `compaction/end` 钩子上写 checkpoint / tail。
3. `pins.js` + settings 持久化；`pre-step` 注入钉选。
4. server：map 快照 API（当前工作区各会话的 episode 树）+ pins API。
5. client：注册「会话图」标签；横向方框；滚轮缩放。
6. 画布点击 → `session.fork`；谱系同步。
7. `scripts/smoke-p7.mjs` 锁 episode 排除与 pins 截断。
8. 手工：本机 DSH web 压一次上下文或 `/compact`，看方框；点方框 fork；勾芯片发一条看 Trajectory。

不要并行铺第二刀滑条、跳转对话、芯片预勾。
