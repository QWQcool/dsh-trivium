# E1-B 第一片：消费端可校验 + 英文凭据规则收窄

日期：2026-10-30。分支 `codex/r1-r2-reliability`。零模型调用、零费用。未发布、未推送。

## 1. 为什么要做这片

E1-A 证明了“现有文件入口能把偏好读进任务”，但那份文本**只能靠宿主自觉**：谁都可以改 `persona-with-prefs.md`，谁都可以把过期的快照继续喂给下游。E1-B 要回答的是“下游能不能自己判断这份文本还是不是当初批准的那份”。

这轮先做**不依赖修改插件**的那一半：一个只读校验面。

## 2. `verifyFiles()` / `prefs-export verify`

`lib/consumer-preferences.js` 新增 `verifyFiles(workspace, { personaFile, now, allowExpired, db })`，逐项返回 `{name, ok, detail}`：

| 检查 | 说明 |
|---|---|
| snapshot file exists / schema version | 文件在、版本是 `consumer-preferences/v1` |
| not revoked | 撤回后的 tombstone 直接判负 |
| digest matches the machine layer | 用 `bindingId/consumer/purpose/sourceRevision/facts[uri,contentHash,strength]` **重算 sha256** 与落盘值比对 |
| not expired | `expiresAt <= now` 判负；`--allow-expired` 只能显式放行 |
| binding exists / active / id matches / consumer matches | 防止拿 A 的批准去喂 B |
| block file exists / every approved fact is in the block | 模型侧文本必须仍含每一条已批准事实 |
| consumer file carries the block | 传 `--persona` 时检查下游实际读的那个文件 |
| facts unchanged since export | 传数据库时比对当前库指纹与 `sourceRevision`（库被占用则跳过并标注） |

CLI：`node scripts/prefs-export.mjs verify --workspace <dir> [--persona <file>] [--allow-expired]`，健康退出 0、失败退出 3，输出机器可读 JSON。

**不做的事**：不修改任何文件、不写库、不连接平台、不替下游决定“过期了还能不能用”（放行必须显式）。

## 3. 英文凭据规则收窄（A-4 遗留）

A-4 之后仍有一个误伤：旧规则里 `token` 是裸词，`token 预算上限是 500` 会被当成凭据拒写。现在英文规则改成**必须跟着值**：

```js
\bsk-[A-Za-z0-9_-]{8,}
\bbearer\s+[A-Za-z0-9._-]{8,}
\b(?:api[_-]?key|secret|password|passwd|pwd|token)\b\s*(?:[:=：]|\bis\b|\bare\b|是|为)\s*["'`]?[A-Za-z0-9][A-Za-z0-9_\-./+=]{5,}
```

保留拦截：`token=abcd1234efgh`、`the password is hunter2`、`api_key: AIza…`、`sk-…`、`Authorization: bearer …`。
不再拦截：`token 预算上限是 500`、`The password policy requires 12 characters`、`api key 存在环境变量里`。

## 4. 验收

```
$ node scripts/smoke-p47.mjs
ok a healthy export verifies
ok digest is recomputed and matches
ok consumer is checked against the binding
ok every approved fact is in the block
ok an expired snapshot fails verification
ok expiry names itself
ok --allow-expired is explicit, not silent
ok a tampered block fails
ok the missing fact is named
ok a forged digest fails
ok restoring the digest restores the verdict
ok a revoked binding fails
ok a consumer file without the block fails
ok verify exits 0 on a healthy export (got 0)
ok verify prints a machine-readable verdict
ok verify exits 3 on failure (got 3)
P47: 16/16

$ node scripts/smoke-p46.mjs      → P46: 34/34（新增 8 条正负例）
$ node scripts/run-all.mjs        → 48/48 passed
```

## 5. 仍未解决

1. **没有真正的强制点**：`verify` 是一个可选命令。B 站插件不会自己调用它，所以“过期快照仍然被喂给任务”在技术上依然可能。要做到强制，只有两条路：改插件（在 `promptFor` 前调用校验），或者把宿主侧（Trivium）变成唯一能把偏好写进下游文件的角色——**这两条都超出“不改插件源码”的约束，需要你拍板**。
2. **digest 只是内容一致性**，不是签名：能改文件的人也能同时改 digest。要防篡改需要密钥/HMAC，本轮没做。
3. `facts unchanged since export` 依赖当前库指纹；库被宿主占用时该检查会跳过（输出里 `databaseChecked: false` 可识别），不是静默通过。
4. 校验失败时的**用户可见提示**还没有（CLI 退出码 + JSON 而已）。
5. E1-B 剩余项：绑定展示/回执、Trivium 侧入口（设置页）、快照过期后的自动重导出策略。
