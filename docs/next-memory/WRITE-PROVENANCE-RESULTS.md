# W1–W5 交付结果（写入准确性、来源定位与变更记录）

基线 `db35034`（0.8.2）。分支 `codex/r1-r2-reliability`。本批**未发布、未改版本、未动默认开关/四工具/内核 pin/DIM**。
模型调用 **0 次**，费用 **¥0.00**；宿主级验证全部使用隔离 `DSH_HOME` + 本地可控桩，未读取或复制真实凭据。

## 1. 文件与原因

| 文件 | 变化 | 原因 |
|---|---|---|
| `lib/source-events.js`（新增） | 从宿主事件提取 `seq / messageId / at / role`；`appendSourceTurn` 去重；`matchQuote` 只认用户轮；`buildSource` 输出三态（已记录 / 摘录匹配 / 能否回读原文） | F-W03：来源没贯穿到事实 |
| `lib/index.js` | 缓冲改走 `turnFromEvent`；`lastExtract` 补 `superseded`；写审计；重放超时记 `replay-timeout` | F-W03/F-W04 |
| `lib/extract.js` | 候选来源改用 `buildSource`；替代判定改为"用户原句 + 唯一目标"；歧义转待确认；日期清洗改为锚定来源句 | F-W01/F-W02/F-W03 |
| `lib/date-parse.js`（新增） | 固定时区 Asia/Shanghai、周一为周起点、只认确定性表达、非法日期单列 | F-W02 |
| `lib/provenance.js` | 读投影暴露 `locatorKnown / seq / at / role / quoteMatch / hostText`，旧节点降级为 unknown | F-W03 |
| `lib/store.js` | `updateNode` 支持 `review`；短地图跳过已替代与待确认的决策 | F-W01 |
| `lib/change-log.js`（新增） | 每工作区 JSONL 审计，200 条上限 + trim 标记，落盘前脱敏，`opId` 幂等 | F-W04 |
| `lib/server.js` | `GET /api/dsh-trivium/changes` | F-W04 |
| `lib/client.js` | 召回页新增"记忆变化"块（中/英、来源、超期提示） | F-W04 |
| `scripts/smoke-p50/51/52/53.mjs`（新增） | W1/W2/W3/W4 回归 | — |
| `scripts/smoke-p48.mjs` | 契约纠正：同名多目标不再串链，改为待确认 | F-W01 |
| `scripts/smoke-p49.mjs` | 契约纠正：相对日期必须给来源时间 | F-W02 |
| `scripts/smoke-p18.mjs` | UI 契约：召回页多取 changes；新增 4 条结构断言 | F-W04 |

## 2. 修前 / 修后回归

| 片 | 修前 | 修后 |
|---|---|---|
| W1 | p50 无法运行（模块不存在）；写入节点来源只有 `{kind,via,sessionId,quote,capturedAt}`，`hasLocator:false` | p50 **47/47** |
| W2 | p51 **12/14 失败**：讨论/假设/引用/否定/保持原样都会被退休；同名目标被串链；模型自造 quote 也能退休 | p51 **14/14**；p48 12/12 |
| W3 | 计划期反例：`明天复盘` 放行 `2027-03-01` 且无 adjusted | p52 **20/20**；p49 17/17 |
| W4 | 审计不存在；`superseded` 在 `lastExtract` 里丢失 | p53 **30/30**；p18 48 checks |
| W5 | — | 宿主闭环 **11/11**（1 项记为 finding） |
| 全量 | 50 组 | **54/54** |

`node scripts/verify-evidence.mjs` → 9/9；`git diff --check` 干净。

## 3. 验证层级

| 层 | 覆盖 | 状态 |
|---|---|---|
| 纯函数/模块单测 | 事件解析、摘录匹配、去重、日期解析、审计写入/裁剪/脱敏/幂等 | 已自验 |
| 抽取管线（内存库 + 桩模型） | W1–W4 全部断言 | 已自验 |
| 隔离真实宿主 + 可控桩（headless `dsh`） | 写入带来源、审计落盘、新会话短地图、重放超时可见、工作区隔离 | 已自验 |
| HTTP 路由 `/changes` | 只做源码与返回结构检查 | **未实测** |
| UI 视觉/键盘/明暗主题 | 未做截图，未走 Tab/Enter/Escape | **未验** |
| 真实模型（付费） | 本批明确不跑 | **未做** |

宿主闭环细节（`evidence-write-provenance/W5/report.json`）：节点来源含
`{seq:11, messageId:28bc9c53…, at:2026-10-30T09:18:00Z, role:user, quoteMatch:exact, capturedAt:…, hostText:unavailable}`；
审计条目带同一 locator；新会话请求里出现 `decisions=1` 的地图并包含事实正文；重放被拖到 12 秒时**轮次仍然完成**（exit 0）且审计出现 `replay-timeout`。

## 4. 成本

| 项 | 数值 |
|---|---|
| 真实模型调用 | 0 次 |
| 费用 | **¥0.00** |
| 宿主进程启动 | 约 10 次（本地桩，无外发） |
| 凭据 | 未复制、未读取；隔离 home 无 `.credentials.yaml` |

## 5. 仍未解决（F-W 编号）

| 编号 | 状态 | 说明 |
|---|---|---|
| F-W01 | 已修（待独立验收） | 讨论/否定/假设/引用/保持原样不再退休；歧义转待确认。**未覆盖**：`ensureLink` 抛错分支没有故障注入用例 |
| F-W02 | 已修（待独立验收） | 锚点改为来源事件时间；宽区间放行删除。**未覆盖**：`N 天后`、`下月 N 号`、时区可配置 |
| F-W03 | 已修（待独立验收） | 来源贯穿到节点与审计；`hostText` 恒为 unavailable（宿无回读接口，不伪造跳转） |
| F-W04 | 部分完成 | 审计与 UI 块已实现（模块/源码层自验）；**HTTP 路由未实测，UI 未做视觉与键盘验收**；"恢复中/恢复失败"只落一条记录，无专门图标 |
| F-W05 | **已修（方案 A）/ 归因已更正** | 原判断"两个进程各写一份"是错的：引擎本来拒绝第二个写者（`already opened with an incompatible access mode`），W5 里的 `copies=2` 其实是规则层与模型各写一份。真实问题是第二个进程直接崩掉。现在锁在**开库之前**获取，失败方不打开库、保留 pending、记 `lock-busy`。见 [W6 证据](evidence-write-provenance/W6/README.md)。仍限：只覆盖抽取写入，`ctx_remember` 与导入未纳入 |
| F-W06 | **已修** | 锁文件根版本同步到 0.8.2（`npm version 0.8.2 --allow-same-version --no-git-tag-version`），提交 `c9b6e23` |

## 6. 状态口径

- **已实现**：W1–W4 的代码与回归、W5 的宿主闭环脚本。
- **已自验**：p50/p51/p52/p53/p18/p48/p49 与全量 54/54、宿主 11/11。
- **待独立验收**：以上全部结论都出自本次执行方，没有第三方复跑；HTTP 路由与 UI 渲染明确未验。
- **未发布**：没有 npm publish、没有 GitHub Release、没有移动 tag、没有改版本号；`main` 未合并（本轮提交只在工作分支）。

## 7. 真实模型复测安排（建议，未执行）

准入条件：F-W01/W2/W3 任一再被独立复现为"隐藏了仍有效的事实"或"写入错误日期"，则不进入。

| 步骤 | 内容 | 预算 |
|---|---|---|
| 1 | 冻结本批回归与反例集，先跑 `run-all` + 宿主闭环（零费用） | ¥0 |
| 2 | 单场景冒烟：改口 1 次、相对日期 1 次、否定 1 次（真实模型） | ≤ ¥0.05 |
| 3 | 若冒烟无回归，跑 3 场景 × 5 次质量对比（与 A-10 同夹具） | ≤ ¥0.30 |
| 4 | 仅在 3 通过后，才评估跨压缩与长会话 | 另行申请 |

约束：单次运行 ≤¥3、当日累计 ≤¥10，脚本带 `--budget` 熔断；运行期复制凭据、`finally` 删除并核对真相库 mtime；证据目录不可覆盖。
