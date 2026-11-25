# dsh-trivium 0.9.5 发布说明

[English](release-0.9.5.en.md)

npm 已正式发布 `dsh-trivium@0.9.5`（`latest`）。本次保留 `triviumdb@0.9.3`，只处理三个已知问题。

## 新增

- 「设置 → 向量」可指定新建记忆库的向量维数（`embeddingDimensions`，默认 1536），也可让接口请求附带当前库的 `dimensions`（`embeddingRequestDimensions`，默认关闭）。只有接口支持该请求字段时才开启；关闭时，接口仍需返回与库相符的维数。

## 修复

- [#10](https://github.com/QWQcool/dsh-trivium/issues/10)：后台抽取若遇到明确的「不支持推理档位 `off`」，且尚未收到流式内容，会在同一模型上去掉该参数后重试一次。取消、超时、限流、网络或其他接口错误，以及已经收到内容后的失败，不触发此兼容重试。
- [PR #8](https://github.com/QWQcool/dsh-trivium/pull/8)：开场短地图和后续刷新仅附到宿主已接纳且符合条件的人类输入步骤。新建会话不会单独为地图发模型请求；后台、生产者、合成消息或附加失败均不推进投递状态。感谢 [@rachel1028-blip](https://github.com/rachel1028-blip) 提交修复。
- [#9](https://github.com/QWQcool/dsh-trivium/issues/9)：已有记忆库按原生文件维数打开，1024 维库不再被当成 1536 维库。读写、快照和检索各使用对应库的维数；接口返回不匹配的向量时拒绝使用或写入该向量，关键词和图检索仍可用。

## 移除、兼容与数据影响

- 无功能移除，无新增默认启用功能，无数据格式改动。
- 更新不会重建或自动转换现有数据库，不补零或截断不匹配的向量，也不会重算库存向量。查询与库存向量应使用同一模型和配置；维数相同不代表可混用不同模型。
- 已随旧插件完成 TDB 0.9.3 升级的库无需重复迁移；尚未满足首次可写打开保护的格式 15 库，或仍在旧格式的库，继续按[内核升级与回退](kernel-upgrade.md)留存整组文件、准备或离线迁移。换插件版本不等于换向量模型。
- 1024 维库原样保留。回退到固定使用 1536 维的 0.9.4 仍无法打开该库；不要把回退当作恢复 1024 维访问的方法。
- 沿用 [0.9.4 已知的两个 1,000 行读取边界](release-0.9.4.md#修复)：孤立实体扫描取满 1,000 行会拒绝；实时 TQL 返回正好 1,000 行时可能保守标记 `truncated: true`。

## 验证边界

同一运行源码树在 Windows 离线回归通过 115/115（含 P125–P128），文档检查 14/14、干净消费安装 13/13、CLI 帮助 5/5。封存的 tarball 在隔离的官方 DeepSeek Harness 0.2.2-rc.5 中全新安装：仅含地图的独立步骤由 1 次降到 0 次，下一条符合条件的人类步骤收到一次地图；现有 1024 和 1536 维库均保留旧记忆，可写入并读回，`/status` 显示实际维数；Web 设置接口拒绝无效维数，修改新库默认值不改变原库维数；用模拟接口拒绝推理档位 `off` 后，在同一模型上重试一次，抽取结果只写入一次。未覆盖浏览器界面、真实用户账户、外部 embedding 服务或其他操作系统。

## 发布回执

- npm 于 `2026-11-25T03:30:25.291Z` 发布并设为 `latest`。 [npm 版本页](https://www.npmjs.com/package/dsh-trivium/v/0.9.5)
- [GitHub Release](https://github.com/QWQcool/dsh-trivium/releases/tag/v0.9.5) 于 `2026-11-25T03:41:46Z` 发布。附注标签 `v0.9.5`（`8baacefc88614fac83fc7f11d92d1dea79d63bca`）指向 `875e6556c980fe68b5ae34bdf88d61dac27f50b9`。
- [发布附件](https://github.com/QWQcool/dsh-trivium/releases/download/v0.9.5/dsh-trivium-0.9.5.tgz) 与封存成品和 npm 下载逐字节一致：74 个文件、392,794 字节。SHA-256 `4dcae1988aaafac1fa3d584210a4c144e2cb900f3b5bbd41f6b54e55db54c93d`；npm SHA-1 `c86f731e4babe62613fba9ef8798454736e81a73`。
- npm integrity `sha512-/YutcBCfDZqb0KosVUylgi0JgMA+1z4tEYVnTbaxpkHG9Z2xo1gpnrGJedKBag3TPhxe9zpr97mNvk8AUS+FPg==`。
- 测试过的归档未经修改即发布。归档内的 README 保留封存时的候选文案；仓库 README 记录确认后的发布状态。 [结构化回执](reviews/NPM-RELEASE-0.9.5-2026-11-25.json)
