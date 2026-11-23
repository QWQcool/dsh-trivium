# dsh-trivium 0.9.3

npm 0.9.3 使用 `triviumdb@0.9.3`。已有格式 15 的工作区应在新版首次可写打开前，运行 0.9.3 的 `dsh-trivium-upgrade prepare` 留存旧库。 [English](release-0.9.3.en.md)

## 新增

- 「上下文 → 文档依据 → 目录导入」支持预览和确认工作区内的 UTF-8 `.md`、`.txt` 文件。不同导入根目录的同名文件分别保存，旧来源和引用保持原 ID。预览过期时需重新预览。更新后可从回执打开受影响事实，对照旧引用和新修订。
- 本机交接的 Worker 可分别授权 `canRead` 和 `canWrite`。旧配置沿用双向授权。 [交接协议](handoff-protocol.md)

## 改进

- 格式 15 可原位打开。新版在创建可写句柄前检查留存记录或本库的内核标记。直接替换插件而未留存时，面板提示先运行 `prepare`。新工作区可直接使用。格式 13 迁移使用 TDB 0.9.3 官方转换器。 [内核升级与回退](kernel-upgrade.md)
- 实体范围检索会在原有词面规则未命中时匹配有限的中英正文词组。`ctx_find` 的 `followup_cursor` 可续接同一任务、同一实体下仍有效的证据。原 35 题漏召回从 7 降到 0，禁用证据泄漏、非数字 ID 与超预算均为 0。隔离 Web 的 8 题真实模型复验数字引用 8/8，答案逐字评分 7/8，差异为 CSV 与 UTF-8 的排列。embedding 调用为 0。 [检索对照](reviews/MEMORY-CITATIONS-2026-11-20.md#2026-11-23-漏召回复验)

## 删除与移除

无。卸载继续保留记忆。移动导入根目录时，新路径下的文件作为独立来源处理，原引用保持可读。

## 升级、失败恢复与回退

1. 完全退出使用各工作区的宿主。在原工作区用 npm `dsh-trivium@0.9.3` 的升级命令运行 `status` 和 `check`。格式 15 执行 `prepare`，格式 13 通过官方转换器执行 `migrate`。
2. `status` 确认 `phase: active`、`targetKernel: "0.9.3"`、`activeFormat: 15` 和 `before` 后，在原 profile 用 `add` 直接替换插件，再重开工作区。格式 15 快照可按原 ID 查询。格式 13 快照原样保留，新内核可重新捕获当前库的快照。
3. 如遇中断，保持宿主关闭，运行 `status` 后续跑相应子命令。回退时用 0.9.3 的 `rollback` 先恢复整组旧库，再装回原插件版本。新版运行期间的新增写入保存在 `after`。

完整命令、官方转换器准备及各状态恢复方式见 [升级、失败恢复与回退说明](kernel-upgrade.md)。

## 验收范围

沿用先前的格式 13 官方迁移、跨语言检索与目录导入结果，模型样本限于上述 8 题。发布包的干净安装及格式 15 专项见 [验收记录](kernel-upgrade.md#093-候选包验收)。

## 发布回执

- npm 于 **2026-11-23 11:49:37.977（UTC+8）** 发布 `dsh-trivium@0.9.3`，设为 `latest`。registry 记录的 UTC 时间为 `2026-11-23T03:49:37.977Z`。 [npm 版本页](https://www.npmjs.com/package/dsh-trivium/v/0.9.3)
- Git tag `v0.9.3` 指向已验收的源码 `1fe3c6e11be5f1a0610cb4114e863ec7f8858f64`。从 npm 和 GitHub 分别下载核对，两个 tarball 与本地验收包逐字节一致，共 70 个文件、377638 字节。 [GitHub Release](https://github.com/QWQcool/dsh-trivium/releases/tag/v0.9.3)
- npm SHA-1 为 `6fb84f89384c81b014900aedc5007ba18966f6f7`。
- npm SHA-512 integrity 为 `sha512-/GAtgGTNpu4d7uRqQgm73tFj+TzEWkbKHcgVPItZzrqTBhImNyUiOBSdXJfQNYGuBE/S5t35gA1eot+u56k4Sw==`。
- tarball SHA-256 为 `e99554261538f0feca1dd8b8ee60089bf4c1a8e74de7fa247eae2216e96d7d37`。
- 已验收包原样发布，包内 README 保留打包时的候选文案。当前 npm 升级命令见 [升级说明](kernel-upgrade.md)。
