# 实体范围检索的只读面板入口

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
