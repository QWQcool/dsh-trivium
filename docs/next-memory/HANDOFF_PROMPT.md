# 给下一位实现者的任务

请先阅读 IMPLEMENTATION_PLAN.md、REVIEW_CHECKLIST.md 和 ACCEPTANCE_CASES.json，再用浏览器打开 FRONTEND.html，切换演示场景并体验来源、历史、召回检查与替代弹窗。

从提供的 baseline-source 或校验通过的当前工作区开始。基线是未提交的dsh-trivium 0.4.22修复集，不能以远端0.4.21覆盖。保留TriviumDB 0.8.11及现有issue #3修复。

按M0→M1→M2实现，分别提交可审查改动。关键约束：新详情留在按需UI；默认开关不变；pins与recall共用300估算token并同轮去重；地图400；工具结果限额；版本关系只由用户确认，图事务与导入验证完整。不要把HTML的演示控件带入产品。

允许合理调整内部模块划分；如果改变用户可见行为、预算契约或数据语义，必须在回交中明确说明，不能自行降低验收标准。不要新增云服务或LLM调用，不做性能/负载测试，不发布npm，不操作真实用户数据库。

完成后填写 RESULT_TEMPLATE.md，返回commit/patch、日志、截图、实际上下文输出和未完成项，供原审查者逐项复核。
