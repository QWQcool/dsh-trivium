# 实体范围检索的只读面板入口

> 状态提示（2026-11-16）：以下保留原日期的发布/测量记录；文中的“当前、下一步”和旧脚本文件名按当时理解。现状见 [CURRENT-STATE](../CURRENT-STATE.md)，当前运行方法见 [DEVELOPMENT](../DEVELOPMENT.md)。

2026-11-16 补充：桌面 `0.2.2-rc.3` 在合成工作区已实际点击验收。两组实体的 live 结果未串范围，缺失 ID 显示 404；快照与 live 均返回正确关系和词面结果。界面编辑记忆后，live 返回新正文而之前创建的快照仍返回旧正文，检索未请求 embedding。尚未逐项验证工作区切换和 409/422/429 等错误态。

2026-11-13。基线 `main@f2dcfe9`，TDB 0.9.0。本轮只加设置页「上下文」的一张只读卡片，复用已验收的 `POST /api/dsh-trivium/entity-search`。未改 `ctx_find`、工具 schema、自动召回、默认排序、后端校验与预算；未发版，未部署到常用宿主。

## 改了什么

- `lib/client.js`：新增 `entitySearchCard()` 与 `runEntitySearch()`，挂在「上下文」页事实查询卡之后。
  - 输入：实体 ID（正整数）、问题、每路条数（1–20，默认 5）、语义开关（默认关）、来源 live / 固定快照（留空选最新）。
  - 请求体只含端点字段 `entityId`、`query`、`limit`、`semantic`；快照来源另加 `snapshotId`。
  - 结果：词面与语义两列分开展示，各自显示条数、截断标记、分数口径（lexical / cosine）、真实关系路径、期限与 review 标记。
  - 固定显示 `answerability: not_assessed` 的说明；`scope_anchor_only` 与 `no_candidates` 分别给出对应文案。
  - 错误映射：400 输入、404 实体不存在、409 实体不可用或范围/来源/配置变化、408 超时、413 响应过大、422 预算、429 读通道忙、`SNAPSHOT_NOT_FOUND`。
  - 切换工作区时清空输入与结果；响应回来时再核对 cwd 与请求序号，迟到响应不会落到另一个库。
- `docs/read-api.md`：在端点说明里补一句面板入口，HTTP 契约未变。
- `docs/next-memory/CURRENT-STATE.md`：更新「main 领先发布包」与 P1 待办的状态。

## 没改什么

- 后端 `lib/entity-search.js`、`lib/entity-search-snapshot.js`、`lib/entity-search-worker.mjs`、`lib/read-api.js` 零改动。
- 四工具定义与 `TOOL_SCHEMA_BASELINE.json` 零改动。
- 默认排序、自动召回、`ctx_find` 零改动。
- 没有新增脚本或测试，`scripts/` 仍 120 个 `.mjs`。

## 验证

| 检查 | 结果 |
|---|---|
| `node --check lib/client.js` | 通过 |
| `node scripts/run-all.mjs` | **85/85** |
| `node scripts/smoke-p78.mjs`（真实组件的结构渲染，含上下文页） | **56/56** |
| `validateEntitySearch` 对前端请求体 | 通过；`limit=21` 与空问题按 400 `ENTITY_SEARCH_INVALID` 拒绝 |
| `npm pack --dry-run` | 60 文件，`lib/client.js` 在包中 |

面板只在既有结构渲染用例里被执行到（p78 未扩充断言），**尚未在真实宿主里点击走查**。本轮没有部署到常用宿主，也没有新增 UI 测试（按仓库测试边界）。真实宿主的截图、语义开启/关闭、409/422/429 错误态与快照来源需要下一轮部署后人工验收。

## 剩余边界

- 卡片不做融合排序，也不判断可回答性；两列分数不可比，近邻不等于答案。
- 语义通道默认关；未配置时勾选会得到「降级 + 同一范围词面结果」，不会静默切换来源。
- 大库与预算拒绝的实际体验仍需真实负载；错误文案只保证与端点错误码一一对应。
- 实体 ID 仍需人工从记忆列表获得，本卡没有做「从选中条目带入」。

---

## 2026-11-16 验收：工作区隔离、迟到响应、来源与错误态

本轮只做验收与测试，**未修改 `lib/client.js`、后端、工具 schema 或默认排序**。基线 `main@39ef51c`，TDB `0.9.1`，桌面 `0.2.2-rc.3`，桌面 profile 内插件为本地 tarball `20261116-echo-8b8840b31c34/dsh-trivium-0.8.9.tgz`（含记忆回显修复，面板代码与 `47b0174` 相同）。

### 新增受控组件测试

`scripts/smoke-p101.mjs`（21 项）用与 p78 相同的小型 hook/JSX 运行时渲染真实组件，但把 `fetch` 换成可挂起、可乱序应答的替身；每次「运行实体检索」的请求都由测试决定返回时机和内容。它覆盖：

| 场景 | 断言要点 |
|---|---|
| 默认成本 | 未勾语义时请求体恰为 `{entityId, query, limit, semantic:false}`，只发 1 个 POST，未访问任何 embedding 端点 |
| 正常结果 | 词面/语义两列分开、条数、`lexical` 分数口径、`分数 0.7100`、关系路径、`范围：… 可读 3 / 记录 4 条`、`embedding 0 次`、固定 `answerability: not_assessed` 文案 |
| 空结果 | `no_candidates` 显示「本次范围内没有候选」且不显示为失败；`scope_anchor_only` 显示范围只有自身且说明语义通道已跳过 |
| 降级 | `degraded` + `semantic.status=disabled` 显示「语义通道不可用（disabled）…已保留同范围词面结果」，词面候选仍在 |
| 工作区切换 | 请求 URL 的 `cwd` 与发起时一致；切到 B 后实体 ID 与问题字段为空、旧结果与旧错误清除、Idle 文案恢复 |
| 迟到成功/迟到错误 | A 的迟到结果与迟到 409 都不能落到 B，也不影响 B 正在进行的请求和忙碌态 |
| 同工作区内乱序 | 先发慢请求、改输入后再发新请求，先答新、后答旧：旧结果不能覆盖新结果 |
| A→B→A 往返 | 回到同一 `cwd` 后，切换前发出的应答仍被序号守卫丢弃（只靠 cwd 比较的实现会在此失败） |
| 来源隔离 | 固定快照请求体带 `snapshotId`；快照结果显示「快照时间（有效期按此时判断）」与快照 ID；`SNAPSHOT_NOT_FOUND` 显示缺快照文案且**不**回退 live（请求数仍为 1）；切回 live 不带 `snapshotId`，快照正文不残留 |
| 错误态 | 400 `ENTITY_SEARCH_INVALID`、404 `ENTITY_SEARCH_ENTITY_NOT_FOUND`、409 `ENTITY_SEARCH_SCOPE_CHANGED`、422 `ENTITY_SEARCH_WORK_LIMIT`、429 `READ_BUSY`、408 `ENTITY_SEARCH_TIMEOUT` 各自一条 alert，带状态码与错误码，**每次运行只发 1 个请求、不自动重试**，失败时不渲染候选 |
| 输入校验 | 空 ID、`0`、`limit=21` 时按钮禁用并显示统一提示，请求数为 0 |

变异验证（临时改坏生产代码后复原，`git diff lib/client.js` 为空）：去掉 `seq !== esSeq.current` 序号守卫后「同工作区乱序」与「A→B→A 往返」两项失败；去掉 `resetReadCaches()` 里的 `clearEntitySearch()` 后「工作区切换」与 A→B→A 两项失败。说明这些断言确实能复现原问题。

### 真实桌面（独立 DSH_HOME + 合成工作区）

用临时 `DSH_HOME`、复制一份桌面 profile（同一已安装插件）启动 `DeepSeek Harness.exe --remote-debugging-port`，通过 CDP 发送真实鼠标/键盘事件操作界面；两个合成工作区各用 `store.openWorkspaceDb` + `insertWithId` 造 4 个节点，**实体都是 `#101`、事实都是 `#201`，正文不同**（Alpha 24 小时 / Beta 5 分钟）。全程未登录、未调用模型、未请求 embedding。

| 步骤 | 预期 | 实际 |
|---|---|---|
| 打开「Trivium 记忆 → 上下文」 | 实体检索卡渲染 | 通过；卡片字段、只读标记、Idle 文案均在 |
| wsA 正常检索（`#101`，问题「报告游标能复用多久？」） | 返回 Alpha 事实 | 通过：`live · Alpha 服务`、`范围 3/3`、`embedding 0 次`、`词面候选 · 1`、`#201 报告游标`、`#101 —about→ #201`、`answerability 固定为 not_assessed`、`未请求语义通道（默认）`、`语义候选 · 0` |
| 「事实查询 → 创建并选用快照」后按快照检索 | 绑定固定快照 | 通过：`snapshot · Alpha 服务`、`快照时间（有效期按此时判断） · 2026-11-16T11:32:54.081Z`、`snapshot-4bfa8f40-…` |
| 在记忆库把 `#201` 正文改成 6 小时并保存 | live 变、快照不变 | 通过：live 返回「复用 6 小时（界面已改…）」（`查询时间 11:34:45`）；同一快照仍返回「复用 24 小时…」（快照时间 11:32:54）。节点数保持 4 |
| 用面板「工作区」下拉切到 wsB | 旧输入/结果清除，请求绑定 B | 通过：实体 ID 与问题字段清空、Alpha 结果消失、恢复 Idle；随后检索返回 `live · Beta 服务` 与 Beta 正文，页面上无 Alpha 正文 |
| 切回 wsA 再检索 | 回到 Alpha | **未在桌面重复**：桌面只做了 A→B；回到 A 后的检索只有受控测试覆盖（p101 的 A→B→A 用例验证的是旧应答被丢弃，不是再次检索）。 |

截图：[ENTITY-SEARCH-PANEL-2026-11-16-wsB.png](ENTITY-SEARCH-PANEL-2026-11-16-wsB.png)（真实桌面，wsB 检索结果）。

**本轮真实桌面没有触发**：409/422/429/408、乱序应答、`no_candidates`/`scope_anchor_only`、缺快照、语义降级、非打开工作区的 `WORKSPACE_NOT_OPEN`。这些只在受控组件/HTTP 测试（p101、p93）中覆盖，不能算作桌面实机通过。

### 本轮发现

1. **先前遗留的库损坏（非本轮造成）**：桌面此前默认工作区 `Documents/deepseek-harness/default-workspace/.dsh/trivium.tdb`（2026-11-09）打开即报「文件损坏 (Corrupted file): 检查点向量文件缺失」，`/api/dsh-trivium/status` 在未显式 `cwd` 时因此返回 500。本轮只读访问，未修复、未删除、未改动该库。
2. **隔离泄漏（真实、未修）**：插件设置文件固定为 `~/.dsh/trivium.json`（`homedir()`），不随 `DSH_HOME` 变化。隔离 `DSH_HOME` 下进入合成工作区时，插件把该路径写进了真实家目录的设置文件；`rememberWorkspace` 的临时目录守卫没有拦住（应用进程的 `tmpdir()` 与 `%LOCALAPPDATA%\Temp` 不同）。本轮结束前已把新增的两个条目从该文件移除，恢复原来的两条记录；本轮未改插件行为。
3. 夹具方向修正：真实后端把路径渲染成「锚点 → 候选」（`#101 —about→ #201`），p101 的夹具原来写成候选→锚点，已按真实返回值调整，避免伪造方向。

### 回归

| 命令 | 结果 |
|---|---|
| `node scripts/smoke-p101.mjs` | **21/21** |
| `node scripts/smoke-p78.mjs` | **56/56** |
| `node scripts/smoke-p93.mjs` | 通过（实体检索协议段 36/36） |
| `node scripts/run-all.mjs --list` | 88 个逻辑用例 / 71 个文件（新增 p101） |

### 未完成 / 未测

- 未在用户日常使用的 profile 上重复以上步骤；本轮用独立 `DSH_HOME` + 复制的 profile，避免写入用户记忆。
- 桌面未覆盖语义通道真实降级（仍为离线替身验证，按交接要求不调用真实 embedding 服务）。
- 临时目录 `%TEMP%\dsh-verify-1116192543`（合成工作区 + 复制 profile）因删除需要交互确认而保留，可随时手动删除。
