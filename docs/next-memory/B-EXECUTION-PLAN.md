# B 批执行计划（0.8.0 范围代号，不改版本号）

基线：`3969b7b`（0.7.1 已发布基线 + README 截图更新）。分支 `main`，工作树在本轮开工时为干净。
不推送、不发布 npm、不改 dist-tag、不改包版本、不新增模型工具、不新增外部服务。

## 0. 约束（来自 NEXT-IDE-PROMPT 与既有契约）

- 前端没有构建步骤：`lib/client.js` 由宿主 `__ModuleLoader__` 直接加载，`require` 只解析包名，
  因此**所有 UI 改动必须写在这个文件内**（新增顶层函数可以，拆文件不行）。
- 后端是进程内 TriviumDB；`triviumdb@0.9.0-beta.3` 精确 pin 不动。
- 默认开关不动：抽取开；自动召回 / 芯片 / 会话层 / Git 旁路写出 / 远程 embedding 关。
- 四工具 `ctx_find / ctx_read / ctx_remember / ctx_link` 不动；芯片与更正是通道，不是工具。
- 每用户轮累计 300 估算 token、短地图每会话一次、compaction 不重置同轮额度 —— 不动。
- 故障与预览实验只用合成临时库，隔离 `DSH_HOME` / `DSH_TRIVIUM_SETTINGS`。
- 本批不新增持久化审计日志；回执是进程内有界记录（前端 state，最多 20 条）。

## 1. B1：交互契约与新原型

**问题**：设置页把「检查更新 / 配置折叠 / 记忆条目 / 召回检查」平铺，日常动作（选工作区、
搜索、改一条记忆）要越过三块维护内容；写操作反馈分散在「已保存」span、`role=status` 行、
红字 error 和导入字符串四种形态；导入点下去直接写库，看不到会发生什么。

**状态转换（本批新增/明确）**

```
工作区: 未选择 → 已选(A) → 切换中 → 已选(B)
        切换时若有未保存草稿 → 阻塞并高亮该草稿，用户选「保存后切换 / 放弃修改 / 取消」
写操作: idle → 进行中 → 已提交 → (派生失败: 事实已提交 + 恢复说明)
                        ↘ 拒绝(400/409，可区分 code)
                        ↘ 网络失败(可重试，不会重复写)
                        ↘ 等待处理(更正排队/注入关闭)
导入:   选文件 → 预检中 → 预览(新增/更新/归档/关系/冲突) → 已过期(需重预览)
                                                    ↘ 确认 → 提交中 → 已提交 / 拒绝
```

**拟改动映射**

| 原型控件 | 真实组件 / API | 验收断言 |
|---|---|---|
| 工作区选择器 | `TriviumCard` header 新增 `<select>`，选项来自 `GET /status.workspaces` | 切换后所有请求 `?cwd=` 换成新库；旧 detail/traces/preview 清空 |
| 条目搜索与类型筛选 | 现有 `type/q/showStale` 控件前移 | 搜索后列表与 `GET /nodes` 参数一致 |
| 回执行 | 新增 `ReceiptList`（`client.js` 内） | 每种状态有 `data-receipt-state`，拒绝时带 code |
| 导入预览面板 | `POST /import {preview:true}` → 预览 → `POST /import {expectFingerprint}` | 预览前后库与 sidecar 字节不变 |
| 本轮投递区块 | `GET /turn?cwd=&sessionId=` | 只读；重启后返回空态 |

**原型文件**：`docs/next-memory/FRONTEND-0.8.0.html`（离线、合成 fixture、带状态切换器；
旧 `FRONTEND.html` 保留历史身份）。原型里的预算数字来自显式 fixture，不复刻生产算法。

## 2. B2：工作区、页面顺序与键盘

- 后端：`/status.workspaces` 已存在（宿主 `ctx.workspaces.list`）；`?cwd=` 已用 `isKnownCwd` 校验，
  因此工作区切换**不需要新端点**，但需要在前端把 `workspaceRef`（一次性锁定）改成可变选中值。
- 前端页面顺序：header（工作区 + 状态）→ 错误/回执 → 记忆条目/召回检查 tab → 搜索 + 列表
  → 「维护」折叠区（配置设置、导入/导出、Git 旁路、检查更新）。
- 切换语义：未保存编辑不静默丢弃；切换时清空 `detail/sourceInfo/historyInfo/preview/traces/
  corrections/integrity/importPreview`，并用请求序号丢弃旧响应。
- 文案：把 `compaction/end 抽取`、`实体名折中`、`autoRecall` 等术语下方加一句人话说明（中英同改）。
- 键盘：tab 支持 ←/→/Home/End + `aria-selected`；条目折叠按钮 Enter/Space；弹窗保留既有
  焦点陷阱；新增的删除确认条支持 Enter 确认、Escape 取消并归还焦点。

## 3. B3：统一操作回执

- 统一模型：`{ id, action, target:{id,name,type}, workspace, state, code, at, detail, recovery }`，
  `state ∈ pending | saved | rejected | waiting | failed`。
- 覆盖动作：保存条目、归档、删除、合并、更正、撤销更正、导入、导出、旁路生成/删除、设置保存。
- 「已提交」只由真实成功响应产生；`api()` 收到请求但未返回时只能是 `pending`。
- 事实提交成功但派生维护失败（sidecar/index）→ `saved` + `recovery` 文案，且不提供会重复写入的重试。
- 删除确认显示具体对象（`#id · name · type`），取消不发请求；新增 `data-receipt` 便于断言。
- 敏感字段不进回执：只放 `id/name/type`，不放正文、URL 里的 key、embedding key。

## 4. B4：导入只读预览

- `lib/store.js`：从 `importGraph` 抽出 `planImportGraph(db, graph, {reconcileSnapshot})`，
  只读（复用重复 id / 结构 / URI / 映射 / 冲突 / 合成图预检），返回 `ops` 与摘要；
  `importGraph` 变成「plan + 单事务执行 + 派生」。
- 新增 `dbFingerprint(db)`（节点 id + status/updatedAt + 出边 label 的确定性哈希）。
- `POST /import` 接受：
  - `{graph, preview:true}` → `{ok, dryRun:true, preview:{created,updated,archived,relations,conflicts}, fingerprint}`，**不写库**；
  - `{graph, expectFingerprint}` → 指纹不符返回 409 `STALE_PREVIEW`（不带该字段的旧调用仍可用）。
- 前端：选文件 → 预览 → 面板显示增减与冲突 → 确认才提交；取消不发写请求。
- 预览不生成 URI、不建索引、不排 embedding、不写 sidecar/hash、不登记工作区。

## 5. B5：每轮投递记录

- 新增 `GET /turn?cwd=&sessionId=`：读 `turn-ledger.snapshot()` + `correctionSessions()`，返回
  `{turnKey, cwd, budget, spent, remaining, delivered[], mapText, corrections, plan, generation}`；
  进程内、无持久化，重启即空。
- 召回检查 tab 重组为三段：「这一轮实际发送」/「试算一次查询」/「维护检查（版本链 + 更正 + 最近诊断）」。
- 界面上区分：候选（`records`/`dropped`）→ 实际提交（`delivered`）；`semantic:"not_run"` 明确标注。
- 刷新界面只读，不触发模型调用或上下文注入。

## 6. 验证与证据

| 层级 | 方式 |
|---|---|
| 离线回归 | `npm test`（脚本自动发现 `smoke-pNN`），新增 `scripts/smoke-p26.mjs` 覆盖 B2–B5 |
| 后端行为 | 新增 p26 内的合成库断言：预览前后字节不变、指纹过期、事务失败不留半条链 |
| 前端行为 | 复用 `scripts/smoke-p24.mjs` 的 vm + 假 React harness |
| 真实宿主 | Web `0.2.1-rc.4` 实际操作与截图；桌面端如未覆盖则如实标注 |
| 打包消费 | 独立 tarball + 真实 peers 的干净安装（如果时间允许；未做则如实列出） |

临时日志与截图放 `.tmp/b-<slice>/`，不提交测试库与真实用户数据。

## 7. 明确不做

- 不新增工具、不新增外部服务、不改数据格式版本（JSON `version:2` / JSONL `v:2` 不变）。
- 不做手机宽度承诺；仍只支持 ≥900px。
- 不把原型截图当验收；不让界面刷新触发模型调用。
- 不在本批引入持久化审计日志或完整敏感正文留存。
