# 可复现示例与测试数据 / Reproducible examples and evidence

下面的离线示例使用源码检出，不需要 DSH 宿主、账号或模型请求。它验证的是存储和检索组件，而不是一次真实跨会话的模型对话。英文说明见文末。

## 1. 在隔离工作区验证图记忆

按项目 `package.json` 的 Node 版本要求准备环境，在源码目录执行：

```sh
npm install
node scripts/run-all.mjs smoke-p0
```

脚本在临时目录建立一张合成图：实体 `dsh-trivium`，偏好“本仓库鉴权走 header X”，以及偏好指向实体的 `about` 边。它关闭数据库后重新打开，再搜索“鉴权”。输出中应看到类似：

```text
ok  session B ctx_find(鉴权) returned hits
本仓库鉴权走 header X
path: about->2(dsh-trivium) | ...
ok  preference node is among hits
ok  path mentions entity ...
ok  hybrid text channel survives reopen ...
1/1 passed
```

节点 ID、分数和临时路径可能不同。脚本还检查重开后文本索引可用；临时设置、工作区和数据库由测试清理。这里的 A/B 是数据库关闭和重开，**不是两个真实 DSH 会话，也没有调用模型或 DSH 的 `ctx_find` 工具**；`searchNodes` 和格式化输出对应的是其底层检索路径。

## 2. 在 DSH 中手动试用

安装插件并重启 DSH 后，在单独的测试工作区打开会话 A，告诉助手：

> 请记住：本项目的发布必须经过人工确认，关联到项目 ReleaseDemo。请调用记忆工具保存，不要执行发布。

检查轨迹或设置中的记忆条目，确认事实实际写入；若要验证关联路径，确认实体与关系也已建立。接着在**同一工作区**新建会话 B，询问：

> 请查询项目 ReleaseDemo 的发布要求，并告诉我依据的记忆内容和关联关系。

检查助手是否调用了 `ctx_find`、是否返回事实及实际记录的路径。模型可能没有创建关系、没有调用工具或回答不准确；这些都应视为需要检查的结果，不是本页保证的通过数。该演示会在测试工作区写入数据，也可能由宿主发起模型调用并产生费用。完成后可在设置页删除测试条目。

## 3. 当前源码中的可重复回归

以下结果于 2026-10-30 在 Node 24.15.0、`triviumdb@0.9.0-beta.3` 的当前源码检出下取得，属于隔离的离线测试；这些 W 批变更在 0.8.2 发布标签之后，不能当作 npm 0.8.2 的验收结果。

| 命令 | 本次结果 | 验证范围 |
|---|---:|---|
| `node scripts/run-all.mjs smoke-p0` | 1/1 组通过 | 存储重开、关键词检索、关系路径及文本索引；无真实宿主 |
| `node scripts/run-all.mjs smoke-p51` | 14/14 断言 | 受控候选下的决策更正、否定、假设、引用和歧义；模型是桩 |
| `node scripts/run-all.mjs smoke-p52` | 20/20 断言 | 固定来源时间下的日期解析和过滤；模型是桩 |

这些断言是确定性回归，不是自然语言准确率。全部离线组运行 `npm test`；历史证据清单哈希可用 `node scripts/verify-evidence.mjs` 检查，但它不判断实验设计是否有效，也不覆盖所有证据目录。

真实模型的历史结果另见 [A10](next-memory/A10-REGRESSION-N10-2026-10-30.md)：改口和否定各 10 次新会话回答均命中；否定场景 3/10 次准备阶段触发请求上限，部分轮次 agent 主动使用了 `ctx_remember`。它是小样本合成场景，不能代表纯自动抽取成功率。该报告的模型、费用和局限应与结果一起阅读。

## English

Run `npm install`, then `node scripts/run-all.mjs smoke-p0` in a source checkout. The script inserts a synthetic preference and entity with an `about` edge, closes and reopens the database, and checks keyword retrieval, the relation path and the text index. The A/B labels mean **database reopen**, not real DSH sessions or model calls. IDs, scores and temporary paths vary.

The table above records current-source offline checks, not npm 0.8.2 acceptance. `smoke-p51` checks replacement counterexamples with a stubbed model; `smoke-p52` checks dates anchored to fixed source times. See [A10](next-memory/A10-REGRESSION-N10-2026-10-30.md) for a small historical model experiment, including its setup request caps and explicit tool writes. Do not generalize these figures to production accuracy or cost savings.
