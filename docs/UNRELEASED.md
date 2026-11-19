# 开发中变更

本页记录 npm 0.9.0 发布后的源码改动。版本号在发布时单独确定，发布说明按新增、改进、删除和升级影响整理。历史验收保留原日期和实际构建。

## 新增

- 候选支持「不采纳并保留记录」、已有相同正文提示，以及可分页的复核历史。原候选、来源和回执保留；不采纳仅作用于当时的来源窗口，新独立证据仍能进入后续抽取。
- 显式 Super Agent 项目/工单/分配/Worker 映射、持久候选信封和中央回执。Worker 不打开 TDB，Router 离线时可以先存中央收件箱；中央写入后才给出 committed 回执。[协议与示例](handoff-protocol.md)
- `ctx_find` 可选指定实体和预算，返回紧凑任务记忆包；同一任务可用游标只取变化，默认工具用法不变。[用法](read-api.md#开发中的按需任务记忆)
- 实体范围检索面板和 `ctx_find` 支持按名称或别名精确定位。遇到同名会给出候选 ID，需明确选择后再查关联事实。名称查找限定当前工作区或所选快照。[用法](read-api.md#开发中的按需任务记忆)
- 「上下文 → 文档依据」支持选择 Markdown/文本或粘贴原文，按修订检索短片段，定位并关联到已有记忆。来源变化后可对照新旧片段，原事实和旧引用保持可查。[接口与边界](read-api.md#开发中的文档依据接口)

## 改进

- 英文问句停用词、所有格和少量中英领域词组使用有界词面等价组；同组别名只计一次。复合标识符保持原子性，不增加 embedding 或生成模型请求。保留原冻结题，并增加独立题集分开报告开发/留出结果。
- 插件持有的数据库句柄增加进程内派生缓存。查询、作用域、预算及数据库变更版本参与缓存；正文、关系、向量、事务、文档、删除和重开使旧结果失效。到期时间、取消、预算失败和关闭句柄仍按原契约处理。
- 已有地图差异注入和投递账本继续决定注入；缓存只节省重复构建，不把命中数当作账单节省。
- 人工候选操作支持同一请求回执重试；图写入落盘后才结算候选，来源和旧记忆保留。
- 后台抽取先持久化原窗口；模型等待超时后保留候选并允许重试。仅来自旧记忆的改写留待核对，独立来源的新事实仍可写入。两次真实抽取及专项证据见[本轮结果](reviews/TASK-RETRIEVAL-WRITE-DOCS-2026-11-18.md)。
- 新增仅做回答对照的评测入口：先离线核对两组送入的正文，再按固定预算用真实模型作答，分别计量引用、范围错误和实际 token。
- 设置、Git 旁路和使用记录使用各自的临时文件。写入或替换失败会保留原文件，无法解析的设置也不会被新默认值覆盖。
- 工作区状态区分可读、损坏、占用和暂不可读。面板保留工作区列表，提示可切换到其他库继续使用。
- 文档列表分批返回，指定来源才返回该份原文。按事实或来源查关联时使用现有字段筛选，旧关联在事实或来源删除后仍可复核。
- 新增同一组多轮任务对照入口，分别记录回答、引用、实际查库次数、模型用量与耗时。[结果](reviews/MEMORY-MULTITURN-2026-11-19.md)

## 删除与移除

- 移除来源核对回执「只留最后 1024 条」的截断，避免旧处理记录消失后被陈旧任务恢复。
- 移除若干英文问句虚词对词面覆盖分母的干扰。
- 移除抽取超时后仍可接收迟到模型结果并写库的路径，以及把记忆读取返回当独立依据的路径。
- 移除替换设置和旁路文件失败时先删除原文件的分支，以及文档证据读取的全库正文预扫描。
- 没有删除公开工具、现有事实、用户记忆或旧评测夹具。没有自动清理历史重复节点。

## 兼容与数据影响

- 依赖仍为 TDB 0.9.1，不改变内核版本；无需重建现有记忆或安装 Ollama。
- 源码设置路径依次采用 `DSH_TRIVIUM_SETTINGS`、`$DSH_HOME/trivium.json` 和 `~/.dsh/trivium.json`。默认环境继续读取旧设置。自定义 `DSH_HOME` 有独立设置，需要沿用旧文件时可用 `DSH_TRIVIUM_SETTINGS` 明确指向它。
- 完整历史单独存入 `.dsh/trivium-pending-reviews.json`；`.dsh/trivium-pending.json` 保持 0.9.0 的待补写格式。「不采纳」不伪装成已写入的记忆。旧版不显示完整历史，重新使用新版本后可查；旧有混写格式会在新版本下一次正常保存待办时转换。
- 交接收件箱位于主项目 `.dsh/trivium-handoff.json`，不随临时 Worker 目录消失；达到 4096 事件上限时明确拒绝新接收，不静默清除旧记录。当前是本机受信任宿主的文件传输协议，尚无远程鉴权或稳定 Super Agent SDK 接线。
- 文档功能只处理用户选择或粘贴的 UTF-8 原文（最多 64 KiB）。旧单块文档可检索，无需重建；新保存的文档按有界原文片段建立索引。不扫描目录或解析 Office/PDF。Git JSONL 不包含完整 TDB 文档证据数据。
- 五项首版曾通过[完整回归 98/98](reviews/NEXT-MEMORY-2026-11-17.md)。此次收尾只补测兼容、相关回归和新增桌面操作；真实回答对照两组均 8/8，记忆包错范围候选为 0，但总输入 token 更多。[交付与对照记录](reviews/NEXT-DELIVERY-2026-11-18.md)

### 回退到 npm 0.9.0 / Roll back to npm 0.9.0

退出宿主后，用 `dsh plugin --profile desktop add dsh-trivium@0.9.0 --ignore-scripts` 直接替换；不要先卸载或清理 `.dsh`。原样保留数据库完整文件组、两份待补写/历史文件和 `trivium-handoff.json`（如有）。0.9.0 与本构建同用 TDB 0.9.1；不要用更旧的内核打开已升级的库。

Quit the host, then install `dsh-trivium@0.9.0` directly with the command above. Keep the workspace `.dsh` file group, including both pending files and the handoff file if present. Pending work remains readable in 0.9.0; review history is retained for the newer build. This rollback keeps TDB at 0.9.1.

自定义 `DSH_HOME` 回退时，将 `DSH_TRIVIUM_SETTINGS` 指向该目录内的 `trivium.json`，旧版即可沿用这些设置。

When rolling back a custom `DSH_HOME`, point `DSH_TRIVIUM_SETTINGS` to its `trivium.json` so 0.9.0 uses the same settings.
