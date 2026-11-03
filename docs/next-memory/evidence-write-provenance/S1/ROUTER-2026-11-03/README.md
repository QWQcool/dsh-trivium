# 阶段 1 后半（B）原型：Router 单点写（2026-11-03）

基线 `main` @ `c40bc90`。零模型调用、零费用；只在本机临时工作区与命名管道上跑。

## 修前

一个 work item 目录里的 Worker 只有两条路：

1. 自己开库写 → 第二个写者被引擎拒绝（`TDB_ERROR: Database locked`），或抢不到文件锁；
2. 抢不到 → 窗口留 pending，等下一次事件再试。

第 2 条在长命会话里没问题，在短命目录里就是丢事实（`S1/CONCURRENCY-2026-11-03`：真实延迟下 78% 的抽取被推迟）。

## 修后（原型）

新增 `lib/router.js`：

| 组成 | 作用 |
|---|---|
| `routerEndpoint(cwd)` | 每个工作区一个端点：Windows 命名管道 `\\.\pipe\trivium-router-<hash>`，其它平台 `$TMPDIR/trivium-router-<hash>.sock` |
| `startRouter({cwd, db?})` | 打开（或接收）**唯一**的库句柄，按**到达顺序逐个**执行 `insert / merge / link / update`，`close()` 时先停服务再关库 |
| `createRouterClient({cwd})` | 返回满足 `MemoryWriter` 端口的 `writer`（`kind: "router"`），可直接喂给 `distill({writer})` |

两条硬规矩：

- **不静默回退**：连不上就 `ROUTER_UNAVAILABLE`，绝不偷偷写本地库——那正是这一片要消灭的"以为走的是中央写、其实写了自己"；
- 错误带 code 回传（未知操作 `ROUTER_UNKNOWN_OP`、坏请求 `ROUTER_BAD_REQUEST`），调用方拿到的是 rejection 而不是"看起来成功"。

## 数字

同一份基准，`node scripts/bench-lock-contention.mjs`（3 个 Worker × 10 次、轮间隔 800 ms）：

| 模式 | 抽取 50 ms | 抽取 400 ms | 抽取 1500 ms（真实模型级） |
|---|---|---|---|
| 锁（现状）落库 / 尝试 | 29/36 | 17/36 | **8/36** |
| Router 落库 / 尝试 | **30/30** | **30/30** | **30/30** |

即：真实模型延迟下，现状只完成约 22% 的抽取，Router 完成 100%。墙钟上 Router 更慢（25.4 s vs 16.7 s），因为**它把活干完了**——现状之所以快，是大部分尝试在抢锁阶段就直接放弃了。

## 验收

```
node scripts/smoke-p81.mjs   → 12/12（连跑两次一致）
node scripts/run-all.mjs     → 82/82（改前 81/81）
```

p81 覆盖：

| 断言 | 说明 |
|---|---|
| 没有 Router 时 `ROUTER_UNAVAILABLE` | 且**没有**在工作区建出本地库 |
| `writer` 通过 `memoryWriterFor` 校验 | 端口形状一致，缺方法仍 `WRITER_INCOMPLETE` |
| 顺序写：id 单调、各不重复 | 调用方等待时顺序保持 |
| 2×10 并发写：20 个不同 id，库中 25 条（含前 5 条） | **一次不多、一次不少** |
| 落库 id 集合 == 调用方拿到的 id 集合 | 谁写的、写没写，可对账 |
| 未知操作 / 坏 JSON → 带 code 的失败 | 错误通道确定 |
| `close()` 后新客户端连不上 | 端点确实释放 |
| 端点按工作区稳定、互不相同 | 不会串库 |

## 未覆盖 / 已知边界

1. **没有接进插件**：`runExtract` 仍走 `distill({db})`。接入需要宿主形态（谁常驻、谁短命），
   现阶段接进去只会多一层进程而没有调用方。
2. **没有鉴权**：命名管道/套接字只靠本机同用户隔离；同机的其它进程可以连。原型阶段接受，落地前要加令牌。
3. **排队没有上限**：Router 无背压，突发写会全部堆在内存里。
4. **队列不持久**：Router 进程崩溃时，已排队未执行的请求丢失；调用方会收到 rejection，需自己重试。
5. **只覆盖抽取的四个写操作**：导入、芯片新增、替代/撤销、面板编辑仍直接写库。
6. **队列深度与延迟未测**：本次没有测"100 个并发写"的 p50/p95。
7. **单工作区假设**：一个 Router 只服务一个 `cwd`；多工作区要多个 Router 或按 cwd 分表。
