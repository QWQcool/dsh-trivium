# S0-3 证据：事件两级过滤（B1）

基线：S0-2 之后（`dc89a5e`）。零模型调用、零费用（p75 的 llmCall 是本地桩）。

## 修前

- 只有一层过滤：`shouldExtractBatch`（内容门）。它只认"填充句"（`继续/好的/ok/谢谢`）与"有没有 tool 轮"。
- 于是 `git status`、`npm test`、`C:\proj\build\out` 这类**纯命令/纯路径**照样开库、上锁、付一次模型调用，
  拿回一个 `{"candidates":[]}`。
- 没有"这条更值得先看"的概念：窗口里的事件顺序就是宿主的顺序。

## 修后

`lib/extract.js` 新增规则层（纯函数、无 IO、无新请求）：

| 接口 | 作用 |
|---|---|
| `screenEventDetail(text)` | `{score, rule}`；`rule` 是这条判定的依据，便于审计 |
| `screenEvent(text)` | 只要分数 `0｜1｜2` |
| `screenTurns(turns)` | 按用户轮分组后过滤/排序，返回 `{turns, dropped, promoted, counts}` |

评分顺序（先 2 后 0，保证"有事实"不会被"像寒暄"吃掉）：

1. `PREFERENCE_CUES` / `DECISION_CUES` 命中 → **2**（进 batch 前排）；
2. 长度 > 120 → **1**（长文本一律不当 0）；
3. 完整匹配 `EMPTY_UTTERANCE`（寒暄/确认）→ **0**；
4. 完整匹配 `CHITCHAT_CUES` → **0**；
5. 含 CJK → **1**（中文句子永远不判 0）；
6. 完整匹配斜杠命令 / shell 命令 / 单条路径（Windows、UNC、POSIX）/ 单条 URL → **0**；
7. 其余 → **1**。

窗口层规则：

- 用户轮 + 其后的 assistant/tool 回复绑成一组，组内顺序不变（回复不会跟丢它回答的那条消息）；
- 组内有 tool 结果时该组至少 1 分（**命令本身没有信息，但它失败/成功了是经验事实**）；
- 0 分组整组丢弃；2 分组前置，同分之间保持原顺序（V8 稳定排序）。

接入点：`runExtract`（`lib/index.js`）在**取锁、开库之前**调用 `screenTurns`：
全部 0 分时直接 `return true`（窗口被消费，与内容门同一套理由），状态里写
`skippedBy:"screen"`、`screenedOut`、`screenedCounts`、`gate:{skipped:true, reason:"screen-empty"}`，并记一条 warn
级别的 info 日志。部分被筛掉时，`lastExtract.screenedOut/screenedCounts` 也会带出条数。
`recordChanges` 用筛选后的窗口做 opId，保证重放同一窗口得到同一批 opId。

## 命令与输出摘要

```
node scripts/smoke-p75.mjs   → P75: 43/43
node scripts/run-all.mjs     → 76/76 passed（S0-2 后 75/75）
```

关键实测数字（p75 的 30 个窗口语料：10 条带 `记住` 的事实句 + 12 条 `git status` + 8 条 Windows 路径）：

| 指标 | 不筛 | 筛后 | 变化 |
|---|---|---|---|
| 模型调用数 | 30 | 10 | **−66.7%**（要求 ≥20%） |
| 抽取命中（applied 文本集合） | 10 条 | 10 条 | 完全一致（逐条 deepEqual） |
| 写库节点数 | 相同 | 相同 | 相同 |

其余断言：

- 完整白名单 10 条样例全部 0 分（含 `/compact`、`npm test`、`C:\proj\readme.md`、`~/proj`、`/tmp/build.sh`、URL）；
- 3 条明确事实句 2 分；普通叙述 1 分；空串/纯空白 0 分；超长文本 1 分；
- **8 条误判反例**（要求 ≥5）全部 `>= 1`：寒暄前缀带事实、填充词前缀带决策、命令前缀带事实、路径前缀带指令、
  斜杠命令带事实、`ok 但记住…`（这条还要是 2）、URL 带陈述、命令带问号；
- 每条 0 分都能说出命中的规则（`shell-command` / `filler` …）；
- 纯寒暄窗口筛空；带 tool 证据的 0 分组被保留；2 分组前置且组内顺序不变。

## 未覆盖 / 已知边界

1. **只作用于抽取窗口，不删除事件缓冲**：0 分事件仍留在 `buf.turns`（`turn/end` 时进 pending、喂 episode 预览），
   只是**不进入抽取窗口**。这样做是为了不打断 user/assistant 配对，也不改变 episode 尾巴的语义。
   对模型调用的效果与"不进窗口"一致。
2. **白名单刻意窄**：shell 名单只收常见命令；带引号、管道、`&&`、中文的命令行一律 1 分（例：`npm test && rm -rf x`、`git commit -m "…"`）。
3. **2 分前置会改变窗口内的顺序**：只在"同一窗口内、按用户轮整组"重排，回复跟着自己的用户轮走。
   如果某类事实依赖"前一轮说过什么"的严格时序，这次重排可能影响模型理解——本片没有实机语料证据，属已知风险。
4. **`screenTurns` 不判断"这条事实是否已存在"**：去重仍由 `distill` 负责。
5. **只省"完全无信息"的调用**：一句话里只要有一个未识别的词，就按 1 分处理，因此降幅取决于真实会话里纯命令/纯路径的占比（本夹具是 66.7%，不是通用结论）。
