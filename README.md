# dsh-trivium

DeepSeek Harness 的**进程内图记忆内核**。按节点和边记，按需读。每个工作区一个 `.tdb` 文件，不另起服务。MIT。

四个工具，默认几乎不往窗口里灌。

> **快速安装**（已有 `dsh web`）：`dsh plugin --profile web add dsh-trivium` → 重启 **dsh web** → 打开工作区。设置页会出现「Trivium 记忆」。

钉死 **`@deepseek-ai/dsh@0.1.0-rc.6`**。不要把本仓库拷进 `DeepSeek_Harness`。

npm：[`dsh-trivium@0.3.0`](https://www.npmjs.com/package/dsh-trivium) · GitHub：[QWQcool/dsh-trivium](https://github.com/QWQcool/dsh-trivium) · topic `dsh-plugin`

---

## 安装

前提：本机已经能跑 `dsh web`，版本是 `0.1.0-rc.6`。

```sh
dsh plugin --profile web add dsh-trivium
```

或从 GitHub：

```sh
dsh plugin --profile web add github:QWQcool/dsh-trivium
```

然后**重启 dsh web**，选一个工作区。记忆文件在：

```
<workspace>/.dsh/trivium.tdb
```

本地开发（本仓库）：

```sh
cd dsh-trivium
npm install
node scripts/link-dsh.mjs
```

再重启 `dsh web`。

### 丢给 AI 安装

把下面整段交给你的助手即可：

```text
请在 DeepSeek Harness 上安装 dsh-trivium（进程内图记忆插件）。
要求宿主是 @deepseek-ai/dsh@0.1.0-rc.6，不要把源码拷进 DeepSeek_Harness。
执行：dsh plugin --profile web add dsh-trivium
然后重启 dsh web。记忆落在 <workspace>/.dsh/trivium.tdb。
```

---

## 它实际记住什么

原装 DSH 没有跨会话图记忆。装上之后：

**会话 A** 说「记住，鉴权走 header X」→ 写入 preference，并尽量挂到实体（例如 AuthGateway）上。  
**会话 B** 调用 `ctx_find("鉴权")` → 命中，返回 L0 摘要，并带实体 path（`about` / `decided` / `broke` / `fixed`）。

`find("AuthGateway")` 也可以打到邻居，即使邻居正文里根本没出现这个名字。

默认**不**每一步自动召回（`autoRecall` 关）：启动只注入一张短地图（≤400 token），模型要用 `ctx_find` / `ctx_read` 自己下钻。设置里可改成「实体名折中」（话里出现已有实体名才灌 1 跳邻居）或打开 `autoRecall`；三选一，互斥，默认关。

抽取偏严：闲聊、一次性「改这个文件」、密钥不入库。每轮写入正文合计 ≤3000 字、最多 24 条。

---

## 设置里能做什么

设置 → **Trivium 记忆**：

- 搜、看邻居、改名 / 正文、合并、归档 vs 删除
- 导出 / 导入 **JSON**（可回写图）
- 导出 **Markdown**（只读投影，给人、给 git；带边，例如 `- 鉴权走 header X —about→ AuthGateway`）。改完不要把这篇散文再解析回来，回写走 JSON 或本页编辑
- **一次性**导入已有的 `~/.workbuddy/MEMORY.md` 或工作区 `.workbuddy/memory/MEMORY.md`（偏严宁漏，不持续同步）
- 注入策略、抽取开关、可选远程 embedding（OpenAI 兼容 URL，默认关）

`until` 是决策上的截止日期。过期决策默认不进 find，除非查询本身在问这个期限（如「周五」「下周」）。

---

## 四个工具

| 工具 | 干什么 |
|---|---|
| `ctx_find` | 检索。返回 L0 摘要 + 边路径。不要把结果原文贴进后续思考。 |
| `ctx_read` | 按 find 给的 id 读全文和入边。 |
| `ctx_remember` | 显式写入（entity / preference / decision / experience）。 |
| `ctx_link` | 两节点之间建有向带标签的边。 |

没有第五个工具。没有图谱画布。没有默认每步自动召回。

---

## 可选 embedding

默认关。没有本地 embedding 模型。官方 DeepSeek chat API **没有** embeddings。

若要语义检索：在设置里打开开关，手填 OpenAI 兼容的 embedding URL / 模型 / key。失败则退回关键词 + 图遍历，Agent 继续跑。

---

## 限制（v0.3.0）

- 这是内核，不是工作台：无 Mnemon 侧栏、无跨 Agent 共享、无 PDF/Zotero RAG。
- 默认 `autoRecall` 关。模型若不调 `ctx_find`，窗口里就只有短地图。
- 抽取会漏：白名单没命中的事实不会进库；tool 失败→成功的经验，只在失败/修复文本或邻近用户话里点名了实体时才连边。
- 同一 `.tdb` 不要被两个 Node 进程同时打开（普通 `dsh web` 是单进程）。
- 旧的脏行不会自动清；人在 Settings 里改或归档。
- Markdown 导出不能当回写格式。WorkBuddy 导入不是双向同步。

第一期明确不做：对标 OpenViking 的 LoCoMo / L0–L2 评测、默认每步自动召回、本地 embedding、第五工具、图谱画布。

---

## 机制对照（不是 bake-off）

没跑过 live OV 对打，也没跑 LoCoMo。唯一做过的 live 对照是：**同一插件装上、空 `.tdb` 上同样的 `ctx_find("鉴权")` 没有跨会话 preference。**

相对原装 DSH：我们有跨会话节点和边。相对「再起一个记忆服务」：我们没有。相对把 MEMORY.md 整篇灌进 system prompt：我们默认只灌短地图，动态记忆走 `agent.inject()` / 工具，不写 system prompt（也避免 `persona.complete: true` 把注入丢掉）。

---

## 结构

```
lib/index.js      工具、短地图、抽取钩子
lib/store.js      TriviumDB
lib/markdown.js   MEMORY.md 只读导出、WorkBuddy 一次性导入
lib/extract.js    规则 + 小 prompt；每批限写
lib/client.js     Settings「Trivium 记忆」
lib/server.js     本机 API
```

离线：`npm run smoke-p1` … `smoke-p6`。

## License

MIT。TriviumDB 是 Apache-2.0，仍是依赖。
