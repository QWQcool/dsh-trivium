# A-2：长文本尾部漏记的定位（真实报文级）

日期：2026-10-30。分支 `codex/r1-r2-reliability`。真实模型调用 **5 次有效运行，可核账 ¥0.067154**（另有 1 次运行因代理未解码无法计价）。未发布、未推送。

起点：[R3 结果](R3-HOST-RESULTS.md) 的 S3（长正文 + 尾部口令 `verify-QA-71` 没进库、新会话答“无记录”）。
上一轮已修：[A-1 整轮漏记](A1-FACT-LOSS-FIX-2026-10-30.md)（与本案无关）。

## 1. 先给结论

**不是截断。** 同一条 343 字符的长消息，在真实宿主里逐阶段都在：

| 阶段 | 实测 |
|---|---|
| 输入 | 343 字符，`verify-QA-71` 在末尾 |
| 缓冲（500 字符上限） | **343 字符，未截断，事实在** |
| 抽取 prompt（2400 字符上限） | 事实在 prompt 里 |
| 模型返回 | **不稳定**：有的回 `{"candidates":[]}`，有的只写一条“背景约定”的改写、把口令隐去 |
| 落库 | 4/5 次有事实，但来源不固定：**2 次是 agent 自己调了 `ctx_remember`**，不是抽取管线 |

三个真实原因，按重要性：

### 1.1 抽取重试被 400 token 预算截死在“思考”里（已修）

`lib/index.js` 的抽取调用原本 `maxTokens: 400`。这个模型会先输出 reasoning，**3/3 次**重试抽取都以 `stop_reason=max_tokens`、`output_tokens=400`、**正文 0 字**结束。插件把这当成“没有候选”，于是窗口被消费、pending 被清空 —— 真正的静默丢事实。

### 1.2 测试夹具本身是“口令形状”，撞上了“不落库敏感信息”规则

`verify-QA-71` 长得像凭据。抽取 prompt 明确要求不存 secret，于是模型会**故意**把它隐去：

```text
…其中含校验口令，按不落库敏感信息处理，口令内容已隐去。
```

也就是说，R3 的 S3 有一部分是**产品的预期行为**，不是缺陷。拿它当“长文本尾部必须记住”的金标，本身就是错的夹具。

### 1.3 长噪声正文里的判断本身不稳

60 段重复的「背景记录。」会被模型判成背景噪声，常见结果是 `{"candidates":[]}` 或一条不含实质条款的改写。同一输入重复跑，结论不一致（本轮 5 次里 1 次什么都没落、1 次只落改写、3 次最终有事实但其中 2 次靠 agent 工具调用）。

## 2. 修了什么

| 位置 | 改动 | 理由 |
|---|---|---|
| `lib/index.js` | 抽取 `maxTokens` 400 → 900 | 让 reasoning 有空间；实测改后同一重试调用 `stop_reason=end_turn`、正常返回 `{"candidates":[]}` |
| `lib/extract.js` | **空回答 = 抽取失败** | 空白文本不再等价于 `{"candidates":[]}`；`llmFailed=true` → 调度器保留 pending，等下次事件重试，不再静默消费窗口 |
| `scripts/smoke-p44.mjs` | 新增 13 条回归 | 空/纯空白 = 失败；显式空列表 = 成功；失败后 pending 保留原文；真实回答仍落库 |

明确没有做：没有放宽 500/400/2400 这些字符上限（本轮证据不支持“截断”），也没有改默认开关、DIM、数据格式。

## 3. 验收

```
$ node scripts/smoke-p44.mjs
ok blank model answer is a failure
ok blank answer applies nothing
ok blank answer leaves only the workspace node
ok whitespace-only answer is a failure too
ok explicit empty candidate list is not a failure
ok explicit empty list applies nothing
ok scheduler reports the failure
ok scheduler keeps the turn for a later retry
ok pending file still holds the fact
ok pending text is the original fact
ok a real answer is a success
ok a real answer is applied
ok the fact is readable from the database
P44: 13/13

$ node scripts/run-all.mjs
45/45 passed
```

真实模型验证（同夹具、同路径）：修复后重试抽取 `stop_reason` 从 `max_tokens` 变为 `end_turn`，不再出现“400 token 全花在思考上、正文为空”。

## 4. 成本

| 项 | 值 |
|---|---|
| 有效真实运行 | 5 次（另 1 次因代理 404 未触达供应商，¥0） |
| 可核账请求 | 49 次 |
| 可核账费用（谷价） | **¥0.067154** |
| 计价缺口 | 1 次运行的响应被 gzip 未被代理解码，无法计价（同类约 ¥0.01–0.02） |

单次运行的明细在 [evidence-r3/a2/runs.json](evidence-r3/a2/runs.json) 与 [extract-calls.json](evidence-r3/a2/extract-calls.json)（含每次抽取的 stop_reason、思考片段数、返回正文）。

## 5. 仍未解决

1. **夹具要换**：长文本尾部必须换成**非敏感**事实（例如“发布前先跑 smoke，再改版本号”），否则测的是“模型守不守 secret 规则”，不是“长文本能不能记住”。
2. **抽取判断不稳**：同一输入多次结果不同（空 / 改写 / 命中）。这是模型质量问题，不是 codec；需要 n≥3 重复 + 严格判分才能报基线，不能用单次结论。
3. **无“被截断后升级预算重试”**：现在只是把上限抬到 900 + 空回答保留 pending。若 900 仍不够，会退化成“每次事件都失败一次”，有成本没有产出；需要按 `stop_reason` 做一次显式升级重试（当前插件拿不到 stop_reason，得在 `runExtract` 里加信号）。
4. **“agent 自己调 ctx_remember”与“抽取管线”两条写入路径没有分开计量**，本轮只能靠报文里的 `ctx_remember` 手工区分。做质量基线前应把两者分别打点。
5. 压缩后同一 step 重试缺短地图、`bodyKey` 空白误报等 R3 遗留项未动。

## 6. 对 R3 报告的更正

R3 把 S3 写成“长正文尾部口令漏记”，易被读成系统性截断缺陷。报文级复核后的准确说法是：**没有截断；是夹具（口令形状触发 secret 规则）+ 抽取判断不稳 + 400 token 重试截断（已修）三者叠加**。R3 文档已加更正指引。
