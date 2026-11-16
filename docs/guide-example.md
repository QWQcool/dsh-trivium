# 可重复的小示例

更新：2026-11-16。离线示例使用源码和合成数据，不需要 DSH 宿主、账号或模型请求。它验证存取与关系检索；真实对话需要另做宿主验证。

## 离线图记忆

使用符合 package.json 要求的 Node，在仓库目录执行：

```sh
npm ci
npm test -- p0
```

该例在临时目录写入实体 dsh-trivium、偏好“本仓库鉴权走 header X”及 about 边，关闭数据库后重新打开并搜索“鉴权”。输出应包含偏好正文、关系路径和文本索引重开检查，最后显示 1/1 passed。ID、分数和临时路径可以不同。

这里的 A/B 指数据库重开，没有调用真实 DSH 会话或生成模型；searchNodes 和格式化输出验证工具底层路径。设置和数据库由测试隔离并清理。

## 同工作区的真实会话

在独立测试工作区的会话 A 中，请助手记住“项目 ReleaseDemo 发布前必须人工确认”，并检查事实和业务关系实际入库。然后在同工作区新建会话 B，询问 ReleaseDemo 的发布要求并要求说明记忆依据。

检查轨迹里的 ctx_find/ctx_read、实际正文和关系。未调用工具、缺关系或答错都是需要检查的结果，不能按演示文案判通过。此步骤可能由宿主发起模型调用，按实际配置计费。

## 继续验证

- `npm test -- p51`：替代、否定、假设与歧义的受控反例。
- `npm test -- p52`：按固定来源时间验证日期，不借用机器今天的日期。
- `npm test -- retrieval`：精确名、路径和注入覆盖。
- `npm test`：全部逻辑回归；`npm run test:list` 查看当前集合。

历史 A5/A10 小样本的真实模型结果与局限见 [HISTORY](HISTORY.md)，不当作生产准确率。原始证据校验用 `node scripts/verify-evidence.mjs`，完整性和实验结论有效性分别判断。

## English

Run `npm ci` and `npm test -- p0`. The isolated test writes a synthetic preference and entity, links them with about, reopens the database, and verifies retrieval and the text index. It makes no model requests. For real cross-session testing, use the same test workspace and inspect actual tool calls and persisted facts. See [DEVELOPMENT](DEVELOPMENT.md) for all regression entry points.
