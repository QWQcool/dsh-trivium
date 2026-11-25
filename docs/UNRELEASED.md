# 开发中变更

当前 npm 发布基线为 `dsh-trivium@0.9.4`，内核仍为 `triviumdb@0.9.3`。任务记忆变更、按选定来源查原文、重复引用分组和读取边界修复见 [中文](release-0.9.4.md) · [English](release-0.9.4.en.md)。

后续新增、改进、移除与升级影响从 `v0.9.4` 起记录。 [当前状态](CURRENT-STATE.md) · [路线图](ROADMAP.md)

## 0.9.5 本地发布候选（尚未发布）

[中文候选说明](release-0.9.5.md) · [English](release-0.9.5.en.md)。

- [#10](https://github.com/QWQcool/dsh-trivium/issues/10)：后台抽取只在接口明确拒绝 `reasoningEffort: "off"` 且尚未流出内容时移除该参数重试一次。
- [PR #8](https://github.com/QWQcool/dsh-trivium/pull/8)：短地图只跟随宿主接纳的人类输入步骤，不再自己触发模型步骤。
- [#9](https://github.com/QWQcool/dsh-trivium/issues/9)：现有向量库按原始维数打开；新增仅作用于新库的默认维数设置，以及默认关闭的 `dimensions` 请求参数。
- 无移除、默认启用变化或新增数据格式；不自动转换旧库或重算向量。
