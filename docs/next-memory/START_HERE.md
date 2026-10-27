# 下一轮开发交接包

先看 IMPLEMENTATION_PLAN.md，双击 FRONTEND.html 体验目标界面，再阅读 REVIEW_CHECKLIST.md 与 ACCEPTANCE_CASES.json。HANDOFF_PROMPT.md 可以直接发给接手模型。完成后按 RESULT_TEMPLATE.md 回交。

HTML 完全离线，使用示例数据，没有数据库连接。场景切换、详情、历史、替代/撤销、并发冲突和预算预览都只是交互演示；界面截图与 qa-result.json 仅证明原型可用，不证明正式功能已实现。

ZIP 的 baseline-source 是当前0.4.22代码快照，不含node_modules、真实.tdb、个人设置或.git。BASELINE.json给出了源文件校验值；不要拿远端旧0.4.21覆盖。若实际工作区已有更新，先比较差异并保留它们，不自动回滚。

TOOL_SCHEMA_BASELINE.json记录当前四个工具的结构和说明，供上下文开销对比。previews目录是原型截图与浏览器检查结果；不是正式插件的新功能验收结果。

实施分三步：M0共享预算和去重，M1来源与诊断，M2人工决策替代。详情留在UI，模型上下文只保留需要的摘要；这些约束是验收门槛，不是已经完成的产品能力。

每个阶段可独立提交；禁止把演示数据、外框场景控件和原型的固定配色照搬到正式宿主中。性能基准本轮不做。
