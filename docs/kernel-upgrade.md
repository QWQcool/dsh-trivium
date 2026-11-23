# TDB 0.9.3 升级与回退

当前源码固定 `triviumdb@0.9.3`。已发布的 npm `dsh-trivium@0.9.2` 仍使用 TDB 0.9.2。已有格式 15 的库可由新内核直接打开，首次可写检查点会发布 WAL 基准封条，应在升级前保留完整旧库供回退。格式 13 等旧库走官方离线迁移。 [English](#english) · [上游兼容说明](https://github.com/Astrmira/TriviumDB/blob/v0.9.3/docs/changes/0.9.3.md) · [npm 0.9.2 说明](release-0.9.2.md)

## 准备

退出持有工作区的桌面程序（含托盘）、Web、Router 和 Worker，包括只读进程。从预检到替换插件保持离线。在源码目录运行 `npm ci`。工作区参数指包含 `.dsh/trivium.tdb` 的目录，请用实际路径替换示例。先运行 `status` 查看 `activeFormat` 和有无未完成操作。新建工作区可直接使用。

```sh
node scripts/upgrade-kernel.mjs status "D:/projects/my-project"
```

## 格式 15 直接升级

使用 `check` 只读打开原库。在第一次以 TDB 0.9.3 启动宿主之前运行 `prepare`，把完整 `.dsh` 留存到 `before`。原工作区文件维持原位，无需构建官方迁移器。`status` 显示 `mode: direct`、`phase: active`、`activeFormat: 15` 后可替换插件。如果此前有升级记录，`previousRecord` 指向留存的旧记录，原操作目录也会保留。

```sh
node scripts/upgrade-kernel.mjs check "D:/projects/my-project"
node scripts/upgrade-kernel.mjs prepare "D:/projects/my-project"
node scripts/upgrade-kernel.mjs status "D:/projects/my-project"
```

运行 `prepare` 的时点决定回退恢复点。格式号本身无法区分 0.9.2 和 0.9.3 写过的库，请在新版宿主首次打开前完成留存。

## 格式 13 离线迁移

从 `Astrmira/TriviumDB` 检出 `v0.9.3`。在该检出目录用 Rust 工具链构建独立转换器，再回到插件源码目录运行预检和迁移。转换器需要 Python 3。预检要求已有 TDB 协调锁文件，缺失时请用旧宿主正常打开并关闭原库。预留原库、目标库及暂存文件的空间。 [官方工具与资源要求](https://github.com/Astrmira/TriviumDB/blob/v0.9.3/docs/migration.md)

```sh
# 在 TriviumDB v0.9.3 检出目录构建
cargo build --locked --manifest-path crates/triviumdb-migrate/Cargo.toml --target-dir target/migration

# 在插件源码目录运行
node scripts/upgrade-kernel.mjs check "D:/projects/my-project" --upstream "D:/tools/TriviumDB-0.9.3"
node scripts/upgrade-kernel.mjs migrate "D:/projects/my-project" --upstream "D:/tools/TriviumDB-0.9.3"
node scripts/upgrade-kernel.mjs status "D:/projects/my-project"
```

转换器构建在其他位置时，给 `check` 和首次 `migrate` 加 `--tool` 指定可执行文件。可用 `--python` 指定 Python 3 命令或路径。命令核验官方回执和新库，再切换完整 `.dsh`。文档引用、待补写、复核历史、快照和交接回执随原工作区保留。确认 `mode: migration`、`phase: active`、`activeFormat: 15` 后替换插件。

## 替换插件和检查快照

在原 profile 直接安装当前源码构建的 tarball。先建好输出目录，再用 `npm pack --pack-destination "D:/builds"` 打包。使用 `npm pack` 报告的文件名作为安装参数。

```sh
dsh plugin --profile web add "D:/builds/dsh-trivium-0.9.2.tgz" --ignore-scripts
```

桌面使用 `--profile desktop`。启动宿主并打开原工作区。格式 15 快照可继续使用原 ID 查询。格式 13 快照原样保留，0.9.3 下请重新捕获，回退到原内核后旧快照仍可读。`.dsh-trivium-upgrade/` 含原始记忆和来源，应排除在版本库之外。

## 失败恢复

保持所有宿主退出，在原工作区运行 `status`，按 `phase` 和 `mode` 继续。

| 状态 | 操作 |
|---|---|
| `preparing` / `direct` | 原 `.dsh` 仍在原处。重跑 `prepare`，完整且校验一致的 `before` 会复用。也可用 `rollback` 取消。 |
| `preparing` / `migration` | 原 `.dsh` 仍在原处。修正工具、占用或磁盘问题，带 `--upstream` 重跑 `migrate`，或用 `rollback` 取消。 |
| `activating` | 重跑 `migrate` 完成切换，此时可省略官方工具参数。也可用 `rollback` 恢复。 |
| `rolling-back` | 重跑 `rollback` 完成回退。已经移出的新库保留在 `after`。 |
| 校验不符或目录冲突 | 保留 `.dsh` 和 `.dsh-trivium-upgrade/` 中的所有文件，核对工作区路径及操作记录。工具会在覆盖前停止。 |

进程强制退出后，残留工作区锁可能需要约 30 秒才可回收。活动写者的锁会阻止回退。工具遇到符号链接等特殊文件会在复制或切换前停止。

## 回退

退出所有宿主后，用 0.9.3 源码的升级命令恢复整组旧库。`status` 显示 `phase: rolled-back` 和原格式后，再以原 profile 装回原插件。`before` 仍保留原库，`after` 留存整个新版 `.dsh` 和升级后产生的写入。

```sh
node scripts/upgrade-kernel.mjs rollback "D:/projects/my-project"
node scripts/upgrade-kernel.mjs status "D:/projects/my-project"
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

## English

The current source pins TDB 0.9.3. Published `dsh-trivium@0.9.2` pins TDB 0.9.2. Stop every process using the workspace, including readers, and run `npm ci` in the new source checkout. Use `status` with the workspace directory above to inspect the format and any unfinished operation.

- For format 15, run `check` and `prepare` before the new host opens the library. The new engine opens it in place. `prepare` retains the full pre-upgrade `.dsh` in `before` for rollback after the first writable checkpoint. It needs no external converter.
- For format 13, build the official tool from the `v0.9.3` checkout and run `check` and `migrate` with `--upstream`. After `status` reports `active` and format 15, replace the plugin with the tarball built from the new source. Keep all workspaces and operation records at their original paths. [Official migration tool](https://github.com/Astrmira/TriviumDB/blob/v0.9.3/docs/migration.md)
- Keep hosts stopped after an interruption. Rerun `prepare` for `preparing` in direct mode, `migrate` for a legacy migration, and `rollback` for `rolling-back`. When resuming `activating`, `migrate` can run without the external converter. Retain all files if verification fails.
- Run the 0.9.3 source command `rollback` before reinstalling the original plugin. The tool restores the complete old library and retains the complete newer group in `after`. Format 15 snapshots remain readable in 0.9.3. Format 13 snapshots are retained for the original engine and can be recaptured in the new format after migration.
