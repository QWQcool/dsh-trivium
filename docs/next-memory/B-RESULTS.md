# B 批回交结果（B1–B5）

日期：2026-10-28。基线 `3969b7b`（0.7.1 已发布基线 + README 截图更新），分支 `main`。
本批不发布 npm、不改版本号、不加工具、不加服务。

## 基线与范围

- 插件 / 内核 / 运行时：`dsh-trivium@0.7.1`（工作树，未发版）、`triviumdb@0.9.0-beta.3`（精确 pin）、Node 24、ESM。
- 宿主：Web `@deepseek-ai/dsh@0.2.1-rc.4`（真机）；桌面端本批未重跑。
- package / lock / 数据格式 / 默认开关：**未改**。JSON 图 `version:2` 与 JSONL `v:2` 未动；
  抽取开、自动召回/芯片/会话层/Git 旁路写出/远程 embedding 仍关；四工具与共享 300 估算预算未动。
- 已完成：B1–B5 五片，各自一个提交。未完成：见「未覆盖」。

| 片 | 提交 | 一句话 |
|---|---|---|
| B1 | `e1474be` | 0.8.0 交互原型（16 态）+ B 批执行计划 |
| B2 | `b888b85` | 工作区选择器、页面顺序、tab 键盘 |
| B3 | `61e6f4f` | 统一操作回执 |
| B4 | `e7252c2` | 导入只读预览 + 指纹 |
| B5 | `941eea8` | 每轮实际投递记录 |

## 缺陷与改动证据

### B2 · 设置页把维护放在日常之前，且工作区不可切换

- 修复前：`TriviumCard` 依次渲染「检查更新 → 300 行配置折叠 → tab → 条目」，改一条记忆要越过三块维护内容；
  面板首次看到 `status.cwd` 就锁进 `workspaceRef`，其它会话切换 activeCwd 后无法在面板里换库。
- 根因：页面顺序是 JSX 顺序；`/status.workspaces` 只返回 `listOpenWorkspaces()`（已打开的库）。
- 改动：`lib/server.js` 新增 `knownWorkspaces()`（已打开带 nodeCount，未打开标 `nodeCount:null`）；
  `lib/client.js` 新增 `selectedCwd/selectedCwdRef`、`applyWorkspace/switchWorkspace/saveDraftsThenSwitch`、
  `resetReadCaches`，页面顺序改为「工作区条 → 回执/错误 → 记忆 tab → 条目 → 维护」，
  tab 变 roving tabindex + ←/→/Home/End。
- 修复后断言：p26「workspace picker … switching rebinds every request」——切换后 status/nodes 都带新 `cwd`，
  旧节点从树里消失；「unsaved draft blocks the switch」——有草稿时**不发出** status 请求，选择后才发。

### B3 · 写操作有四种互不相干的反馈

- 修复前：`setError` 红字、`setSaved` span、`revisionNote` 行、导入字符串；`importJson` 成功不显示计数且 `r.ok` 分支是死代码
  （`api()` 失败已抛错）。删除确认只说「1 项」。
- 改动：`api()` 把 `status`/`code` 附在错误上；新增 `receipts`（有界 20 条）与 `pending/saved/rejected/waiting/failed`；
  保存/归档/删除/合并/旁路/导入/外部导入全部产生回执，目标只放 `#id · name · type`；
  删除确认显示具体对象；导入成功显示服务端计数，派生失败时给出「事实已提交、不要重复导入」的恢复说明。
- 修复后断言：p26 归档→`saved`、409→`rejected` 且保留 `REVISION_LINKED`、取消删除无请求无回执、
  导入派生失败同时出现 counts 与 recovery、非法 JSON 不发请求（`BAD_JSON`）。

### B4 · 导入点下去就写库

- 修复前：`POST /import` 直接 `importGraph()` 提交；无 dry-run。
- 改动：`lib/store.js` 把预检段抽成 `planImportGraph()`（只读；身份映射、id 预分配、整图结构、冲突），
  `importGraph()` 变成「同一份 plan + 单事务」；新增 `dbFingerprint()`（FNV-1a over id/type/status/uri/updatedAt/出边 label）。
  `POST /import {preview:true}` 返回 `{dryRun, preview:{created,updated,archived,relations}, fingerprint}`；
  提交可带 `expectFingerprint`，不符返回 409 `STALE_PREVIEW`。
- 修复后断言：p26 后端块——`planImportGraph` 后 `nodeCount` 与指纹都不变；同图提交后 created=2；
  拿旧指纹提交 → `STALE_PREVIEW` 且节点数不变；再预览同文件 → created=0 / updated=2。
  真机：导入合成文件显示「新增 2 · 关系 +1 业务边」，`status.nodeCount` 仍 16；取消后仍 16。

### B5 · 「召回检查」把三种问题混在一张卡里

- 修复前：只有 `lastContextPlan`（最近一次规划）与 `recall-preview`（假想），没有任何「真正送达」的记录。
- 改动：`turn-ledger` 在 `commit()` 里记录 `turnRecords`（只有真正投递成功的块），`beginTurn` 清空；
  新增 `turnSessions(cwd)` 与 `GET /turn?cwd=`（只读、进程内，返回 `retained:"process"`）；
  召回 tab 拆成「这一轮实际发送 / 试算一次查询 / 维护检查」。
- 修复后断言：p26 有记录态渲染 delivered 正文与 126/300、更正待发提示、「候选≠已发送」；
  空账本渲染「没有本轮投递记录」且说明是进程内。

## 验证层级

| 层级 | 命令／操作、版本和结果 | 证据位置／未运行原因 |
|---|---|---|
| 离线回归 | `node scripts/run-all.mjs` → **27/27**（p24 12/12、p26 14/14、p18 契约更新后通过） | 本轮实跑 |
| 最终 tarball + 真实 peers | `npm pack` 37 文件、shasum `43c7d1841055c02347d9f0b6723cf7b2f67c32cb`；独立目录装 `@deepseek-ai/dsh-llm@0.2.1-rc.4` + `dsh-tools@0.2.1-rc.4`；`verify-package` **13 项 passed** | 本轮实跑（`.tmp/consumer`，验证后未提交） |
| Web 宿主实际交互 | 0.2.1-rc.4：工作区下拉 2 项，切到 dsh-trivium 后路径/节点数/列表全换（16）；导入预览 2 项新增、取消后 16 未变；召回 tab 三段结构、0/300 空态 | `.tmp/shots/b2-*.png`、`b4-preview2.png`、`b5-turn.png`（未提交） |
| 桌面宿主 API | 未运行 | 本批未涉及桌面端；桌面进程在截图阶段被临时关闭以释放库锁 |
| 桌面视觉／键盘 | 未运行 | 同上 |
| 性能／检索质量对照 | 不在本批范围（C 批） | — |

键盘断言在 p24/p26 里是**语义**断言（`aria-selected`、`tabIndex`、`onKeyDown` 转移、焦点调用），
不是像素断言；真机只做了鼠标链路与焦点回归的抽样，未做逐控件 Tab 走查。

## 交付状态

- 已实现：B1–B5 全部切片，代码 + 各自回归。
- 已验收（本机自验）：离线 27/27、tarball+真实 peers 13 项、Web 真机三条链路（切库/导入预览/投递空态）。
- 待独立验收：B1 原型与 B2–B5 交互是否满足 Codex/用户的产品判断；未逐片请求确认，按要求连续推进。
- 未发布：npm 未发、dist-tag 未动、版本号未改。
- 未推送：本次为 B 批收尾，按要求在 B1–B5 完成后统一推送一次。
- 遗留风险与限制：
  1. **真实投递的有记录态未在真机产生**（需新跑模型轮次）。该态由 p26 用真实 ledger 结构断言覆盖，真机只验了空态。
  2. 工作区下拉依赖宿主 `listedWorkspaces()`；若宿主在别处改了工作区注册，下拉会随之变化，面板不做二次缓存。
  3. 回执是进程内前端状态，刷新即清空；这是刻意的（不引入持久化审计日志）。
  4. 导入预览的指纹是整库粒度的保守判断：任何节点/边变化都会要求重新预览，可能比必要的更严格。
  5. `turnRecords` 上限 40 条/轮，超出后丢最早的；正常一轮远低于此。
  6. 深色主题、900px 与中英切换在本批**未逐项实测**（沿用宿主主题变量，无新增固定色）。

## 验收收尾（2026-10-28 晚，第二次真机）

环境：同一台机器上的独立 `dsh web` 实例（宿主 0.2.1-rc.x，`profiles/web` 指向本工作树，插件 `0.7.1`），工作区用 `dshTest` 的 19 条合成数据；临时 `DSH_TRIVIUM_SETTINGS`，不改桌面宿主设置。桌面 profile 仍是 `0.4.21`，本段不冒充桌面验收。

**已复验**（鼠标 + 键盘 + 浅深色 + 900/1280）：

- 工作区下拉同时列出已打开与未打开库（`dshTest` 21 / `TriviumDB` 12）；切换后 `?cwd=`、节点数、列表同时换库，旧缓存不残留。
- 有未保存草稿时切换被拦下，出现「保存后切换 / 放弃修改并切换 / 取消」；取消后仍在原库，未发切换请求。
- 记忆/召回 tab 是 roving tabindex，←/→ 可切换并把焦点带到新 tab；深色与 900px 下布局不截断。
- 导入：预览只读且显示 `新增 2 / 关系 +1`；取消不发写请求；确认后 19→21，回执带真实计数；再次删除测试节点回到 19。
- 每轮投递：空账本如实说明进程内；只读试算返回 149/300，`semantic: off`，不请求 embedding。
- 删除：面板内 `alertdialog` 显示 `#id · name · type`；Escape 取消且不发请求，确认后产生 `delete/saved` 回执，焦点回到触发控件。
- 设置保存：保存按钮已移入「配置设置」折叠区，保存产生 `settings/saved` 回执，不再只有一闪而过的「已保存」。

**本轮修掉的验收缺口**：

1. 导入提交后，预览阶段的 `waiting` 回执仍留在列表里，和 `saved` 同时出现；确认开始时即撤下。
2. B3 计划覆盖「设置保存」，实现只更新瞬时 `saved` 文案；显式保存现在有独立回执。
3. 删除仍用原生 `window.confirm`，无法控制焦点且阻塞宿主渲染；改为面板内 `alertdialog`（Escape/Enter/Tab 圈定/焦点归还），芯片批量删除与 Git 旁路删除同步复用。
4. 「保存设置」常驻页首、先于工作区，违背 B2 的页面顺序；移入配置折叠区，页首只留只读刷新，相关文案同步改掉「右上角」。

**回归**：`node scripts/run-all.mjs` → **27/27**；p24 12/12、p26 15/15（新增设置回执与删除对话框断言）。

**仍未覆盖**：桌面 profile 未升级、未重跑桌面视觉；真实模型轮次下的「有记录态」仍未产生；README 截图仍是 B 前版本；原型与真机不做像素级等同承诺。
