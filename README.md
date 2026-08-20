# dsh-trivium

昨天刚把「这个仓库鉴权走 header X」说清楚，关掉窗口，第二天再开，DeepSeek Harness 又是一张白纸。

原装 DSH 没有跨会话记忆。这个插件补这一块：装上就在，不另起一个记忆服务。每个工作区一个文件，`.dsh/trivium.tdb`。

它记的是一张小图，不是一篇日记。偏好、决策会尽量挂到具体东西上（比如 AuthGateway）。下次问「鉴权」，能找回来，还知道这条是关于谁的。

默认很安静。新会话只丢一张短地图进窗口，大概几百 token，不会每一步把旧账灌满。真要用的时候，模型自己调 `ctx_find` / `ctx_read`。

MIT · [`dsh-trivium@0.3.0`](https://www.npmjs.com/package/dsh-trivium)

## 安装

已经能跑 `dsh web` 的话：

```sh
dsh plugin --profile web add dsh-trivium
```

重启 `dsh web`，打开一个工作区。设置里会出现「Trivium 记忆」。

我是在 `@deepseek-ai/dsh@0.1.0-rc.6` 上开发和验收的。DSH 还是预览版，接口以后可能变，换版本不一定还能直接用。

如果用的是 [Dsh_BatStart](https://github.com/QWQcool/Dsh_BatStart) 那个一键启动，双击就会带上这个插件，不用再装一遍。

改插件本身、想跟源码联调：

```sh
npm install
node scripts/link-dsh.mjs
```

然后再重启 `dsh web`。这会把本仓库接到本机的 web profile 上，跟 `dsh plugin add` 是同一条加载路径。

## 它怎么记

**会话 A**：「记住，鉴权走 header X。」  
写成一条偏好，尽量连到实体（AuthGateway）上。

**会话 B**：模型调用 `ctx_find("鉴权")`  
命中。返回一行摘要，并带上路径：这条 about → AuthGateway。

问 `AuthGateway` 也能打到挂在它上面的决策，哪怕决策正文里根本没写这个名字。

天气好不好、一次性「把这个文件改了」、密钥，不会进库。一次也不会写太多。

## 设置里

设置 → **Trivium 记忆**：搜、看它连着谁、改名和正文、把两条合成一条、归档或删掉。

记错了就在这里改。JSON 可以导出再导回来。Markdown 导出是给人看、给 git 看的，改完不要指望再解析回去。

以前用 WorkBuddy、已经有一篇 `MEMORY.md` 的话，可以一次性导进来。宁漏不滥，不会两边一直同步。

决策可以标截止日期（`until`，比如「下周」）。过期的默认不出现，除非你正在问那个期限。

想让它更主动：可以改成「话里提到已知实体才灌一跳邻居」，或者打开每步自动召回。默认都关着。

## 四个工具

| 工具 | 干什么 |
|---|---|
| `ctx_find` | 搜。给摘要，以及它在图上连着谁 |
| `ctx_read` | 按 id 读全文，以及谁连过来 |
| `ctx_remember` | 手动记一条 |
| `ctx_link` | 两条之间连一条有向边 |

边上的关系就这几种：`about`（关于）、`decided`（决定）、`broke`（搞坏过）、`fixed`（修好了）。

## embedding

默认关。没有本地模型。官方 DeepSeek 对话接口也不提供 embeddings。

要用语义检索，去设置里填一个 OpenAI 兼容的 embedding 地址。挂了就退回关键词 + 沿图走，对话照常。

## 现在还不会的

这不是记忆工作台：没有侧栏、没有画布。模型如果不调 `ctx_find`，窗口里就只有那张短地图。

抽取会漏。旧的脏数据不会自动打扫，人在设置里改或归档。

同一个 `.tdb` 不要两个 Node 进程一起开。正常只开一个 `dsh web` 没这个问题。

## License

MIT。底下用的 [TriviumDB](https://github.com/TriviumDB/triviumdb) 是 Apache-2.0。
