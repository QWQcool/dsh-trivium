# S0-4 证据：卡住检测与自愈（B5）

基线：S0-3 之后（`53f34d3`）。零模型调用、零费用（超时用假计时器即时触发，不真等 30 秒）。

## 修前

- 抽取没有超时：模型/引擎不返回，`runExtract` 就一直挂着，写锁也被一直持有，状态里看不出任何异常。
- 重放超 8 秒只写一条 `replay-timeout` 变更记录 + warn 日志，**没有"还在卡"与"已经好了"的配对**；
  下一条 `replay-timeout` 与它之间无法区分是同一件事还是新的一件事。
- 锁的 stale 回收在 `acquireWorkspaceLock` 里静默发生：没有任何输出能说明"上次进程死了、锁被回收了"。
- 没有"每类事件每会话只记一次"的约束：卡住的抽取每个 turn 都会重试，日志会被同一条冲爆。

## 修后

`lib/index.js`：

| 组件 | 作用 |
|---|---|
| `EXTRACT_TIMEOUT_MS = 30_000` | 抽取预算 |
| `STUCK_KINDS` | `extract-timeout` / `lock-stale` / `replay-timeout` |
| `raceWithTimeout(work, ms, {setTimer, clearTimer, now})` | 等到预算就返回 `{timedOut:true}`；正常返回 `{value}`；抛错返回 `{error}`（不会被误当成超时）；**不取消 work** |
| `staleLockInfo(cwd, {now, ttlMs})` | 只读探针：文件比 TTL 新 → 不 stale；持有者进程还活着（含 EPERM）→ 不 stale；死了/读不出 pid → stale |
| `openStuckKinds(entries)` | 从变更记录里按"每类最新一条"判断哪些还开着 |
| `createStuckMonitor({cwd, sessionId, status, record, now})` | `mark` 每类每会话一次；`recover` 只在开着时写；`seed` 从日志继承 |

`lib/change-log.js`：新增 `stuck` / `recovered` 两个 reason（p53 的"每个 reason 都要有中英标签"断言仍然成立）。

接线：

- `runExtract`：`raceWithTimeout(withWorkspaceLock(...), 30s)`。超时 → `mark(extract-timeout)`、`lastExtract.skippedBy:"extract-timeout"`、
  **窗口保持 pending**（不消费），并 warn。成功（`!llmFailed`）→ `recover(extract-timeout)`、`recover(lock-stale)`。
- 会话启动：先 `seed(openStuckKinds(readChanges(cwd)))`，再 `staleLockInfo` 检查；stale → `mark(lock-stale)` 并 warn。
- 重放超时：保留原 `replay-timeout` 变更记录，另记一条 `stuck`（按 kind 配对）；重放最后跑完且没有剩余窗口 → `recover(replay-timeout)`。
- `/status` 新增 `stuck` 与 `recovered` 两个字段；`stuck.open` 是当前仍开着的 kind 列表。
- 会话 dispose 时清掉该会话的 monitor（不跨会话泄漏）。

## 命令与输出摘要

```
node scripts/smoke-p76.mjs   → P76: 33/33
node scripts/run-all.mjs     → 77/77 passed（S0-3 后 76/76）
```

验收对照：

| 要求 | 实测 |
|---|---|
| 桩让抽取卡 30 秒 → 出现 stuck | `raceWithTimeout(永不 resolve, 30000, {假计时器})` → `{timedOut:true}`；`mark` 后 `status.stuck.kind="extract-timeout"`、`sessionId` 正确、变更记录里有 1 条 `stuck` |
| 每类每会话只记一次 | 第二次 `mark` 返回 false，记录条数仍是 1 |
| 下一轮正常并记 recovered | `recover` 返回 true、`status.recovered.afterMs=5000`、`open` 清空、恰好 1 条 `recovered`，且 stuck/recovered 的 opId 不同 |
| 重放超预算 | `openStuckKinds` 能从日志认出 `replay-timeout` 仍开着，下一会话 `seed` 后 `recover` 关闭它，之后日志只剩另一个 kind |
| 锁未释放超 TTL | 新鲜锁不 stale；超 TTL 但持有者是本进程 → 不 stale；超 TTL + 持有者 999999 不存在 → stale；锁文件是坏 JSON → stale |
| 不改锁 TTL | `LOCK_TTL_MS === 30_000` |
| 自愈仍然有效 | 用现有的 `acquireWorkspaceLock` 接管 stale 锁成功 |

## 未覆盖 / 已知边界

1. **超时不会终止抽取**：`distill` 直接写引擎，无法安全取消；超时只是"不再等 + 记为卡住"。被放弃的那次运行仍持有写锁直到它自己结束，所以"下一轮"要么成功、要么报 `lock-busy`，不会出现两个写者。
2. **没有真机 30 秒证据**：p76 用假计时器验证决策路径；真实 30 秒卡顿的日志形态（模型不返回 vs 引擎不返回）未采集。
3. **`recover` 的语义是"本轮跑通了"**：不区分"锁被别人抢走后重试成功"与"锁本来就好"，因为两者对用户的结论相同。
4. **seeded 的 stuck 没有本地起始时间**：`afterMs` 为 null（不是 0），避免伪造一个"刚卡住"的时长。
5. **重启后的自愈依赖变更记录可读**：日志损坏时 `seed` 静默跳过（不阻塞启动），此时跨进程配对失效。
