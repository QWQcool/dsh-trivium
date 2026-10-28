# 接手入口（0.7.0 基线）

更新：2026-10-28。本页保留已有链接；版本、发布回执、质量状态和待验证项已合并到 [docs/README.md](../README.md)，避免维护多份互相冲突的快照。

接手时按顺序阅读：

1. [当前基线与文档导航](../README.md)：区分已发布包、未发布工作树和历史验证。
2. [产品与架构](../../PLAN.md)；涉及芯片／fork 时再读 [会话层契约](../../PLAN-session-map.md)。
3. [0.7.0 发布说明](../release-0.7.0.md) 和与本次任务相关的 R5 / R7 / R8 验收记录。
4. 需要理解旧缺陷时读 [0.5.0 审查](REVIEW-2026-10-28.md) 及对应复现；不把旧失败输出当作当前仍失败。
5. 改动按 [审查清单](REVIEW_CHECKLIST.md) 与 [回交模板](RESULT_TEMPLATE.md) 提供证据；发布时另用 [发布清单](../release-checklist.md)。

先核对 `git status`、package / lock / engines 与用户的当前任务。用户已明确授权的文档整理、审查和修复可继续，不因旧交接词再重复请求确认；没有明确发布授权时不执行发布、推送、dist-tag、deprecate 或 issue 留言。

测试必须隔离 `DSH_TRIVIUM_SETTINGS`、`DSH_HOME` 和工作区；不删除真实 `.dsh`，不读取或输出 npm token。对实现、离线测试、正式包消费验证、Web 真机和桌面 UI 分别报告，不能互相冒充。
