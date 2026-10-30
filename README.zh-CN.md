# dsh-trivium — DSH 进程内图记忆

<p align="center">
  <img width="820" alt="dsh-trivium 封面" src="docs/cover.png">
</p>

DeepSeek Harness 的进程内图记忆插件：按节点和边记，默认少注入，设置页可改可归档。内核贴近 DSH：不另起进程、默认不加导航。要钉住某些记忆片段，再在设置里打开 **芯片** 注入；情节画布是可选的自嗨层，嵌在芯片开关下。每个工作区一个 `.dsh/trivium.tdb`，不另起服务。

> **快速安装**：`dsh plugin --profile web add dsh-trivium` → 重启 **dsh web** → 打开工作区（设置里出现「Trivium 记忆」；标题栏 **芯片** 默认关）。完整步骤见 [安装](#安装)。

[**English**](README.md) | [中文版](README.zh-CN.md)

---

## 安装

> 前提：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 并至少启动过一次 `dsh web`。当前使用 Web `0.2.1-rc.4` 验证；桌面 `0.2.1-rc.3` 的验证层级和局限见[文档入口](docs/README.md)。Node 要求 `^22.19.0 || >=24`，内核精确锁定 `triviumdb@0.9.0-beta.3`。

```sh
dsh plugin --profile web add dsh-trivium
```

重启 **dsh web** 后生效。记忆文件在当前工作区：

```
<workspace>/.dsh/trivium.tdb      # 本地索引（二进制，建议 gitignore）
<workspace>/.dsh/trivium.jsonl    # 可选 Git 交换快照（业务事实）
<workspace>/.dsh/consumer-preferences/ # 可选的授权偏好绑定与导出快照
```

把 `trivium.jsonl` 交给 git。二进制库不要进版本库：

```gitignore
.dsh/trivium.tdb
.dsh/trivium.tdb*
.dsh/trivium-pending.json
.dsh/consumer-preferences/
.dsh/trivium-changes.jsonl
```

clone / `git pull` 后若 jsonl 变了会自动导回。设置里 **Git 旁路** 默认关（和芯片一样）。在「检查更新」下面的 **配置设置** 里打开。开关只控制是否自动写出。开着时 **生成** 用当前 `.tdb` 覆盖写出同一路径的 jsonl；关掉后 **删除 jsonl** 会清掉已知工作区的 jsonl（`.tdb` 不动）。情节、向量、芯片钉选仍只留在本机。

用 [Dsh_BatStart](https://github.com/QWQcool/Dsh_BatStart) 的，双击启动就会装上，不必再执行上面这条。

本地跟源码联调：

```sh
npm install
node scripts/link-dsh.mjs
npm test              # 可选：跑全部离线 smoke
```

`npm test` 不需要 DSH 宿主，也不会碰你真实的 `~/.dsh/trivium.json`（每个脚本用独立的临时设置文件）。想只跑一部分就传子串：`npm test -- p8`。

然后重启 `dsh web`。

## 更新

升级前先停止 DSH，备份工作区 `.dsh/trivium.tdb*` 整个文件组。默认 mmap 模式还会使用 `.vec`、`.wal`、`.text` 等附属文件；Git JSONL 不含全部本机数据，不能代替完整备份。

```sh
dsh plugin --profile web add dsh-trivium
```

装完重启 **dsh web**。源码联调则在仓库里 `git pull` 后再跑一次 `node scripts/link-dsh.mjs`。

## 卸载

先停掉 **dsh web**，避免 `.tdb` 被占用，然后：

```sh
dsh plugin --profile web remove dsh-trivium
```

`remove` 会删掉 `~/.dsh/trivium.json`，以及它打开过的每个工作区里的 `.dsh/trivium.tdb*`、`trivium.jsonl*` 和 `trivium-pending.json`。**偏好导出的 `.dsh/consumer-preferences/` 会保留**；源码中尚未发布的变更记录 `.dsh/trivium-changes.jsonl` 也不会由卸载程序删除。如果不再需要，应自行检查并清理这些文件，连同导出到其他位置的人设副本。用 `dsh plugin add dsh-trivium` 升级**不会**清记忆。若 `trivium.jsonl` 已提交，`git checkout` 可以找回。

然后再重启 **dsh web**：设置里不再有「Trivium 记忆」，标题栏不再有「芯片」，四个工具不再注册。

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
| 工作区 `.dsh/trivium.jsonl` | 读写 | Git 旁路（默认关）。只含业务节点和边，不含向量 |
| `~/.dsh/trivium.json` | 读写 | 设置和芯片钉选；可含你手填的 embedding API key |
| `.dsh/trivium-pending.json` | 读写 | 抽取失败时的本地队列 |
| `.dsh/consumer-preferences/` | 按需读写 | 授权绑定、偏好快照及人设副本；可能包含已批准的记忆，卸载后保留 |
| `.dsh/trivium-changes.jsonl` | 当前源码按需写入 | 尚未发布的记忆变更记录；卸载后保留 |
| 模型抽取 | 开 | 宿主模型服务可用时，通过 DSH 把限长的对话片段交给当前会话选用的 provider/model；远程模型意味着联网和可能的模型费用。没有模型服务时使用本地规则 |
| 远程 embedding | 关 | 开启后，节点正文和查询文本会发送到配置的 embedding URL。不开也可使用关键词和图检索 |
| 检查更新 | 手动触发 | 请求 npm 包元数据，不发送对话 |
| 对话片段 | 可能交给宿主模型 | 长期记忆存储在本地，不等于抽取或 DSH 对话全程离线。关闭抽取和远程 embedding，可停止插件主动发起的这两类模型／向量调用 |

官方 DeepSeek 对话接口没有 embeddings。不开 embedding 也能用关键词 + 图遍历。开关会保存；embedding 地址、模型和密钥需要点「保存设置」。如果设置保存后仍未生效，重启 `dsh web` 再检查。

## AI 时代安装

把下面这句话复制给助手即可：

```text
请在 DeepSeek Harness 上执行：dsh plugin --profile web add dsh-trivium
然后重启 dsh web。设置里会出现「Trivium 记忆」。标题栏标签叫「芯片」，默认关；在设置「Trivium 记忆」里打开「芯片（记忆白名单）」即可，拨一下就保存，不必再重启。
```

---

## 默认安静的图记忆

Trivium 是记忆内核，不是日记、日历或聊天伴侣。它按**节点和边**记，默认少注入，记错了人能改。

- **跨会话** — 会话 A 记下「鉴权走 header X」，会话 B 调用 `ctx_find("鉴权")` 命中，并带上它连着谁（`about` / `decided` / `broke` / `fixed`）。
- **默认安静** — 新会话只注入一张短地图（≤400 token）。模型要用再调工具，不会每一步灌满。标题栏默认也不加第三标签。
- **芯片 / 记忆白名单（默认关）** — 设置里打开后，标题栏「对话 / 轨迹」旁出现 **芯片**。拨一下即写入 `~/.dsh/trivium.json`，重启后仍保持。勾选的条目从下一轮注入（L0，≤300 token）。其下还有 **会话层**（也默认关）：把 compaction / 分叉画成方框。
- **人能改错** — 芯片条可新增、归档、删除；设置页管搜、改名 / 正文、合并、导入导出、全局开关。
- **抽取偏严** — 闲聊和一次性改文件通常不会从对话自动入库。芯片「新增」按你写的存（点一次整段一条），同样过写入卫生闸门。
- **写入卫生** — `ctx_remember`、芯片新增、抽取、外部导入会拒绝规则可识别的乱码、复读、JSON envelope、base64 残骸和疑似凭据。规则无法识别所有敏感值，不应将其视为完整的秘密保护。已经进 `.tdb` 的脏节点仍可在设置里看见以便归档；find / 短地图 / 芯片不再带它们。
- **可选 embedding** — 默认关。官方 DeepSeek 对话接口没有 embeddings；可填 OpenAI 兼容地址。不开也能用：关键词 + 图遍历。

### 预算与记忆效果

短地图每会话最多 400 估算 token；开启芯片或自动召回后，芯片、召回和更正在每轮共用 300 估算 token，工具可按需读取全文。纯致谢等确认短句不会触发抽取模型。这些预算不包括工具定义、工具返回、模型回答或后台抽取，不能当作整次请求的费用上限。

预算是输出长度的估算，不等于整次请求或账单的上限。历史合成测试的结果和限制见[评测报告](docs/next-memory/COST-QUALITY-RESULTS.md)；不能据此声称真实会话固定省钱或优于其他产品。当前可展示的测试数据见[验证与测试数据](#验证与测试数据)。

### 底层工程

- **进程内、一个文件** — TriviumDB（向量 + JSON payload + 有向带权图）随 DSH 进程打开。不另起 HTTP / Python 服务。
- **只有四个工具** — `ctx_find` / `ctx_read` / `ctx_remember` / `ctx_link`。芯片 / 会话层不加第五个。
- **注入走 `agent.inject()`** — 不写 system prompt，避免 `persona.complete: true` 把地图静默丢掉。
- **召回带路径** — 每条命中都说明从哪个节点、沿哪条边过来。
- **失败不挡主循环** — 存储 / embedding / 抽取出错只记日志，Agent 继续。
- **界面跟随宿主语言** — 设置页和「芯片」标签随 DSH `locale/change` 切换（`zh` / `en`），也可在配置设置里锁定。其它已解析的宿主语言、以及浏览器未命名任何注册语言的情况，一律回落英文（与宿主自己的 `FALLBACK_LOCALE` 一致）。
- **首轮短地图** — 每个会话只注入一次。若 `session-start` 和第一步赛跑输了，`pre-step` 会补上；不会每步重写（前缀缓存友好）。

## 功能

### 跨会话图

节点类型是 `entity` / `preference` / `decision` / `experience`。业务边是 `about`、`decided`、`broke`、`fixed`。

`ctx_find` 返回 L0 摘要和图路径（入边写成 `<-label-id`）。查询点到已有实体名时，还会带上 about/decided/broke/fixed 邻居，即使邻居正文不含查询词。相关的过期决策仍可作为历史返回，标记 `stale` 并降权；设置 `include_stale: false` 可排除过期条目。自动召回和开场短地图仍排除过期决策。

正文中的日期只属于正文。有效期通过设置页或 `ctx_remember` 的独立 `until` 字段指定，支持 `YYYY-MM-DD`、`Friday` / `周五`、`周末`、`下周`，按 UTC 日末解释。无法解析的新标签不会沿用旧 `untilAt`。清空 `until` 会同时移除时间戳，修改为新的相对期限则从本次编辑时计算；仅保存同一期限不会延长它。

0.4.22 不批量删除旧数据的期限。被误标的记忆可重新通过 `ctx_find` 查到，也可在设置里勾选「显示过期决策」找到，清空 `until` 并保存；之后编辑含日期的正文不会再自动生成期限。

### 芯片（记忆白名单）

默认关。在设置里打开 **芯片（记忆白名单）**：不必再点「保存设置」，也不必重启。标题栏立刻出现 **对话 / 轨迹 / 芯片**，选择写入 `~/.dsh/trivium.json`，重启后仍在。这是钉选白名单，不是记忆编辑器；改名、合并、全局开关仍走设置页。

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

设置里的「Trivium 记忆」管库。「检查更新」在最上，**记忆条目**保持可见。其余选项收在 **配置设置** 折叠里（默认收起）：注入、抽取、芯片、Git 旁路、界面语言、导入、embedding。开关拨一下就写入 `~/.dsh/trivium.json`。

| 开关 | 默认 | 作用 |
|---|---|---|
| **芯片（记忆白名单）** | 关 | 标题栏「对话 / 轨迹」旁的标签。勾选的芯片是下一轮注入白名单（L0；与召回共用 300 token）。 |
| **会话层** | 关（要先开芯片） | 同一标签里的情节画布：生成检查点、更新检查点、从方框分叉。 |
| **Git 旁路** | 关 | 图有改动后延迟写入 `.dsh/trivium.jsonl`（格式 v2：含版本关系，不含本机来源）。开着可 **生成**（从当前 `.tdb` 覆盖写出）；关掉可 **删除 jsonl**。clone / pull 会导回。 |
| **界面语言** | 跟随宿主 | 只改本插件设置页和芯片标签的中英文，不改 DSH。 |
| **注入策略** | 关 | 只有开场短地图；可改 autoRecall 或实体名折中。 |
| **抽取** | 开 | compaction / 空闲后写入。 |
| **embedding** | 关 | 要填 URL 并点「保存设置」；保存后仍未生效时可重启宿主。 |

注入细节：autoRecall 在本步含用户文本时取最多 8 条候选，再按剩余共享预算选择 L0；实体名折中只在话里点到已有实体时灌 1 跳业务边邻居。已送达事实的更正先占共享预算，其次是芯片和召回。注入关闭或同轮预算不足时，更正保留并显示原因，不承诺下一条必定送达。后续 pre-step 会检查已送达决策是否自然到期；没有后台计时器，重启会清空投递账本。抽取失败进 pending，下次 session-start 重放（每批正文 ≤3000 字、最多 24 条）。

- **条目** — 可搜、按类型筛、展开业务边邻居、「只看挂在这上面的」、默认隐藏过期决策。可改名 / 改正文 / 别名 / until，同类型合并，归档或删除。
- **导出导入** — JSON 是真回写。Markdown 只读投影（给人看）。给 git 用的是 `.dsh/trivium.jsonl`（业务事实，自动写）。WorkBuddy `MEMORY.md`、Claude Code `CLAUDE.md`、Codex `AGENTS.md` 可一次性严导入。不监视那些文件，不导入会话 jsonl。
- **检查更新** — 设置页对比已装版本和 npm latest，有新版时给出 `dsh plugin --profile web add dsh-trivium`。不会在后台自动升级。

### 来源、历史与召回检查

面板分两个页签，条目详情分三个。

| 位置 | 回答什么 |
|---|---|
| **记忆条目** | 存了什么。已替代的版本默认收起；**显示已替代**与**显示过期**是两个独立开关。 |
| **召回检查** | 上一轮实际注入了什么（按估算 token），外加一次只读检查：候选、真实过滤原因、以及将要发送的原文。 |
| **内容 / 来源 / 决策历史** | 正文、它从哪来、以及替代它的决策链。 |

只有写入时确实记录了来源（`kind`、会话、消息、短引文），条目才知道自己从哪来。没有来源就直说没有，不猜会话也不猜作者；本进程无法确认的会话报「已不可用」，但保留已存的摘录。宿主没有会话定位接口，所以不提供跳转，也不拼一个假的 deep link。

召回检查是只读的：不写库、不跑工具、不请求 embedding。没有查询向量时明确显示语义通道未运行。这些页签不会注入上下文，也不会调用模型。

### 替代一条决策

新决策不会让旧决策「过期」，而是替代它。决策上的**替代…**让你选另一条已有决策，并排展示两条、要求确认。旧正文与期限保留，不归档；之后面板把 **当前版本 / 已被替代** 作为独立一维显示，与 **已过期** 并列。

首版是线性链：每个节点最多一个直接前驱与一个后继，不允许循环，最多 32 跳。写入在服务端按工作区排队校验，并带上两端 ETag，所以另一个窗口用旧视图确认时拿到 409 而不是覆盖。**撤销替代**只删这一条关系，且当下方还有更新版本时拒绝。

链上的正文是已确认的历史：自动抽取、合并、改正文、删除、合并节点都会被拒绝（`REVISION_PROTECTED` / `REVISION_LINKED`）。名称、别名、期限、来源补充仍可改。新说法请新建一条决策，再让它替代旧的。

自动召回只讲当前版本：命中旧正文会前向映射、去重，并带一条短 `matched_history` 指针。你手工钉的旧节点不会被改写，只标为历史并提示可以改钉当前版本。当前版本被归档或过期时，这条链直接不注入，也不会把旧版本复活。

### 四个工具

| 工具 | 说明 |
|---|---|
| `ctx_find` | 文本 / 可选向量 / 图关系检索；返回 L0 和路径。过期历史标记 `stale` 并降权；`include_stale: false` 排除过期条目 |
| `ctx_read` | 按 id 读全文和入边 |
| `ctx_remember` | 手动写入；可用独立 `until` 字段指定真实有效期，不从正文日期推断 |
| `ctx_link` | 两点之间建有向边 |

内核仍是这四个。芯片 / 会话层不加第五个工具。

### 跨会话示例

在隔离的测试工作区中，请助手记住一条合成事实，例如「本项目鉴权走 header X」，再新建会话并询问该项目的鉴权方式；确认轨迹中使用了 `ctx_find`，并检查返回的事实。若还建立了实体和决策之间的关联，可以查看返回的图路径。不要用真实凭据作为示例。[离线可复现示例](docs/guide-example.md)提供无需模型和 DSH 宿主的操作及预期结果；它验证存取和图关系，不代表真实模型一定会调用工具。

### 按授权导出偏好

0.8.2 提供可选的 `dsh-trivium-prefs`：先按工作区、消费方和用途绑定并逐条授权，再导出快照；支持 `status`、`verify` 和 `revoke`。快照最多 8 条、300 估算 token，超限报错而非截断。工具读取记忆库，并将绑定、快照和可选人设副本写到本地，不会连接外部平台；`verify` 需要消费方主动执行，库被占用时部分检查会跳过并标注。

```sh
npx --package=dsh-trivium dsh-trivium-prefs --help
```

命令参数、撤回和已知限制见 [0.8.2 发布说明](docs/release-0.8.2.md)。导出内容可能包含个人偏好，请自行决定存放和共享范围。

---

## 界面截图

以下截图于 2026-10-28 在 DSH Web `0.2.1-rc.4` 与 `dsh-trivium@0.7.1` 上实拍，宿主为中文界面。它们只是界面导览，不是验收证据；分版本证据及当前边界见[文档入口](docs/README.md)。插件默认跟随 DSH 宿主语言；也可在 **设置 → Trivium 记忆 → 配置设置** 里锁定中文或英文。

### 会话 — `ctx_find("鉴权")`

<img width="560" alt="ctx_find 鉴权" src="docs/screenshots/02-ctx-find.png">

会话开头注入 `dsh-trivium` 短地图；模型调用 `ctx_find`，命中「本仓库鉴权走 header X」。

### 轨迹 — 上下文注入可见

<img width="560" alt="轨迹" src="docs/screenshots/03-trajectory.png">

### 设置 — 检查更新、语言、注入策略

<img width="560" alt="设置配置" src="docs/screenshots/04-settings.png">

「检查更新」下面是可折叠的 **配置设置**（本插件语言、注入策略）；再下面分 **记忆条目 / 召回检查** 两个标签。

### 设置 — 抽取、芯片、Git 旁路

<img width="560" alt="设置开关" src="docs/screenshots/05-settings-options.png">

芯片开关下嵌 **会话层（情节画布）**。同一页还有 Git 旁路、Markdown 导出、外部记忆一次性导入、远程 embedding。

### 设置 — 记忆条目

<img width="560" alt="条目列表" src="docs/screenshots/06-settings-list.png">

列表上方是类型筛选、文本搜索和「显示过期决策 / 显示已替代」两个开关；每张卡片自带归档、删除动作。

### 设置 — 召回检查

<img width="560" alt="召回检查" src="docs/screenshots/08-recall-check.png">

**召回检查** 标签显示本轮估算预算、一次查询的只读试算、版本链体检、待发 / 已发更正与最近召回诊断。打开该标签或运行只读试算都不调用模型，也不请求 embedding。

### 芯片 — 可选，在对话 / 轨迹旁

<img width="560" alt="芯片标签" src="docs/screenshots/07-chips.png">

默认关。设置里打开 **芯片（记忆白名单）** 后，标题栏立刻出现 **芯片**。若同时打开 **会话层**，没压过的会话只有一个「后续」方框；顶部是记忆芯片（默认不勾）。可点「生成检查点」把后续收成左边一格。compaction 或 `/compact` 之后左边也会出现历史方框，分叉从方框连到子会话。

---

## 限制

- 模型不调 `ctx_find`、也不勾芯片时，窗口里主要是开场短地图。
- 抽取会漏；脏数据可在芯片条归档 / 删除，或到设置里改、合并。
- 同一个 `.tdb` 不要两个 Node 进程同时打开（正常只开一个 `dsh web` 即可）。现在面板会给出一句可读说明，而不是原始 TDB 错误。
- **支持宽度：900px 及以上。** 390px 时宿主固定保留 188px 设置侧栏，插件内容列只剩约 154px（卡片约 106px），布局会收缩但不可读。本版不声称支持手机宽度。
- Markdown 导出是给人看的，不能再解析回去。能回写进 git 的是 `trivium.jsonl`，不是 Markdown。外部导入（WorkBuddy / Claude Code / Codex）是一次性，不是双向同步，也不会吃会话 jsonl。
- `.tdb` 不要在 git 里合并（二进制）。跟踪 `trivium.jsonl`，忽略 `.tdb`。jsonl 冲突按普通文本解决，再打开工作区即可。
- 会话层打开时只投影 compaction 与 fork，不会按消息条数自己切方框。窗口没到 DSH 压缩线时，「更新检查点」也补不出历史方框；要分段请点「生成检查点」。
- 芯片 / 会话层 / Git 旁路 / 注入 / 抽取开关拨一下即保存。Embedding URL 等字段要点「保存设置」；若保存后仍未生效，重启 `dsh web` 再检查。
- **0.5.0 写出的 JSONL 是 `v: 2`，图 JSON 是 `version: 2`。** 都是增量格式，v1 文件仍可读，但不支持原地降级：旧版本会忽略版本关系，并在下次写出时把它们丢掉。要退回请恢复升级前的文件组（`.dsh/trivium.tdb` 与 `.dsh/trivium.jsonl`），不要让旧版重写一遍。
- 这一版的决策链是线性的：一个前驱、一个后继。把一个版本拆成多条，或者多对一汇入，都会被拒绝，而不是半应用。
- 从 JSONL 文件里删掉一条替代关系会被报告为冲突，不会直接生效；请在面板里撤销。
- 宿主升到 rc.8 后，DSH 自己的旧会话库可能打不开（官方 SQLite 格式不兼容）。工作区里的 `.tdb` 图记忆还在；对不上号的旧情节方框可以当残留，不影响 `ctx_find`。

---

## 验证与测试数据

| 验证 | 结果与范围 |
|---|---|
| 离线回归 | 当前源码在隔离设置下运行 `node scripts/run-all.mjs`，**56/56 组通过**；见 [W6 证据](docs/next-memory/evidence-write-provenance/W6/README.md)。这是脚本组数，不是模型准确率或 npm 包验收。 |
| 真实宿主 + 可控模型桩 | 发布后的 W5 对来源、审计、重放和工作区隔离做了宿主闭环；其中一项记为发现。HTTP 变更接口及 UI 视觉、键盘仍未完整验收，见 [结果](docs/next-memory/WRITE-PROVENANCE-RESULTS.md)。 |
| 小样本真实模型 | [A5 基线](docs/next-memory/A5-WIDER-BASELINE-2026-10-30.md)使用单一模型、5 类合成场景各 5 次：候选和入库各 25/25，新会话答对 21/25；这是修复前的历史基线。后续 [A10](docs/next-memory/A10-REGRESSION-N10-2026-10-30.md) 两个固定场景各 10 次新会话回答均为 10/10，但否定场景有 3/10 次准备阶段触发请求上限，部分运行由 agent 主动写入。不同批次不能合并当作通用准确率。 |
| 历史证据清单 | `node scripts/verify-evidence.mjs` 校验历史 manifest 中 9 个文件的大小与哈希；它不验证实验设计，也不覆盖全部新证据。 |

上述真实模型样本不能证明模型总会调用工具、完整会话效果或普遍降低成本。旧 D0 部分对照臂重复种植，D1 的 `0.51×` 模拟未计入完整注入历史和短地图；应按[独立审查](docs/next-memory/POST-081-REVIEW.md)的限制解读。

## 更新说明

- [0.8.2](docs/release-0.8.2.md)：修复抽取与决策正确性问题，增加逐条授权的偏好导出与校验。
- [0.8.1](docs/release-0.8.1.md)：改进长事实注入与预算前候选选择。
- [0.8.0](docs/release-0.8.0.md)：增加工作区切换、导入预览和投递记录。
- 更早版本的发布说明见[文档入口](docs/README.md)。当前源码另有发布后的来源、变更记录和抽取并发保护；它们尚未包含在 npm 0.8.2 中，验证边界见 [W1–W5](docs/next-memory/WRITE-PROVENANCE-RESULTS.md) 与 [W6](docs/next-memory/evidence-write-provenance/W6/README.md)。

## 排障

| 现象 | 处理 |
|---|---|
| 设置里没有「Trivium 记忆」 | 确认装的是 web profile，然后**重启** `dsh web`，再打开一个工作区。只刷新浏览器不够。 |
| 英文宿主下设置卡 / 芯片标签显示中文 | 0.4.19 已修（[issue #2](https://github.com/QWQcool/dsh-trivium/issues/2)）。旧版本可在 **设置 → Trivium 记忆 → 配置设置 → 插件语言 → English** 手动选一次，会写进 `~/.dsh/trivium.json`，刷新页面即可，不用重启宿主。 |
| 标题栏没有「芯片」 | 在设置里打开「芯片（记忆白名单）」（拨一下就会保存）。切回对话页，标签应立刻出现，不用重启。 |
| 改了注入 / 抽取 / embedding / 芯片开关没生效 | 芯片 / 抽取 / 注入拨一下即保存。Embedding URL 等字段要点「保存设置」；若保存后仍未生效，重启 `dsh web` 再检查。 |
| 会话层只有一个「后续」方框 | 正常（在会话层已打开时）。方框跟 DSH 压缩走，会话长不等于已经压过（默认约窗口 80% 才自动压）。要分段：对话里 `/compact`，或点「生成检查点」（只切图，不压窗口）。旧会话可点「更新检查点」补已经发生过的压缩 / 分叉。 |
| `ctx_find` 什么都没有 | 新会话默认只注入短地图，模型要自己调工具。也可以在芯片条「新增」或对模型说「记住：…」。闲聊和一次性改文件不会自动入库。 |
| 报 `.tdb` 被占用 / 打不开 | 只开一个 `dsh web`。不要同时跑两份链接了本插件的 Node 进程。 |
| embedding 填了但检索没变准 | 失败会退回关键词 + 图。检查 `~/.dsh/trivium.json` 中保存的 URL 是否为 OpenAI 兼容的 embeddings endpoint；保存后仍未生效时重启宿主再检查。 |
| 卸载后记忆还在 | 先停 `dsh web` 再 `dsh plugin remove`。剩下的 `.tdb` 是从未用 0.4.10 打开过的工作区，到该文件夹删 `.dsh/trivium.tdb`。已提交的 `trivium.jsonl` 用 `git checkout` 找回。只在配置里 disabled 不会清文件。 |
| 检查更新失败 | 只请求 npm registry 拿最新版本号，不影响记忆；过一会儿再点即可。 |
| rc.8 之后旧对话打不开 | 那是 DSH 自己的会话库格式变了，不是 `.tdb` 坏了。图记忆仍可 `ctx_find`；对不上号的旧方框可当情节残留。 |
| 桌面端弹出「A JavaScript error occurred in the main process / EPIPE: broken pipe, write」 | 宿主侧问题，不是插件：`electron-updater` 往一个已经断开的控制台管道写日志（常见于用 `--inspect` 的测试启动器拉起、父进程随后退出）。栈里没有 `dsh-trivium`。点确定后从开始菜单正常启动；不要从会关闭的终端/测试器拉起。 |

**维护命令**（0.6.0 起随包分发）：

- `npx dsh-trivium-check <工作区>` —— 以**只读**方式打开图，报告 `supersedes` 自环、循环、分叉、重复 URI、悬空端点与无法解析的链。退出码：0 干净，2 有问题，1 打不开。
- `npx dsh-trivium-clear-until <工作区>` —— 默认只列出仍带期限的过期决策；`--apply` 只清「期限文本同时出现在正文里」的那些（0.4.21 从正文抓日期的形态）；`--apply --all` 清掉所有过期期限，包括用户显式填的。先关宿主，内核是单写者。

本地联调：仓库里 `npm install` 后 `node scripts/link-dsh.mjs`，再重启 `dsh web`。`triviumdb` 是原生模块，装不上时先看 Node 是否满足 `package.json` 的 `engines`（`^22.19.0 || >=24`）。

---

## 发布信息

- GitHub: https://github.com/QWQcool/dsh-trivium
- 已发布包：`0.8.2` · [npm](https://www.npmjs.com/package/dsh-trivium)；当前源码包含发布后修改，详见[文档入口](docs/README.md)
- 测试宿主：`@deepseek-ai/dsh@0.2.1-rc.4`（peer 范围同时接受 0.1.x 各线）
- License: MIT（依赖 [TriviumDB](https://github.com/YoKONCy/TriviumDB) 为 Apache-2.0）

---

## 致谢

写入卫生闸门、npm 检查更新、跟随宿主语言的界面，以及 Claude Code / Codex 文件发现，部分借鉴自 [dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory)（Aik358）。产品仍是图内核（节点、边、四个工具、默认安静），不是日记 / 日历伴侣。
