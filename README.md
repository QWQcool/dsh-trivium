# dsh-trivium — DSH 进程内图记忆

DeepSeek Harness 的跨会话图记忆插件：按节点和边记，默认少注入，设置页可改可归档。会话标题栏多一个 **会话图**：compaction 收成方框，可从检查点 fork，可选记忆芯片钉进下一轮。每个工作区一个 `.dsh/trivium.tdb`，不另起服务。

> **快速安装**：`dsh plugin --profile web add dsh-trivium` → 重启 **dsh web** → 打开工作区（设置里出现「Trivium 记忆」，对话旁出现「会话图」）。

---

## 安装

> 前提：已安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 并至少启动过一次 `dsh web`。当前在 `@deepseek-ai/dsh@0.1.0-rc.6` 上测试。

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

## AI 时代安装

把下面这句话复制给助手即可：

```text
请在 DeepSeek Harness 上执行：dsh plugin --profile web add dsh-trivium
然后重启 dsh web。设置里会出现「Trivium 记忆」，会话标题栏「对话 / 轨迹」旁会出现「会话图」。
```

---

## 做什么

- **跨会话** — 会话 A 记下「鉴权走 header X」，会话 B 调用 `ctx_find("鉴权")` 命中，并带上它连着谁（`about` / `decided` / `broke` / `fixed`）。
- **默认安静** — 新会话只注入一张短地图（≤400 token）。模型要用再调工具，不会每一步灌满。
- **会话图** — compaction 切一段就收成一个方框；点方框用 DSH 原生 fork 开分支；勾选的记忆芯片从当前这段的下一轮注入。
- **人能改错** — 设置 → Trivium 记忆：搜、看邻居、改名 / 正文、合并、归档或删除。
- **抽取偏严** — 闲聊、一次性改文件、密钥不入库。
- **可选 embedding** — 默认关。官方 DeepSeek 对话接口没有 embeddings；可填 OpenAI 兼容地址。

### 四个工具

| 工具 | 说明 |
|---|---|
| `ctx_find` | 检索，返回摘要和图路径 |
| `ctx_read` | 按 id 读全文和入边 |
| `ctx_remember` | 手动写入 |
| `ctx_link` | 两点之间建有向边 |

内核仍是这四个。会话图不加第五个工具。

---

## 会话图

入口：当前会话标题栏 **对话 / 轨迹 / 会话图**。这是情节图，不是记忆编辑器；改错的节点仍走设置页。

### 方框

- 没压过上下文：只有一个「后续」方框。
- 一次成功的 compaction 之后：左边历史检查点（摘要来自 DSH），右边仍是「后续」。
- 方框自己不压缩。质量来自 DSH 已经做的摘要替换；fork 时不会再总结一遍。
- 「改名」只改方框标题，不动 DSH 摘要。点方框可跳回对话里对应的检查点，或打开轨迹。

### 分叉

点方框上的分叉图标，会弹出「分叉为新会话」。这个名字会出现在左侧会话列表里（默认是源标题加 `(1)`）。

确认后走宿主的 `session.fork`：子会话出现在侧边栏，前缀（含当时已经压过的摘要）由 DSH 拷过去。有检查点时从那个检查点切开；只有「后续」时就从你点的那个方框连出去。

对话页里用 DSH 自带 fork，切回会话图也能看到对应分支。侧边栏归档一个子会话后，图上的分叉方框会跟着消失；取消归档会再出现。

画布：空白处拖动平移，滚轮缩放。

### 记忆芯片

会话图顶部可展开勾选。列出未归档的 preference / decision / entity（experience 不进芯片，避免太吵）。

| 操作 | 生效时机 |
|---|---|
| 勾上某条 | 当前这段里你再发的**下一条**带上它（L0，≤300 token） |
| 取消勾选 | 再下一轮不再带 |
| 已经发出去的轮次 | 不回写 |

芯片按会话隔离。新开会话、fork 出的子会话默认都不勾；需要的话在分叉对话框旁打开「分叉时继承钉选」，或到子会话里重新勾。短地图仍在 session-start 自动带，不占芯片位。建议标记只是提示，不会自动勾上。

---

## 界面截图

以下都是本机 DSH Web（rc.6）里的实测画面。

### 会话 — `ctx_find("鉴权")`

![ctx_find 鉴权](docs/screenshots/02-ctx-find.png)

会话开头注入 `dsh-trivium` 短地图；模型调用 `ctx_find`，命中「本仓库鉴权走 header X」。

### 轨迹 — 上下文注入可见

![轨迹](docs/screenshots/03-trajectory.png)

### 设置 — 注入策略

![设置](docs/screenshots/04-settings.png)

### 设置 — 记忆条目

![条目列表](docs/screenshots/05-settings-list.png)

### 会话图 — 对话 / 轨迹旁的第三标签

![会话图](docs/screenshots/06-session-map.png)

标题栏出现「会话图」。没压过的会话只有一个「后续」方框；顶部是记忆芯片（默认不勾）。compaction 之后左边出现历史方框，分叉从方框连到子会话。

---

## 限制

- 模型不调 `ctx_find`、也不勾芯片时，窗口里主要是开场短地图。
- 抽取会漏；脏数据要在设置里改或归档。
- 同一个 `.tdb` 不要两个 Node 进程同时打开（正常只开一个 `dsh web` 即可）。
- Markdown 导出是给人看的，不能再解析回去。WorkBuddy 导入是一次性，不是双向同步。
- 会话图只投影 compaction 与 fork，不会按消息条数自己切方框。
- 改插件设置后需要重启 `dsh web`。

---

## 发布信息

- GitHub: https://github.com/QWQcool/dsh-trivium
- npm: [`dsh-trivium`](https://www.npmjs.com/package/dsh-trivium)
- License: MIT（依赖 [TriviumDB](https://github.com/TriviumDB/triviumdb) 为 Apache-2.0）
