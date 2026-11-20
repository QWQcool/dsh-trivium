# TDB 0.9.2 升级与回退

npm `dsh-trivium@0.9.2` 随包提供升级命令。已有工作区通常从 TDB 0.9.1 的主格式 13 迁移到 TDB 0.9.2 的格式 15。安装新插件前先离线迁移，回退时先恢复整组旧库再装回旧插件。新建工作区可直接使用。 [中文发布说明](release-0.9.2.md) · [English instructions](release-0.9.2.en.md) · [TDB 官方迁移说明](https://github.com/YoKONCy/TriviumDB/blob/v0.9.2/docs/migration.md)

## 准备

退出持有该工作区的桌面、Web、Router 和 Worker，包括只读进程。同一个工作区从预检到切换完成应保持离线。以下命令的工作区参数是包含 `.dsh/trivium.tdb` 的目录，请用实际路径替换示例。

从官方 `v0.9.2` 标签检出 TriviumDB，进入该目录构建独立迁移器。需要 Python 3 和 Rust 工具链。使用同一官方检出的 Python 入口和迁移器。 [官方构建方法](https://github.com/YoKONCy/TriviumDB/blob/v0.9.2/docs/migration.md#构建与执行)

```sh
cargo build --locked --manifest-path crates/triviumdb-migrate/Cargo.toml --target-dir target/migration
```

## 执行

使用 npm 运行固定版本的升级命令。通过源码运行时，在插件源码目录执行 `npm ci`，再将下面的 `npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade` 换成 `node scripts/upgrade-kernel.mjs`。

```sh
npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade status "D:/projects/my-project"
npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade check "D:/projects/my-project" --upstream "D:/tools/TriviumDB-0.9.2"
npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade migrate "D:/projects/my-project" --upstream "D:/tools/TriviumDB-0.9.2"
npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade status "D:/projects/my-project"
```

如果迁移器构建到了其他目录，给 `check` 和首次 `migrate` 增加 `--tool`，指向 `triviumdb-migrate` 可执行文件。`--python` 可指定 Python 3 命令或路径。预检使用官方转换和校验，本地记录位于工作区的 `.dsh-trivium-upgrade`。预检要求已有 TDB 协调锁文件，缺失时先用原宿主正常打开并关闭旧库。预留容纳原库、新库和迁移暂存文件的磁盘空间。 [官方资源与锁条件](https://github.com/YoKONCy/TriviumDB/blob/v0.9.2/docs/migration.md#事实与资源)

迁移器先在新目录发布结果。插件命令核验收据，按完整文件组接入 `trivium.tdb`，并保留工作区里的待补写、复核历史和交接收件箱。数据库内的节点 ID、关系、文档原文与引用由官方工具核对。切换后的工作区路径保持原样，因此既有交接身份仍指向原项目。

`status` 显示 `active` 且 `activeFormat` 为 `15` 后，在原 profile 运行 `dsh plugin --profile desktop add dsh-trivium@0.9.2 --ignore-scripts`，再启动宿主。Web 使用 `--profile web`。`before` 指向本次保留的完整旧 `.dsh`。后续重跑 `migrate` 会报告已完成的记录。保留 `.dsh-trivium-upgrade` 供回退和检查，其中有库和原始来源内容，应加入本地忽略规则。

旧格式只读快照随文件保留。新内核需要新格式快照时，在升级后重新捕获。原格式快照仍可在对应旧版本读取。

## 回退

退出宿主，再运行 `rollback`。看到 `rolled-back` 后，用原版本的插件打开原工作区。从本版迁移前使用 npm 0.9.1 的情况，可以直接替换成该版本。调用 `rollback` 的升级工具应从新版源码或新版包运行。

```sh
npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade rollback "D:/projects/my-project"
npm exec --yes --package=dsh-trivium@0.9.2 -- dsh-trivium-upgrade status "D:/projects/my-project"
dsh plugin --profile desktop add dsh-trivium@0.9.1 --ignore-scripts
```

Web 使用 `--profile web`。回退把新版 `.dsh` 完整留在 `status` 显示的 `after`，然后将已核验的旧库副本恢复为 `.dsh`。迁移后的新增写入在 `after` 中，回退库继续使用升级前的状态。旧库原件也仍在 `before`。

## 失败恢复

先运行 `status`。在最终状态出现前保持所有宿主退出。新版面板会提示需要迁移或操作中断。

| 状态 | 处理 |
|---|---|
| `preparing` | 原 `.dsh` 仍在。修正工具路径、库占用或磁盘问题后重跑 `migrate`，也可运行 `rollback` 取消。 |
| `activating` | 已准备好新库。重跑 `migrate` 继续切换，恢复本阶段无需再传官方工具路径。运行 `rollback` 可恢复原库。 |
| `rolling-back` | 重跑 `rollback` 继续。此前的新版库保留在该次操作的 `after`。 |
| 校验不符或目录冲突 | 保留 `.dsh` 和 `.dsh-trivium-upgrade` 的全部文件，核对 `status`、操作记录和路径。工具拒绝覆盖与记录不一致的目录。 |

进程强制退出后，可能需要等待工作区锁的 30 秒回收窗口。活动进程的锁仍会阻止重试。状态记录关联工作区的实际路径，迁移和回退应在原工作区内完成。普通目录和文件可整组核对，工具遇到符号链接等特殊文件时会停在切换前。

## 隔离 Web 验收

2026-11-19 使用 DeepSeek Harness 0.2.2-rc.3 Web、新源码包和 npm 0.9.1，在同一路径的合成工作区完成迁移与回退。官方预检核对 9 个节点、11 条关系和向量。应用验证了一份文档的原文、修订与引用范围，以及四份交接回执。迁移后编辑记忆、新增文档及引用、确认交接候选。重启后这几项写入仍可读。

分别在升级和回退两次目录切换之间注入中断。Web 返回升级未完成并拒绝写入，原路径没有生成空库。命令能续跑，校验不符时保留两组文件并停止。迁移工具失败可取消，活动写者会阻止回退。回退后旧库恢复到升级前状态，12 个文件逐字节相同。用 TDB 0.9.1 打开后可继续写入，0.9.2 新增内容留在 `after`。本轮仅用隔离 Web 和合成库，模型及 embedding 调用均为 0。
