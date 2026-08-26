# dsh-trivium — DSH 进程内图记忆

<p align="center">
  <img width="820" alt="dsh-trivium 封面" src="docs/cover.png">
</p>

DeepSeek Harness 的进程内图记忆插件：按节点和边记，默认少注入，设置页可改可归档。内核贴近 DSH：不另起进程、默认不加导航。要钉住某些记忆片段，再在设置里打开 **芯片** 注入；情节画布是可选的自嗨层，嵌在芯片开关下。每个工作区一个 `.dsh/trivium.tdb`，不另起服务。

> **快速安装**：`dsh plugin --profile web add dsh-trivium` → 重启 **dsh web** → 打开工作区（设置里出现「Trivium 记忆」；标题栏 **芯片(记忆白名单)** 默认关）。完整步骤见 [安装](#安装)。

[**English**](README.md) | [中文版](README.zh-CN.md)

---

## 安装

> 前提：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 并至少启动过一次 `dsh web`。当前测试宿主：`@deepseek-ai/dsh@0.1.1-rc.2`（`dsh-llm` / `dsh-tools` peer 兼容 `0.1.0-rc.8` 与 `0.1.1-rc.2`）。

```sh
dsh plugin --profile web add dsh-trivium
```

重启 **dsh web** 后生效。记忆文件在当前工作区：

```
<workspace>/.dsh/trivium.tdb
```

用 [Dsh_BatStart](https://github.com/QWQcool/Dsh_BatStart) 的，双击启动就会装上，不必再执行上面这条。

本地跟源码联调：

```sh
npm install
node scripts/link-dsh.mjs
```

然后重启 `dsh web`。

## 更新

```sh
dsh plugin --profile web add dsh-trivium
```

装完重启 **dsh web**。源码联调则在仓库里 `git pull` 后再跑一次 `node scripts/link-dsh.mjs`。

## 卸载

先停掉 **dsh web**，避免 `.tdb` 被占用，然后：

```sh
dsh plugin --profile web remove dsh-trivium
```

`remove` 会删掉本插件的文件：`~/.dsh/trivium.json`，以及它打开过的每个工作区里的 `.dsh/trivium.tdb` 和 `trivium-pending.json`。`.dsh/` 下其它文件不动。用 `dsh plugin add dsh-trivium` 升级**不会**清记忆。

然后再重启 **dsh web**：设置里不再有「Trivium 记忆」，标题栏不再有「芯片(记忆白名单)」，四个工具不再注册。

从未用本版打开过的工作区，可能还留着旧 `.tdb`；看到就手动删那个文件。只想停用、不卸载（数据还在）：在该 profile 的 `cordis.patch.yml` 里加：

```yaml
- id: dsh-trivium
  disabled: true
```

再重启 `dsh web`。

## 权限与数据

插件随 `dsh web` 进程加载，不另起端口、不另起服务。

| 访问 | 默认 | 说明 |
|---|---|---|
| 工作区 `.dsh/trivium.tdb` | 读写 | 记忆库。同一文件不要两个 Node 进程同时打开 |
| `~/.dsh/trivium.json` | 读写 | 设置和芯片钉选；可含你手填的 embedding API key |
| `.dsh/trivium-pending.json` | 读写 | 抽取失败时的本地队列 |
| 网络 | 关 | 对话不外发。打开 embedding 并填了 URL 才会把被检索文本发到你填的地址。设置页点「检查更新」会请求 npm registry（只拿版本号，不含对话） |
| 对话原文 | 不外发 | 抽取和检索都在本机；embedding 开启后，被检索的文本会发到你填的地址 |

官方 DeepSeek 对话接口没有 embeddings。不开 embedding 也能用：关键词 + 图遍历。改完设置或 embedding 后需重启 `dsh web`。

## AI 时代安装

把下面这句话复制给助手即可：

```text
请在 DeepSeek Harness 上执行：dsh plugin --profile web add dsh-trivium
然后重启 dsh web。设置里会出现「Trivium 记忆」。标题栏标签叫「芯片(记忆白名单)」，默认关；在设置「Trivium 记忆」里打开即可，拨一下就保存，不必再重启。
```

---

## 默认安静的图记忆

Trivium 是记忆内核，不是日记、日历或聊天伴侣。它按**节点和边**记，默认少注入，记错了人能改。

- **跨会话** — 会话 A 记下「鉴权走 header X」，会话 B 调用 `ctx_find("鉴权")` 命中，并带上它连着谁（`about` / `decided` / `broke` / `fixed`）。
- **默认安静** — 新会话只注入一张短地图（≤400 token）。模型要用再调工具，不会每一步灌满。标题栏默认也不加第三标签。
- **芯片 / 记忆白名单（默认关）** — 设置里打开后，标题栏「对话 / 轨迹」旁出现 **芯片(记忆白名单)**（以前叫「会话图」）。拨一下即写入 `~/.dsh/trivium.json`，重启后仍保持。勾选的条目从下一轮注入（L0，≤300 token）。其下还有 **会话层**（也默认关）：把 compaction / 分叉画成方框。
- **人能改错** — 芯片条可新增、归档、删除；设置页管搜、改名 / 正文、合并、导入导出、全局开关。
- **抽取偏严** — 闲聊、一次性改文件、密钥**不会从对话自动入库**。芯片「新增」按你写的存（点一次整段一条），同样过写入卫生闸门。
- **写入卫生** — `ctx_remember`、芯片新增、抽取、外部导入会拒绝乱码、复读、JSON envelope、base64 残骸和密钥。已经进 `.tdb` 的脏节点仍可在设置里看见以便归档；find / 短地图 / 芯片不再带它们。
- **可选 embedding** — 默认关。官方 DeepSeek 对话接口没有 embeddings；可填 OpenAI 兼容地址。不开也能用：关键词 + 图遍历。

### 底层工程

- **进程内、一个文件** — TriviumDB（向量 + JSON payload + 有向带权图）随 DSH 进程打开。不另起 HTTP / Python 服务。
- **只有四个工具** — `ctx_find` / `ctx_read` / `ctx_remember` / `ctx_link`。芯片 / 会话层不加第五个。
- **注入走 `agent.inject()`** — 不写 system prompt，避免 `persona.complete: true` 把地图静默丢掉。
- **召回带路径** — 每条命中都说明从哪个节点、沿哪条边过来。
- **失败不挡主循环** — 存储 / embedding / 抽取出错只记日志，Agent 继续。
- **界面跟随宿主语言** — 设置页和「芯片(记忆白名单)」标签随 DSH `locale/change` 切换（`zh` / `en`）。
- **首轮短地图** — 每个会话只注入一次。若 `session-start` 和第一步赛跑输了，`pre-step` 会补上；不会每步重写（前缀缓存友好）。

## 功能

### 跨会话图

节点类型是 `entity` / `preference` / `decision` / `experience`。业务边是 `about`、`decided`、`broke`、`fixed`。

`ctx_find` 返回 L0 摘要和图路径（入边写成 `<-label-id`）。查询点到已有实体名时，还会带上未过期的 about/decided/broke/fixed 邻居，即使邻居正文不含查询词。带 `until` 的过期决策默认不出现，除非查询本身在问期限（如「周五」）。

### 芯片（记忆白名单）

默认关。在设置里打开 **芯片（记忆白名单）**：不必再点「保存设置」，也不必重启。标题栏立刻出现 **对话 / 轨迹 / 芯片(记忆白名单)**，选择写入 `~/.dsh/trivium.json`，重启后仍在。这是钉选白名单，不是记忆编辑器；改名、合并、全局开关仍走设置页。

列出未归档的 preference / decision / entity（experience 不进芯片）。勾选后从下一轮注入（L0，≤300 token）。条上可新增、归档、删除。

| 操作 | 生效时机 |
|---|---|
| 勾上某条 | 当前这段里你再发的**下一条**带上它（L0，≤300 token） |
| 取消勾选 | 再下一轮不再带 |
| 新增 | 点一次写入一条；整段粘贴也是一条 |
| 选择 → 归档 | 软删除：find / 短地图 / 芯片不再出现，节点还在 `.tdb` |
| 选择 → 删除 | 从 `.tdb` 去掉，不可恢复 |
| 已经发出去的轮次 | 不回写 |

芯片按会话隔离。新开会话、fork 出的子会话默认都不勾。短地图仍在 session-start 自动带，不占芯片位。

其下 **会话层** 也默认关。打开后，同一标签里画出 compaction / 分叉方框（生成检查点、更新检查点、从方框 fork）。`episode` 不进 `ctx_find`。关掉会话层就停止写检查点，已有节点仍在 `.tdb`。

### 设置页（Trivium 记忆）

设置里的「Trivium 记忆」管库，也管这两层可选表面。开关拨一下就写入 `~/.dsh/trivium.json`。

| 开关 | 默认 | 作用 |
|---|---|---|
| **芯片（记忆白名单）** | 关 | 标题栏「对话 / 轨迹」旁的标签。勾选的芯片是下一轮注入白名单（L0，≤300 token）。 |
| **会话层** | 关（要先开芯片） | 同一标签里的情节画布：生成检查点、更新检查点、从方框分叉。 |
| **注入策略** | 关 | 只有开场短地图；可改 autoRecall 或实体名折中。 |
| **抽取** | 开 | compaction / 空闲后写入。 |
| **embedding** | 关 | 要填 URL 并点「保存设置」，改 URL 后重启。 |

注入细节：autoRecall 在本步含用户文本时最多灌 3 条 L0；实体名折中只在话里点到已有实体时灌 1 跳业务边邻居。芯片钉选优先占预算。抽取失败进 pending，下次 session-start 重放（每批正文 ≤3000 字、最多 24 条）。

- **条目** — 可搜、按类型筛、展开业务边邻居、「只看挂在这上面的」、默认隐藏过期决策。可改名 / 改正文 / 别名 / until，同类型合并，归档或删除。
- **导出导入** — JSON 是真回写。Markdown 只读投影（给人看、给 git 看），不能再解析回去。WorkBuddy `MEMORY.md`、Claude Code `CLAUDE.md`、Codex `AGENTS.md` 可一次性严导入。不持续同步，不导入会话 jsonl。
- **检查更新** — 设置页对比已装版本和 npm latest，有新版时给出 `dsh plugin --profile web add dsh-trivium`。不会在后台自动升级。

### 四个工具

| 工具 | 说明 |
|---|---|
| `ctx_find` | 检索，返回 L0 摘要和图路径（含入边 `<-label-id`）。查询点到已有实体名时，还会带上未过期的 about/decided/broke/fixed 邻居。带 `until` 的过期决策默认不出现，除非查询本身在问期限（如「周五」） |
| `ctx_read` | 按 id 读全文和入边 |
| `ctx_remember` | 手动写入 |
| `ctx_link` | 两点之间建有向边 |

内核仍是这四个。芯片 / 会话层不加第五个工具。

---

## 界面截图

以下入口在本机 DSH Web（`0.1.1-rc.2`）上仍在。截图为中文界面；插件会跟随 DSH 宿主语言（`zh` / `en`）。

### 会话 — `ctx_find("鉴权")`

<img width="560" alt="ctx_find 鉴权" src="docs/screenshots/02-ctx-find.png">

会话开头注入 `dsh-trivium` 短地图；模型调用 `ctx_find`，命中「本仓库鉴权走 header X」。

### 轨迹 — 上下文注入可见

<img width="560" alt="轨迹" src="docs/screenshots/03-trajectory.png">

### 设置 — 注入策略

<img width="560" alt="设置" src="docs/screenshots/04-settings.png">

### 设置 — 记忆条目

<img width="560" alt="条目列表" src="docs/screenshots/05-settings-list.png">

### 芯片(记忆白名单) — 可选，在对话 / 轨迹旁

<img width="560" alt="芯片 / 会话层" src="docs/screenshots/06-session-map.png">

默认关。设置里打开 **芯片(记忆白名单)** 后，标题栏立刻出现该标签。若同时打开 **会话层**，没压过的会话只有一个「后续」方框；顶部是记忆芯片（默认不勾）。可点「生成检查点」把后续收成左边一格。compaction 或 `/compact` 之后左边也会出现历史方框，分叉从方框连到子会话。

---

## 限制

- 模型不调 `ctx_find`、也不勾芯片时，窗口里主要是开场短地图。
- 抽取会漏；脏数据可在芯片条归档 / 删除，或到设置里改、合并。
- 同一个 `.tdb` 不要两个 Node 进程同时打开（正常只开一个 `dsh web` 即可）。
- Markdown 导出是给人看的，不能再解析回去。外部导入（WorkBuddy / Claude Code / Codex）是一次性，不是双向同步，也不会吃会话 jsonl。
- 会话层打开时只投影 compaction 与 fork，不会按消息条数自己切方框。窗口没到 DSH 压缩线时，「更新检查点」也补不出历史方框；要分段请点「生成检查点」。
- 芯片 / 会话层 / 注入 / 抽取开关拨一下即保存。Embedding URL 仍要点「保存设置」。只有设置页本身没出现时才需要重启 `dsh web`。
- 宿主升到 rc.8 后，DSH 自己的旧会话库可能打不开（官方 SQLite 格式不兼容）。工作区里的 `.tdb` 图记忆还在；对不上号的旧情节方框可以当残留，不影响 `ctx_find`。

---

## 更新说明

**0.4.11** — 标题栏标签改为 **芯片(记忆白名单)**（不再叫「会话图」）。开关拨一下即写入 `~/.dsh/trivium.json`；标签立刻出现或消失，不必重启。

**0.4.10** — `dsh plugin remove` 会删掉已知工作区的 `.tdb` 和 `~/.dsh/trivium.json`。升级安装不清记忆。配置里 disabled 仍保留数据。

**0.4.9** — 芯片标签和会话层画布都默认关。设置里打开芯片后标题栏才出现「芯片」；情节方框嵌在其下。内核（四工具、短地图、进程内 `.tdb`）不变。

**0.4.8** — 写入 + 注入卫生闸门（密钥、乱码、复读、JSON envelope、base64 残骸）。设置页 / 芯片标签跟随 DSH 语言。设置页可检查 npm 更新。一次性严导入同时发现 Claude Code `CLAUDE.md` 与 Codex `AGENTS.md`。若 `session-start` 和第一步赛跑，首轮短地图仍会补上。

**0.4.7** — 存储升到 `triviumdb@0.7.6`（引擎侧 `searchExact` / `searchBatch`）。find / 芯片标签行为不变。

**0.4.6** — 芯片标签可「生成检查点」：把当前「后续」收成左边一格。不触发 DSH 压缩。

**0.4.5** — 宿主 peer 放宽到 `0.1.0-rc.8` 与 `0.1.1-rc.2`，不再嵌一套旧 `dsh-llm` / `dsh-tools`。

**0.4.4** — 依赖 `triviumdb@0.7.5`：入边、按 label 扩邻、按 label 删边走引擎 API，不再全表扫边。find / 芯片标签行为不变。

**0.4.3** — 芯片标签「更新检查点」：把当前对话里 DSH 已有的压缩标记和侧边栏 fork 补进图，给装插件之前的旧会话用。没压过的会话仍然只有「后续」。

**0.4.2** — 芯片条可新增（整段粘贴一条）、批量归档 / 删除。自动抽取仍偏严；芯片新增按你写的入库。

**0.4.1** — 宿主钉到 `@deepseek-ai/dsh@0.1.0-rc.8`。功能与 0.4.0 相同。已在 rc.8 上确认：设置「Trivium 记忆」、新会话短地图、跨会话 `ctx_find`、标题栏标签（现为芯片）。

**0.4.0** — 标题栏标签、记忆芯片、从检查点 fork。

## 排障

| 现象 | 处理 |
|---|---|
| 设置里没有「Trivium 记忆」 | 确认装的是 web profile，然后**重启** `dsh web`，再打开一个工作区。只刷新浏览器不够。 |
| 标题栏没有「芯片(记忆白名单)」 | 在设置里打开「芯片（记忆白名单）」（拨一下就会保存）。切回对话页，标签应立刻出现，不用重启。 |
| 改了注入 / 抽取 / embedding / 芯片开关没生效 | 芯片 / 抽取 / 注入拨一下即保存。Embedding URL 仍要点「保存设置」。只有设置页本身没出现时才重启 `dsh web`。 |
| 会话层只有一个「后续」方框 | 正常（在会话层已打开时）。方框跟 DSH 压缩走，会话长不等于已经压过（默认约窗口 80% 才自动压）。要分段：对话里 `/compact`，或点「生成检查点」（只切图，不压窗口）。旧会话可点「更新检查点」补已经发生过的压缩 / 分叉。 |
| `ctx_find` 什么都没有 | 新会话默认只注入短地图，模型要自己调工具。也可以在芯片条「新增」或对模型说「记住：…」。闲聊和一次性改文件不会自动入库。 |
| 报 `.tdb` 被占用 / 打不开 | 只开一个 `dsh web`。不要同时跑两份链接了本插件的 Node 进程。 |
| embedding 填了但检索没变准 | 失败会退回关键词 + 图。看 `~/.dsh/trivium.json` 里 URL 是否 OpenAI 兼容（含 `/v1` 那种）。改完重启。 |
| 卸载后记忆还在 | 先停 `dsh web` 再 `dsh plugin remove`。剩下的 `.tdb` 是从未用 0.4.10 打开过的工作区，到该文件夹删 `.dsh/trivium.tdb`。只在配置里 disabled 不会清文件。 |
| 检查更新失败 | 只请求 npm registry 拿最新版本号，不影响记忆；过一会儿再点即可。 |
| rc.8 之后旧对话打不开 | 那是 DSH 自己的会话库格式变了，不是 `.tdb` 坏了。图记忆仍可 `ctx_find`；对不上号的旧方框可当情节残留。 |

本地联调：仓库里 `npm install` 后 `node scripts/link-dsh.mjs`，再重启 `dsh web`。`triviumdb` 是原生模块，装不上时先看 Node 是否满足 `package.json` 的 `engines`（`^22.19.0 || >=24`）。

---

## 发布信息

- GitHub: https://github.com/QWQcool/dsh-trivium
- npm: [`dsh-trivium@0.4.11`](https://www.npmjs.com/package/dsh-trivium)
- 测试宿主：`@deepseek-ai/dsh@0.1.1-rc.2`（兼 `0.1.0-rc.8`）
- License: MIT（依赖 [TriviumDB](https://github.com/YoKONCy/TriviumDB) 为 Apache-2.0）

---

## 致谢

写入卫生闸门、npm 检查更新、跟随宿主语言的界面，以及 Claude Code / Codex 文件发现，部分借鉴自 [dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory)（Aik358）。产品仍是图内核（节点、边、四个工具、默认安静），不是日记 / 日历伴侣。
