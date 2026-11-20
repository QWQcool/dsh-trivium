# 实体面板错误态实机验证（2026-11-20）

对象：npm `dsh-trivium@0.9.2`（TDB 0.9.2）在官方 `dsh web` 宿主中的 HTTP 层行为。目标是把 `p101` 里"组件按状态码显示文案"的另一半补上：真实宿主到底返回哪些 envelope、耗时多少、哪些状态在小合成库里根本产生不了。

本轮**没有**驱动面板界面（原因见第 4 节），因此「真实宿主 + 真实界面」仍缺一环；已确认的是真实宿主 + 真实插件 + 真实 HTTP 栈。

## 1. 环境

| 项 | 值 |
|---|---|
| 宿主 | `dsh web`（DeepSeek Harness `0.2.2-rc.3` 自带 CLI），`--profile p0 --no-open --port 7800` |
| `DSH_HOME` | 隔离目录 `.tmp/p0/home`，profile 从官方 web 模板新建 |
| 插件 | `dsh-trivium@0.9.2`，从 npm 安装到该 profile（`--ignore-scripts`） |
| 内核 | `triviumdb@0.9.2` |
| 数据 | 合成库 `ws-big`：实体 `#101` + 1200 条一跳事实（共 1202 节点）；`ws-small`：空库但已登记 |
| 认证 | 回环 + 宿主一次性 token（`Authorization: Bearer`） |
| 模型 / embedding | **0 次**（全部请求 `semantic:false`；未配置 provider） |

复现：

```sh
node scripts/verify-panel-errors-live.mjs --seed .tmp/p0/ws-big --facts 1200
node scripts/verify-panel-errors-live.mjs --base http://127.0.0.1:7800 --token <TOKEN> \
  --cwd .tmp/p0/ws-big --unopened .tmp/p0/ws-small --out .tmp/p0/errors.json
```

## 2. 实机结果

| 场景 | 实际返回 | 耗时 | 面板对应文案（`p101` 覆盖） |
|---|---|---|---|
| 1202 节点范围检索 | `422 ENTITY_SEARCH_WORK_LIMIT` | 27 ms | 「范围过大，请缩小实体或减少预算」 |
| 8 个并发检索（同上范围） | 8 × `422`，**无一例 429** | 27–316 ms | — |
| 未打开的工作区 | `409 WORKSPACE_NOT_OPEN` | 1 ms | 「先在宿主中打开该工作区」 |
| 空库 + 不存在的实体 | `404 ENTITY_SEARCH_ENTITY_NOT_FOUND` | 22 ms | 「范围内没有这个实体」 |
| 空库 + `snapshotId:"latest"` | `404 SNAPSHOT_NOT_FOUND` | 2 ms | 「没有可用的快照」 |
| 大范围 + `snapshotId` | `422 WORK_LIMIT`（预算先于快照解析） | 968 ms | 同上 |

**未能复现**：

- **429 `READ_BUSY`**：读准入按"同一工作区同时只允许一个读"设计，但 Node 单线程里 `searchEntity` 是同步 CPU 工作，8 个并发请求实际串行进入，不会重叠；只有存在异步等待（语义 embedding）时才会重叠。本轮未配置 provider，`semantic:true` 直接走词面/预算路径，因此没有产生 429。**结论：429 仍只有组件级证据（`p101`），不是实机结论。**
- **408 `ENTITY_SEARCH_TIMEOUT`**：超时窗口是 150 ms CPU / 15 s 总时，但 1000 节点预算会先于 150 ms 触发（1202 节点 27 ms 就 422）。要产生 408 需要"节点、边、payload 都在预算内但耗时超窗"，当前合成库和本机磁盘做不到。**结论：408 未实机复现。**
- **409 `ENTITY_SEARCH_SCOPE_CHANGED`**：需要请求等待期间实体指纹变化（语义等待或快照确认窗口）。本轮无等待窗口，未产生。
- **迟到应答、乱序应答**：需要两个真实在飞请求，同上受串行执行限制，未复现。

## 3. 说明：为什么"大范围"总是 422

`ENTITY_SEARCH_LIMITS` 固定为 `nodes:1000 / edges:10000 / payloadBytes:512KB / cpuMs:150 / totalMs:15000`，HTTP 调用方不能覆盖。因此：

- 范围超过 1000 个一跳节点 → 必然 422，和耗时无关；
- 想要 408，必须让工作"合法但慢"，小库上不可控；
- 想要 429，必须有异步等待点，否则请求天然排队。

这是设计如此，不是缺陷；但对验收意味着**错误态的可复现性依赖于库的形态**，不能只靠"跑一次大库"。

## 4. 界面层：本轮未驱动

- playwright 的 Chromium 构建缺 `icudtl.dat`，`--headless` 直接报 `Invalid file descriptor to ICU data`；
- 改用本机 Edge 会挂到用户自己的浏览器会话（实测出现了用户已有标签页与扩展），不适合做自动化；
- 官方桌面应用的 CDP 路线可行（此前的桌面验收用过），但本轮时间用于其余阶段，未执行。

因此**没有**"真实界面 + 真实后端"的截图证据。面板文案与状态码的映射仍以 `p101` 的组件级测试为准。

## 5. 结论

1. `422 WORK_LIMIT`、`409 WORKSPACE_NOT_OPEN`、`404 ENTITY_NOT_FOUND`、`404 SNAPSHOT_NOT_FOUND` 已在真实宿主上产生并核对，耗时分别是 27 / 1 / 22 / 2 ms。
2. `429`、`408`、`409 SCOPE_CHANGED`、迟到/乱序在单机小库上**不可达**，原因已定位到"同步执行 + 固定预算"，不是随机失败。
3. 下一轮若要闭合：需要 (a) 一个可注入延迟的 embedding provider 产生 429/408 窗口，或 (b) 宿主侧故障注入；(c) 桌面 CDP 驱动界面。
