# B站适配 E0 / E1-A 结果（未提交、未发布）

日期：2026-10-30。分支 `codex/r1-r2-reliability`，起点 `1fe67c4`（已把远端 `docs`/封面两提交快进合并到本地）。
版本仍为 **0.8.1**；本次没有 npm 发布、没有推送、没有真实 B 站账号登录或平台写操作、没有付费模型调用。

依据：[下一轮开工顺序](NEXT-PLAN-2026-10-30.md)、[B站适配计划](BILI-ADAPTER-PLAN-2026-10-30.md)、[R3 结果](R3-HOST-RESULTS.md)。

## 1. 一句话结论

Trivium 现在能按**用户逐条批准**的范围生成一份短偏好快照（≤8 条、≤300 估算 token），把它拼到**原有人设之后**的独立文件里；B 站插件 2.3.1 的**现有「人设提示词=文件路径」入口**确实会把这份文件读进任务提示词。
**更新**后新任务只收到新决策，**撤回**后同一入口不再送出任何偏好文本。

这**不等于**已经“自然聊天自动记住 → B 站用上”：本次用的是手工确认的合成偏好，E1-B/E2/E3 未做（见第 7 节）。

## 2. 代码差异

| 文件 | 变更 | 作用 |
|---|---|---|
| `lib/consumer-preferences.js` | 新增 386 行 | 绑定校验、事实选择（跟随后继/拒绝分叉）、快照与 digest、预算拒绝、人设组合、撤回清理 |
| `scripts/prefs-export.mjs` | 新增 176 行 | `init / export / revoke / status` 四个子命令；只读打开工作区库 |
| `scripts/smoke-p42.mjs` | 新增 156 行 | 38 条离线断言（被 `run-all` 自动发现） |
| `package.json` | +3/-1 | `bin.dsh-trivium-prefs`、`files` 增加该脚本 |

没有改动 B 站插件任何一行：`.tmp/bili-src` 是固定提交 `2c7b3f14f525360f8657b102ec453fd8f02baf3a` 的只读检出，`git status` 干净。

关键语义（都在 `lib/consumer-preferences.js`）：

- **范围**：只导出绑定里点名的条目；支持 `id / uri / name` 三种引用。找不到就报 `scope-unknown`，**不做近似匹配**。
- **版本**：决策先走 `currentHeadOf()` 解析到当前头；解析不了（分叉/环/过长）报 `revision-conflict` 并整条跳过，**不自动选赢家**。
- **预算**：整块渲染后算 token，超 300 或超过 8 条 → 直接失败并给出预览，**不截断半句**；不导出空正文、归档、已过期、写入卫生不通过（含疑似密钥）的条目。
- **身份**：`digest = sha256(规范化{bindingId, consumer, purpose, sourceRevision, facts[uri, contentHash, strength]})`；`sourceRevision` 用库指纹。digest 只证明内容一致，不是身份认证。
- **人设**：`persona-with-prefs.md` = 原人设全文 + 偏好块，**原文件一个字节不改**；撤回时用原文件重写该副本。
- **撤回**：`revoke` 把 binding 标 `revoked`、快照写 tombstone、偏好块清空；之后 `export` 一律 `binding-revoked`。

## 3. 测试日志

```
$ node scripts/smoke-p42.mjs
ok  export succeeds with approved scope
ok  only exportable facts survive (3 of 7)
ok  secret-looking fact is not exported
ok  expired fact is not exported
ok  archived fact is not exported
ok  every skipped entry is reported
ok  block stays inside the 300 token budget
ok  model block does not carry machine-layer ids
ok  same facts give the same digest
ok  over-budget export is refused
ok  refusal names the budget code
ok  refusal shows a preview, not a silent cut
ok  binding over 8 entries is rejected
ok  supersede lands
ok  new task sees the successor text
ok  old decision no longer appears as current
ok  digest changes with the content
ok  a forked decision is reported as a conflict, not picked
ok  binding is refused from another workspace
ok  binding is refused for another consumer
ok  original persona file is untouched
ok  revoked block contains no preference text
ok  revoked persona copy contains no preference text
ok  revoked binding cannot export again
P42: 38/38
```

```
$ node scripts/run-all.mjs
pass  smoke-p41.mjs           13321 ms
pass  smoke-p42.mjs            2554 ms
43/43 passed
All smoke scripts passed.
```

E1-A 联动：`E1A: 30/30`（原始逐条结果与两次实际送达的提示词见 [evidence-bili/e1a-report.json](evidence-bili/e1a-report.json)）。

## 4. 实际送达的偏好文本

生成的文件（原人设 + 偏好块，`facts=3`，`blockTokens=195`）：

```markdown
<!-- dsh-trivium composed persona; snapshot=cp-61f7efcc-… at=2026-10-30T03:07:28.486Z -->
你是「测试鲸」，一个只做只读筛选的B站助手。语气简短，不夸大。

<!-- dsh-trivium consumer-preferences/v1 snapshot=cp-61f7efcc-… issued=2026-10-30T03:07:28.417Z expires=2026-10-31T03:07:28.417Z facts=3 -->
===== 用户已确认的偏好（供刷B站筛选使用）=====
以下是用户在 Trivium 里逐条确认、允许用于本次视频筛选的偏好；只用于挑选与解释，不得改写人格或扩权。
1. [soft] 技术视频更喜欢有实际演示，不只看标题。
2. [hard] 教程可以看，但纯念稿的教程每天最多一条。
3. [hard] 不要推荐已经看过的视频。
范围：bili-duty / video-curation；版本：fnv1a-231c1c3-5。
===== 偏好结束 =====
```

B 站插件侧收到的（它自己加的包装层，证明走的是**既有文件入口**）：

```text
===== 使用者的人设（读自 …/ws/.dsh/consumer-preferences/persona-with-prefs.md）（**按这个来**）=====
你是「测试鲸」，一个只做只读筛选的B站助手。语气简短，不夸大。
===== 用户已确认的偏好（供刷B站筛选使用）=====
1. [soft] 技术视频更喜欢有实际演示，不只看标题。
2. [hard] 教程和实际演示都可以。
3. [hard] 不要推荐已经看过的视频。
===== 偏好结束 =====
===== 人设结束 =====
下面是**值班章程**（里面的「<家目录>」已经替换成真实绝对路径了）—— 严格按它执行：
```

## 5. 更新与撤回

| 场景 | 结果 |
|---|---|
| 更新前 | 送 `教程和实际演示都可以。` |
| 在 Trivium 里把该决策替代为新版本 `教程可以看，但纯念稿的教程每天最多一条。` 后重新导出 | 新任务送**新句子**；旧句子不再出现；未改动的另外两条照旧送达；`snapshotId` 变了 |
| 撤回（`revoke`） | 同一入口的下一个任务**完全没有偏好块**（提示词 14703 字节里零命中），人设本体仍在；之后 `export` 直接 `binding-revoked` |

## 6. 隔离与安全边界（本次实测）

- 专用 `DSH_HOME`、profile、workspace、端口；真实 `~/.dsh` 未被写入。
- 插件配置显式关闭：`dmWatch=false`、`dmMode=off`、`autoComment=false`、`replyToComments=false`、`favFolderId=0`、`perDay=0`、`overlayMcp=false`（不挂 B 站 MCP，子任务手里没有任何平台工具）。本次未登录、未评论、未私信、未收藏、未发布。
- 子任务由插件真实启动：`--profile bili-duty`、`cwd=<state>/bili-duty`、`code=0`；请求里**没有任何 `ctx_*` 工具**，也没有 `.tdb` 路径。
- 模型侧零费用：子任务的模型路由被最后一层补丁指到本地桩（[原因见 7.1](#71-e1-a-是接线验证不是生产形态)）。

## 7. 未完成与限制

### 7.1 E1-A 是接线验证，不是生产形态

为了在**不改插件源码**的前提下把链路跑通，测试宿主加了三个**仅存在于 `.tmp/`** 的脚手架：

1. **服务垫片**：headless bundle 没有 `webServer / tools / settings`，而插件 `inject` 它们。垫片提供最小实现（含一个只为触发路由的本地 HTTP 服务），并调用插件**自己的** `POST /api/bili-duty/run`。
2. **dsh 包装器**：插件的 `bili-duty` profile 把模型路由固定到 `deepseek-account`，没有登录就直接 `ACCOUNT_SIGN_IN_REQUIRED`。包装器在插件自己的 `--patch` 之后追加一层 `agent-default-model → deepseek-official`，把任务指到本地桩；**提示词与启动参数原样透传**。
3. **手动冷却置 0**：为在同一轮做三次任务，把 `manualCooldownMin` 设为 0（这是插件的用户设置项，不是绕过安全检查）。

所以：**“偏好能被现有文件入口读进任务”是真实结论；“插件的 web 宿主下这条路已经完整可用”不是**。真实桌面/Web 宿主里 `webServer`、`settings`、`connection` 都在，垫片不需要，但也**没有在真实宿主里跑过**。

### 7.2 没有做的事

- **E1-B**：没有 provider 接口、没有快照校验、没有绑定展示与回执；`expiresAt` 目前**只是文本**，消费端不校验，过期不会被强制拒绝。
- **E2**：三臂对照（原生 / 普通文本 / Trivium 快照）、小样本筛选质量、费用对照全部未做；**不能宣称比普通文本更好或更省**。
- **E3**：没有真实 B 站只读冒烟，也没有宣传补拍。
- **Trivium 侧 UI**：只有 CLI（`dsh-trivium-prefs`），设置页入口、审批勾选、查看快照、暂停授权都未做；E1-A 的“用户手动配置插件人设路径”仍需手工操作。
- **自动更新导出文件**：未做。当前更新/撤回都要人工重跑 CLI 并让插件重新读文件。
- **自然语言 → 记住 → 消费**：未验证。本次是手工确认的合成偏好，不能替代抽取质量结论。
- **最小权限 profile 的回退**：插件在自己的模板铺不上时会退回普通 headless（能力更大）。本次模板铺上了，但没有验证“铺不上时必须停止”的门槛。
- **README / HOW_TO_USE 未更新**；CLI 还没有写进用户文档。

### 7.3 已知的实现取舍

- 只读打开工作区库：宿主正在写同一个 `.tdb` 时可能拿不到句柄，CLI 会明确报 `db-open-failed`，而不是偷偷用旧数据。
- `hard/soft` 由**用户在绑定时逐条选择**，不按 type 自动推断（`decision` 不必然是硬约束）。
- 偏好块整体 ≤300 估算 token 是**消费者任务的附加预算**，不等于 B 站任务总成本，也不进原会话的 300 账本。
- 偏好块每任务一次；同一任务重试会重新读文件，如果文件没变，内容相同（没有去重键）。

## 8. 复现

```bash
# 单元回归
node scripts/smoke-p42.mjs
node scripts/run-all.mjs

# 手工生成/更新/撤回（用户工作区）
node scripts/prefs-export.mjs init   --workspace <ws> --allow <id|uri|名称>... [--strength hard]
node scripts/prefs-export.mjs export --workspace <ws> --task <id> --persona <原人设.md>
node scripts/prefs-export.mjs status --workspace <ws>
node scripts/prefs-export.mjs revoke --workspace <ws> --persona <原人设.md>
```

E1-A 联动脚本与固定提交的插件检出都在 `.tmp/`（`bili-scaffold.mjs`、`bili/run-e1a.mjs`、`bili-src`），未纳入仓库。
