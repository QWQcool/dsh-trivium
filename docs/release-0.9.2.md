# dsh-trivium 0.9.2

**已有 TDB 0.9.1 记忆库需要先离线迁移，再安装 0.9.2。** 本版固定 `triviumdb@0.9.2`，工作区的 TDB 主格式由 13 切换到 15。新建工作区可直接使用。功能基线为 `ad3499b`。 [English](release-0.9.2.en.md)

## 新增

- npm 包提供 `dsh-trivium-upgrade`。它调用 TDB 官方转换器，核验数据库后整组切换 `.dsh`，保留原库、文档引用、待核对条目和交接回执。升级中断后可查询状态并继续切换或回退。
- 工作区状态区分需要迁移和升级未完成。切换期间新版宿主阻止写入，避免在原路径误建空库。

## 改进

- 自动召回和显式任务记忆包在预算内提供匹配的实体别名，帮助模型在跨语言追问中使用已经召回的证据。全量包输出 JSON 数字事实 ID 和路径 ID，面板接口仍使用兼容的字符串 ID。记忆包仍按需启用，默认预算为 0。
- 文档修订只提示受影响的事实。能核对到同一引用行和标题路径的移位无需复核，已有引用继续指向原文和原修订。
- 后台抽取结合实际投递记录识别已有记忆的原样回显，阻止重复写入。来源不明的改写可进入复核。同轮有独立来源的新事实仍可保存，包括用户明确陈述的长期设置。

## 删除与移除

无。公开工具和现有记忆保留。

## 升级与数据保留

1. 完全退出使用这些工作区的桌面程序（包括托盘）、Web、Router 和 Worker，也停止只读访问。在原工作区逐个迁移要继续使用的旧库。示例工作区是包含 `.dsh/trivium.tdb` 的目录。预留可容纳原库、新库及迁移暂存文件的空间。
2. 检出官方 TriviumDB 的 `v0.9.2` 标签，在该源码目录构建独立转换器。需要 Python 3 和 Rust 工具链。[官方迁移与构建说明](https://github.com/YoKONCy/TriviumDB/blob/v0.9.2/docs/migration.md)

   ```sh
   cargo build --locked --manifest-path crates/triviumdb-migrate/Cargo.toml --target-dir target/migration
   ```

3. 用下列命令检查和迁移。将路径换成实际工作区和官方源码位置。转换器若构建在其他位置，给 `check` 和首次 `migrate` 加 `--tool` 指定可执行文件。需要指定 Python 时加 `--python`。若预检报告 TDB 协调锁文件缺失，先用原宿主正常打开和关闭旧库，再在离线状态下重试。

   ```sh
   npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade status "D:/projects/my-project"
   npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade check "D:/projects/my-project" --upstream "D:/tools/TriviumDB-0.9.2"
   npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade migrate "D:/projects/my-project" --upstream "D:/tools/TriviumDB-0.9.2"
   npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade status "D:/projects/my-project"
   ```

4. `status` 显示 `phase: active` 和 `activeFormat: 15` 后，在原 profile 直接替换插件，再重启宿主、打开原工作区。桌面使用下面的命令，Web 将 `--profile desktop` 换成 `--profile web`。历史 0.8.9 的卸载钩子可能删除记忆，请始终直接替换。

   ```sh
   dsh plugin --profile desktop add dsh-trivium@0.9.2 --ignore-scripts
   ```

   Windows 若找不到 `dsh`，可用桌面版附带的命令。

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add dsh-trivium@0.9.2 --ignore-scripts
   ```

保留 `.dsh-trivium-upgrade/`。`status` 的 `before` 指向完整原库，目录含原始记忆及来源，应置于版本库之外。旧格式的只读快照随文件保留，在 TDB 0.9.2 中需要重新捕获快照。[迁移细节与隔离验收](kernel-upgrade.md)

## 失败恢复

保持宿主退出，在原工作区运行上面的 `status` 命令。按返回状态处理。

| 状态 | 操作 |
|---|---|
| `preparing` | 原库仍在 `.dsh`。检查转换器路径、库占用和磁盘空间。修复后带 `--upstream` 重跑 `migrate`，或运行 `rollback` 取消。 |
| `activating` | 重跑 `migrate` 继续切换，此时可省略 `--upstream`。也可运行 `rollback` 恢复原库。 |
| `rolling-back` | 重跑 `rollback` 继续回退。 |
| 校验不符或目录冲突 | 保留 `.dsh` 和 `.dsh-trivium-upgrade/` 的全部文件，核对 `status`、操作记录和工作区路径。工具会在覆盖前停下。 |

如果预检失败，修正提示的问题后重新运行 `check`。进程被强制退出后可能需等最多约 30 秒释放残留的工作区锁。

## 回退到 0.9.1

退出所有宿主，在原工作区用 **0.9.2 的升级命令**恢复旧库。`status` 显示 `phase: rolled-back` 且原格式恢复后，再替换回 0.9.1 并打开原工作区。升级后产生的新写入保留在 `status` 指向的 `after`，回退库恢复到升级前的状态。

```sh
npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade rollback "D:/projects/my-project"
npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade status "D:/projects/my-project"
dsh plugin --profile desktop add dsh-trivium@0.9.1 --ignore-scripts
```

Web 使用 `--profile web`。上述回退版本对应由 TDB 0.9.1 创建的原库。若原库来自其他内核版本，恢复库后请装回当时可打开该库的插件版本。

## 验收范围

- 隔离 Web 使用合成旧库验收了 13→15 迁移、读写重启、切换中断恢复和回退。核对了 9 个节点、11 条关系、向量、一份文档的原文与引用及四份交接回执。回退旧库的 12 个文件与原始文件逐字节一致。[存储验收](kernel-upgrade.md#隔离-web-验收)
- 固定跨语言题集三次复验，回答和数字引用均为 15/15，有支持证据却答 `unknown` 为 0。文档修订在 22 条关联中提示了受影响的 5 条，旧引用可读。[评测和失分记录](reviews/FOLLOWUP-DOCUMENT-REVIEW-2026-11-19.md)
- 隔离 Web 的真实模型验证了两组自动召回回显分别产出 0 条新记忆，混合场景只保存了 1 条有来源的新设置。重开数据库后旧节点和关系仍在。结论限于本次题集和使用的模型。[记忆回显验收](reviews/TASK-RETRIEVAL-WRITE-DOCS-2026-11-18.md#2026-11-20-自动召回实机复验)

## 发布回执

- `dsh-trivium@0.9.2` 固定 TDB 0.9.2，源码标签为 `v0.9.2`。 [npm 版本页](https://www.npmjs.com/package/dsh-trivium/v/0.9.2)
