# dsh-trivium 0.8.9

本版交付工作区写入修复，以及 Issue #5 的在线查询、独立快照和离线 CLI，包含功能提交 `9d7b96a` 和交接提交 `45132e6`。

## 写入与宿主兼容

- 切库立即清空旧记忆行并取消删除确认。编辑、合并、归档和删除绑定显示条目的工作区，迟到的提案回执与待补写响应也核对来源。
- 提案令牌使用文件系统规范路径，区分小写形式相同的不同目录。
- 芯片新增、批量归档和删除取得同一工作区写锁。锁忙返回 409，释放后可重试。
- peer 范围明确接受公司机器实测的 DSH 0.2.2 预发布系列。
- 部分导入单列为“部分提交”，0 表示新增 0 条，已有条目可能已经合并。
- 拒绝审计保留候选 ID，操作使用独立标识。确认记录实际 HTTP 入口及关系操作标识。
- 详情内提供归档和删除操作，窄栏、弹窗和宽屏共用同一入口。

## 在线读取与快照

向 `POST /api/dsh-trivium/query?cwd=...` 发送 `tql`、`params`、`limit`，即可查询宿主当前句柄。参数由引擎绑定，写语法被只读会话拒绝。返回 `source=live`、行和截断信息。超时默认 25ms、最多 50ms，行数默认 200、最多 1000，响应上限 512KiB。

截止时间由原生引擎协作检查，同步调用会占用宿主事件循环。排序和聚合仍需完整输入。超过工作集预算返回 422，超时返回 408，不能把预算拒绝当作成功分页。

通过 `POST /snapshots` 捕获独立代际，后续写入不会改动旧快照。快照 TQL 在独立进程执行，有父进程超时和输出上限。新增 `dsh-trivium-query --snapshot ...`，体检 CLI 也支持 `--snapshot`。捕获是显式操作，会复制文件并占用磁盘。[接口、示例与边界](read-api.md)

## PR #4 的设置

每轮注入预算可配置，缺省为 300，显式 0 关闭该部分注入，最大 2000。清空输入恢复 300，试算、状态与实际注入使用相同预算。工具“失败后成功”的恢复事实可关闭，缺省继续开启。

## 升级和验收

`dsh plugin --profile web add dsh-trivium@0.8.9`，然后重启宿主。普通 npm 项目可运行 `npm install dsh-trivium@0.8.9`，并安装匹配宿主的真实 peers。

内核固定为 triviumdb 0.9.0。0.8.8 到本版沿用现有数据格式。0.8.6 建立的自动边按需要逐条撤销。更早格式升级的整组备份要求见双语 README。

公司机器的回归、负载、成品安装和真实宿主结果见[0.8.9 验收记录](reviews/0.8.9-RESULTS-2026-11-12.md)。

## 发布回执

- npm latest 为 **0.8.9**，发布时间 **2026-11-12T02:18:47.968Z**（北京时间 10:18:47）。
- 已验收提交与远端 annotated tag v0.8.9 均指向 **63d4db2e1888fb2eaf93076ed68df1f302837d62**。
- 实际发布 tgz 为 **291567 字节、57 文件**。源码、归档与严格安装后的文件逐字节一致。CLI 使用 LF，避免 npm 安装时改写 shebang。
- SHA-1 为 `0fd2ba389c96bde358f94a55a37211ba4ed5535a`。
- Integrity 为 `sha512-IdoG+PEIyqi0JOzviCjwnS7OF2mvRBQ+7g+6VuA8B2fVmetw4HrQG6khG2ISjCjxFl2PSSdcnXDnlLywI2YqHA==`。
- 再次下载 registry tgz，SHA-512 与已验产物一致。tarball 发布的 registry 元数据未提供 gitHead，来源由提交、tag 和文件/完整性比对确认。
- [GitHub Release](https://github.com/QWQcool/dsh-trivium/releases/tag/v0.8.9) 已附同一 tgz。[Issue #5 发布回复](https://github.com/QWQcool/dsh-trivium/issues/5#issuecomment-6812483522) 已写明版本、升级命令与边界。
