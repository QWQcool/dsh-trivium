# TDB 0.9.3 升级与回退

npm `dsh-trivium@0.9.3` 固定 TDB 0.9.3。格式 15 可原位升级，首次可写检查点会发布 WAL 基准封条。插件会在打开已有库以供写入前要求留存整组旧库。格式 13 等旧库走官方离线迁移。 [English](#english) · [上游兼容说明](https://github.com/Astrmira/TriviumDB/blob/v0.9.3/docs/changes/0.9.3.md) · [0.9.3 发布说明](release-0.9.3.md)

## 准备

完全退出使用工作区的桌面程序（含托盘）、Web、Router 和 Worker，包括只读进程。从预检到替换插件保持宿主关闭。将示例路径换成包含 `.dsh/trivium.tdb` 的实际工作区。先运行 `status` 查看 `activeFormat` 和操作状态。新工作区可直接启动。

```sh
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade status "D:/projects/my-project"
```

也可以在 `--package` 和插件 `add` 命令中使用 GitHub Release 附件的本地路径。源码联调时可在 `npm ci` 后用 `node scripts/upgrade-kernel.mjs` 执行同样的子命令。 [GitHub Release 附件](https://github.com/QWQcool/dsh-trivium/releases/tag/v0.9.3)

## 格式 15 直接升级

使用 `check` 只读打开原库。运行 `prepare` 将完整 `.dsh` 留存到 `before`，原文件留在原位。格式 15 无需外部转换器。`status` 显示 `mode: direct`、`phase: active`、`activeFormat: 15`、`targetKernel: "0.9.3"`、`prepareRequired: false` 且列出 `before` 后可替换插件。如果此前有升级记录，`previousRecord` 指向留存的旧记录，原操作目录也会保留。

```sh
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade check "D:/projects/my-project"
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade prepare "D:/projects/my-project"
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade status "D:/projects/my-project"
```

直接换包后如果看到「需要先留存旧库」，插件已拦住可写打开。退出宿主后按上面的命令留存，再重新启动。旧版格式迁移记录即使显示 `active`，仍需为 TDB 0.9.3 执行 `prepare`。完成留存后保持旧宿主关闭，回退恢复点为 `prepare` 时保存的文件组。

首次允许可写打开时，插件在 `.dsh/trivium-kernel` 记录当前内核版本，之后按同一文件组正常重开。复制、恢复库或回退时须使用完整文件组。纯只读的 `check` 和诊断可在留存前使用。

## 格式 13 离线迁移

从 `Astrmira/TriviumDB` 检出 `v0.9.3`。在该检出目录用 Rust 工具链构建独立转换器，再用 0.9.3 的升级命令运行预检和迁移。转换器需要 Python 3。预检要求已有 TDB 协调锁文件，缺失时请用旧宿主正常打开并关闭原库。预留原库、目标库及暂存文件的空间。 [官方工具与资源要求](https://github.com/Astrmira/TriviumDB/blob/v0.9.3/docs/migration.md)

```sh
# 在 TriviumDB v0.9.3 检出目录构建
cargo build --locked --manifest-path crates/triviumdb-migrate/Cargo.toml --target-dir target/migration

npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade check "D:/projects/my-project" --upstream "D:/tools/TriviumDB-0.9.3"
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade migrate "D:/projects/my-project" --upstream "D:/tools/TriviumDB-0.9.3"
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade status "D:/projects/my-project"
```

转换器构建在其他位置时，给 `check` 和首次 `migrate` 加 `--tool` 指定可执行文件。可用 `--python` 指定 Python 3 命令或路径。命令核验官方回执和新库，再切换完整 `.dsh`。文档引用、待补写、复核历史、快照和交接回执随原工作区保留。确认 `mode: migration`、`phase: active`、`activeFormat: 15` 后替换插件。

## 替换插件和检查快照

完成上述准备后，在原 profile 直接安装 0.9.3。

```sh
dsh plugin --profile web add dsh-trivium@0.9.3 --ignore-scripts
```

桌面使用 `--profile desktop`。启动宿主并打开原工作区。格式 15 快照可继续使用原 ID 查询。格式 13 快照原样保留，可以在 0.9.3 中为当前库重新捕获快照，原快照在回退到原内核后仍可读。`.dsh-trivium-upgrade/` 含原始记忆和来源，应排除在版本库之外。

## 失败恢复

保持所有宿主退出，在原工作区运行 `status`，按 `phase` 和 `mode` 继续。

| 状态 | 操作 |
|---|---|
| `preparing` / `direct` | 原 `.dsh` 仍在原处。重跑 `prepare`，完整且校验一致的 `before` 会复用。也可用 `rollback` 取消。 |
| `preparing` / `migration` | 原 `.dsh` 仍在原处。修正工具、占用或磁盘问题，带 `--upstream` 重跑 `migrate`，或用 `rollback` 取消。 |
| `activating` | 重跑 `migrate` 完成切换，此时可省略官方工具参数。也可用 `rollback` 恢复。 |
| `rolling-back` | 重跑 `rollback` 完成回退。已经移出的新库保留在 `after`。 |
| `prepareRequired: true` | 如果尚未准备，按格式 15 的步骤留存。已有 0.9.3 的 `active` 记录时也要核对其 `before` 是否完整。 |
| 校验不符或目录冲突 | 保留 `.dsh` 和 `.dsh-trivium-upgrade/` 中的所有文件，核对工作区路径及操作记录。工具会在覆盖前停止。 |

进程强制退出后，残留工作区锁可能需要约 30 秒才可回收。活动写者的锁会阻止回退。工具遇到符号链接等特殊文件会在复制或切换前停止。

## 回退

退出所有宿主后，用 0.9.3 的升级命令恢复整组旧库。`status` 显示 `phase: rolled-back` 和原格式后，再以原 profile 装回原插件。`before` 仍保留原库，`after` 留存整个新版 `.dsh` 和升级后产生的写入。装回 0.9.2 时，回退到的是 `prepare` 时的恢复点。

```sh
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade rollback "D:/projects/my-project"
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade status "D:/projects/my-project"
```

原库来自 TDB 0.9.2 时，用 `dsh plugin --profile web add dsh-trivium@0.9.2 --ignore-scripts` 装回。来自 TDB 0.9.1 的格式 13 库使用 `@0.9.1`。桌面将 `--profile web` 换成 `--profile desktop`。

## 隔离 Web 验收

2026-11-23 使用 Windows x64、Node 24.15.0 和 DeepSeek Harness 0.2.2-rc.3 Web，对本地构建包和已发布的 0.9.2、0.9.1 分别使用独立 profile。迁移器从上游 `v0.9.3` 的 `9ff5903` 构建。验收使用两个合成库，经实际 Web API 读写和重启。模型和 embedding 调用均为 0。

| 路径 | 结果 |
|---|---|
| 格式 15 | 只读预检及 `prepare` 保持活动库 17 个文件逐字节一致。在复制完成与状态确认之间模拟中断，重跑 `prepare` 成功复用完整副本。0.9.3 原位读写。升级前的快照在 0.9.3 中仍可按原 ID 查询。 |
| 格式 13 | `tdb-migrate-2` 官方预检和实际迁移通过，核对 9 个节点、11 条关系及向量。两次目录重命名之间模拟中断，重跑 `migrate` 完成。旧快照的 12 个文件逐字节保留。新版查询该快照返回 `TDB_IMMUTABLE_ARTIFACT`，新捕获的格式 15 快照可查询。 |
| 两条回退路径 | 0.9.3 写入后均生成新 WAL 基准封条，重启仍可读。模拟回退中断时 Web 拒绝写入且原路径未生成空库。续跑分别恢复 17 和 23 个原文件，SHA-256 全部一致。各自的旧版 Web 可查询原快照并继续写入，升级后新增的记忆、快照、文档引用和交接回执随整组保存在 `after`。 |

两个工作区均核对原文档正文、修订、引用 ID 与字节范围，以及四份交接回执。新内核打开时验证了节点写入、文档链接、交接确认和新快照，重启后依然可读。活动写者会阻止回退。`p120` 另验证了旧升级记录留存、重复准备复用以及备份校验不符时保留新旧两组文件。

此前的 TDB 0.9.2 迁移回退结论见当时的操作记录。 [0.9.2 验收](https://github.com/QWQcool/dsh-trivium/blob/v0.9.2/docs/kernel-upgrade.md#隔离-web-验收)

## 0.9.3 候选包验收

2026-11-23 使用 Windows x64、Node 24.15.0、DeepSeek Harness 0.2.2-rc.3 Web 和隔离 Chromium。取最终 `dsh-trivium-0.9.3.tgz` 安装到全新 Web profile，运行内核为 TDB 0.9.3。回退使用已发布 npm 0.9.2 的独立 profile。两个工作区均为合成库，模型和 embedding 调用均为 0。

| 场景 | 实际结果 |
|---|---|
| 干净安装 | 新工作区无需 `prepare` 即可写入文档来源，重启后仍可读取。独立 npm 消费目录 13/13，升级命令可启动。 |
| 跳过留存 | 0.9.2 创建的格式 15 库显示 `prepareRequired`。实际 Web 面板提示留存，写入返回 409 `WORKSPACE_UPGRADE_PREPARE_REQUIRED`。原库 17 个文件逐字节不变。 |
| 续跑留存与升级 | 模拟副本完成后中断，重跑 `prepare` 复用已核验的整组副本。新内核写入后生成新 WAL 基准封条。重启可读原文档引用、原快照和四份交接回执，以及新版的写入和快照。 |
| 回退 | 模拟两次目录重命名之间中断，新版继续拦截写入。续跑后 17 个原文件逐字节恢复，新库 27 个文件完整保存在 `after`。新版再次打开恢复的未留存库时仍会拦截，0.9.2 Web 可读原快照并继续写入。 |

候选包包含 70 个文件，安装后的文件与打包时的工作区内容逐一核对。tarball SHA-256 为 `e99554261538f0feca1dd8b8ee60089bf4c1a8e74de7fa247eae2216e96d7d37`。

专项 `p120` 通过 5 项，涵盖旧目标版本记录、缺少旧库、只读访问、重新打开和回退。面板专项 `p101` 40/40、卸载保留专项 `p11` 通过、文档检查 14/14。本次沿用前述格式 13 迁移验收。

## English

The published `dsh-trivium@0.9.3` pins TDB 0.9.3. Stop every host using the workspace, including the tray app, Web, Router, Workers and read-only processes. Substitute the path to the workspace that contains `.dsh/trivium.tdb`. You can also pass the local path to the GitHub Release archive to `--package` and the plugin `add` command. [GitHub Release asset](https://github.com/QWQcool/dsh-trivium/releases/tag/v0.9.3)

### Prepare an existing format 15 library

Use the 0.9.3 CLI to inspect and retain the complete old file group. The first writable checkpoint with TDB 0.9.3 publishes a WAL baseline seal. The plugin blocks writable opening of an existing library until `prepare` has retained the old `.dsh` in `before`. A format 15 library created by 0.9.3 opens normally on restart. An earlier migration record for TDB 0.9.2 still needs 0.9.3 preparation.

```sh
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade status "D:/projects/my-project"
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade check "D:/projects/my-project"
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade prepare "D:/projects/my-project"
```

Run `status` again. Confirm `phase: active`, `activeFormat: 15`, `targetKernel: "0.9.3"`, `prepareRequired: false` and a `before` path. If you already replaced the plugin and see the preparation alert, stop the host and finish these steps before reopening. Keep the original host stopped after preparing. The plugin records the kernel in `.dsh/trivium-kernel` when it first allows a writable open. Restore or move the full file group together.

### Migrate format 13 and replace the plugin

Use Python 3 and the converter built from the official `v0.9.3` checkout. Run `check` and `migrate` with `--upstream "D:/tools/TriviumDB-0.9.3"` as in the commands above. If the source lock file is missing, open and close the workspace with the original host before retrying. Allow space for both groups and the staging files. After `status` reports `mode: migration`, `phase: active` and format 15, install 0.9.3. [Build and migration commands](#格式-13-离线迁移) · [Official migration guide](https://github.com/Astrmira/TriviumDB/blob/v0.9.3/docs/migration.md)

```sh
dsh plugin --profile web add dsh-trivium@0.9.3 --ignore-scripts
```

Use `--profile desktop` for the desktop profile. Start the host and reopen the workspace. Format 15 snapshots remain readable by ID. Format 13 snapshots are retained for the original engine. Capture a new snapshot of the current library after migration when needed.

### Recover or roll back

Keep hosts stopped and use `status`. Rerun `prepare` for `preparing` in direct mode, `migrate` for a legacy migration, and `rollback` for `rolling-back`. When resuming `activating`, `migrate` can run without the external converter. If verification fails, retain both groups and the upgrade journal for inspection. Workspace locks left by a stopped process can take about 30 seconds to clear.

```sh
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade rollback "D:/projects/my-project"
npm exec --yes --package=dsh-trivium@0.9.3 -- dsh-trivium-upgrade status "D:/projects/my-project"
dsh plugin --profile web add dsh-trivium@0.9.2 --ignore-scripts
```

Confirm `phase: rolled-back` and the original format before replacing the plugin. The upgrade tool keeps the original group in `before` and the upgraded `.dsh` including new writes in `after`. Use the original compatible plugin version, such as 0.9.1 if the original library was format 13. Keep the upgrade directory outside source control.
