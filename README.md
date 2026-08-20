# dsh-trivium — DSH 进程内图记忆

DeepSeek Harness 的跨会话图记忆插件：按节点和边记，默认少注入，设置页可改可归档。每个工作区一个 `.dsh/trivium.tdb`，不另起服务。

> **快速安装**：`dsh plugin --profile web add dsh-trivium` → 重启 **dsh web** → 打开工作区（设置里出现「Trivium 记忆」）。

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

## AI 时代安装

把下面这句话复制给助手即可：

```text
请在 DeepSeek Harness 上执行：dsh plugin --profile web add dsh-trivium
然后重启 dsh web。设置里会出现「Trivium 记忆」。
```

---

## 做什么

- **跨会话** — 会话 A 记下「鉴权走 header X」，会话 B 调用 `ctx_find("鉴权")` 命中，并带上它连着谁（`about` / `decided` / `broke` / `fixed`）。
- **默认安静** — 新会话只注入一张短地图（≤400 token）。模型要用再调工具，不会每一步灌满。
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

---

## 限制

- 这是内核，没有记忆侧栏 / 画布。模型不调 `ctx_find` 时，窗口里只有短地图。
- 抽取会漏；脏数据要在设置里改或归档。
- 同一个 `.tdb` 不要两个 Node 进程同时打开（正常只开一个 `dsh web` 即可）。
- Markdown 导出是给人看的，不能再解析回去。WorkBuddy 导入是一次性，不是双向同步。

---

## 发布信息

- GitHub: https://github.com/QWQcool/dsh-trivium
- npm: [`dsh-trivium`](https://www.npmjs.com/package/dsh-trivium)
- License: MIT（依赖 [TriviumDB](https://github.com/TriviumDB/triviumdb) 为 Apache-2.0）
