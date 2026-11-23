# 开发中变更

当前 npm 发布基线为 `dsh-trivium@0.9.2`，内核为 `triviumdb@0.9.2`。新增、改进、移除与升级步骤已记入双语发布说明。 [中文](release-0.9.2.md) · [English](release-0.9.2.en.md)

当前源码已固定 `triviumdb@0.9.3`。新增格式 15 的 `prepare` 留存命令，格式 13 迁移使用 0.9.3 官方转换器。两条路径使用同一整组文件回退流程。 [升级、失败恢复与回退](kernel-upgrade.md)

实体范围检索补上轻量双语正文匹配。`ctx_find` 支持通过 `followup_cursor` 继续同一任务，复用仍有效的已送证据。冻结 35 题的漏召回从 7 降到 0，本次没有增加 embedding 请求。 [验收记录](reviews/MEMORY-CITATIONS-2026-11-20.md#2026-11-23-漏召回复验)

文档依据面板新增目录导入，可预览、确认并打开受影响事实。不同目录的同名文件分别保存，已有来源和旧引用保持独立。 [验收记录](reviews/DOCUMENT-IMPORT-2026-11-20.md#2026-11-23-面板与同名来源验收)

此前合入的交接读写分权和新增评测见 [当前状态](CURRENT-STATE.md)。开发计划见 [路线图](ROADMAP.md)。
