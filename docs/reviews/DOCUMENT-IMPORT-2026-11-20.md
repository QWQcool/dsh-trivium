# 文档证据目录导入（2026-11-20）

P2-A 首版：从"手输一篇文本"扩到"显式指定一个目录"，仍保持有界、幂等、不删除、可追溯。

## 交付

`importEvidenceDirectory(db, {dir, limit=32, maxFileBytes=64KiB, maxDepth=3})`（`lib/document-evidence.js`）：

| 规则 | 值 |
|---|---|
| 扩展名 | 仅 `.md`、`.txt` |
| 目录 | 跳过 `node_modules`、`.git`、`.dsh`、`dist`、`coverage`、`.tmp` 和点目录 |
| 深度 | 0–3 |
| 单文件 | ≤ 64 KiB（与既有 `SOURCE_BYTES` 一致），超过记 `too-large` |
| 总量 | 默认最多 32 个文件，超出记 `limit`；扫描上限 512 个条目 |
| 写入 | 复用 `saveEvidenceDocument`：同一 `sourceId` 内容不变返回 `reused`；内容变化走新修订 |
| 删除 | **不删除**：磁盘上消失的文件只是不再刷新，库里的来源与引用仍在 |
| 修订通知 | 更新时返回 `{sourceId, revision, affectedFactIds, affectedLinks}`，来自 `documentEvidenceStatus`，列出需要复核的事实 |

## 测试（`scripts/smoke-p119.mjs`，6/6）

1. 导入只取 `.md`/`.txt`，隐藏目录、`node_modules`、二进制扩展名、超大文件都出现在 `skipped` 且原因正确（3 个文件入库）。
2. 原样重复导入：`added 0 / unchanged 3`。
3. 修改 `a.md` 后：`updated 1`，新 revision 与旧不同，`affectedFactIds` 含已关联的事实。
4. 删除 `b.txt` 后：仍 `unchanged 2`，库中 3 个来源都在，`b.txt` 未消失。
5. `limit:1` 只导入 1 个，其余记 `limit`。
6. 不存在的路径返回 `DOCUMENT_DIRECTORY_NOT_FOUND`；传文件或 `limit:0` 返回 `DOCUMENT_INVALID`。

## 未做

- **未接面板/HTTP**：目前是库级入口，宿主还没暴露按钮或路由；面板仍只能手输。要接的话需要新增只读预览 + 导入按钮与相应 HTTP 形状。
- **未用命名图**：TDB 0.9.1 的命名图没有接入。理由仍是上游说明里的"逻辑图不是权限隔离"，而当前范围由 `sourceId` 与文档修订表达，够用且可核对。
- **未做增量/监听**：没有文件监听或自动重扫，每次导入都是显式调用。
- 导入只读 `.md`/`.txt`，PDF/Office 仍由宿主提供解析（和既定边界一致）。
