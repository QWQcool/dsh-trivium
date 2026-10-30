# A-4：凭据值闸门（补 A-3 暴露的缺口）

日期：2026-10-30。分支 `codex/r1-r2-reliability`。零模型调用、零费用。未发布、未推送。

## 1. 问题

A-3 把抽取改成 `reasoningEffort: "off"` 后，模型不再自行隐去凭据形状的内容：

```text
有推理：…含校验口令，按不落库敏感信息处理，口令内容已隐去。
关推理：发布前置校验：…必须先校验口令 verify-QA-71。   ← 原样落库
```

我先前的说法“插件没有本地 secret 过滤器”**不准确**。实际是：写入闸门早就有（`lib/hygiene.js: sanitizeForWrite` → `lib/schema.js: looksSecret`），抽取与 `ctx_remember` 两条写路径都走它，但它只认英文关键词：

```js
/(api[_-]?key|secret|password|token|bearer\s+[a-z0-9]|sk-[a-z0-9])/i
```

中文“口令/密码/密钥”、GitHub/AWS/Google/npm/Slack 前缀、JWT、PEM 都不在其中，所以那条事实穿过去了。

## 2. 改了什么

`lib/schema.js` 新增 `CREDENTIAL_VALUE_RE`，`looksSecret` 改为两个规则取并集：

| 类别 | 覆盖 |
|---|---|
| 供应商前缀 | `ghp_/gho_/ghu_/ghs_/ghr_`、`github_pat_`、`AKIA…`/`ASIA…`、`AIza…`、`npm_…`、`xox[abprs]-…` |
| 结构化凭据 | JWT（`eyJ….….…`）、`-----BEGIN … PRIVATE KEY-----` |
| 中文语境 | `密码/口令/密钥/令牌/私钥/凭据` + 0–3 个分隔符 + 不透明 ASCII 值（如 `口令 verify-QA-71`、`密码：Zx9q2Wm7`） |

**明确不拦**：`发布代号是 BlueHeron`、`端口 9443`、`负责人张三`、`密码学很难`、`预算 5000 元`、`sha256 已核对` —— 这些是事实不是凭据。

拒绝行为：`filterCandidates` 新增 `onSkip` 回调，`applyCandidates` 透传，`distill` 返回 `skipped[]`，`runExtract` 写进 `workspaceStatus().lastExtract.skipped` 并在有 `secret` 拒绝时打一条 warn。

**拒绝报告不回显密文**：`preview` 固定为 `<redacted>`，只保留 `type` 与 `length`。

## 3. 验收

新增 `scripts/smoke-p46.mjs`（26 条）：

```text
ok refuses github pat / github fine-grained / aws access key / google api key
ok refuses npm token / slack token / jwt / pem
ok refuses chinese password / chinese code word
ok keeps project code name / port / person / password topic without a value / budget / hash in prose
ok the clean candidate is written
ok the written candidate is the clean one
ok the secret candidate is reported as skipped
ok skip reason is secret
ok the skip report does not echo the secret
ok the skip report keeps only a length
ok no credential reached the database
ok the clean fact did reach the database
ok ctx_remember gate refuses the same value
ok ctx_remember gate keeps the clean fact
P46: 26/26
```

全量：`node scripts/run-all.mjs` → **47/47 passed**（既有 p1–p45 无回归）。

## 4. 取舍与残留

- 规则是**形状匹配**，不是语义理解：真凭据若既无前缀、也无“密码/口令”字样、也不是 JWT/PEM（例如随手编的 `Zx9q2Wm7`），仍会漏。这是确定性规则的固有上限。
- 反向也有代价：旧的英文 `token` 规则会误伤“token 预算 500”这类正常说法。**已在 [E1-B 片](E1B-CONSUMER-VERIFY-2026-10-30.md) 修掉**：英文词必须跟着一个值才算凭据（`token=abcd1234efgh`、`password is hunter2` 仍拦；`token 预算 500`、`password policy` 不再拦）。
- 拒绝只在抽取路径与 `ctx_remember` 上生效；文件导入（`via=workbuddy-import`）走同一 `filterCandidates`，因此同样受约束——这是有意的，但会让“导入旧记忆时含凭据”的条目变少，需要在导入报告里能看见（当前只汇总在 `lastExtract`，导入路径没有单独展示）。
- 拒绝后那条事实就是**不落库**，用户不会在 UI 里看到“这条被拦了”；只有 `lastExtract.skipped` 与服务端 warn 里能看到。要做用户可见提示属于 E1-B 的活。
