# 从这里开始

当前维护入口已合并到 [docs/README.md](../README.md)。先看那里核对版本、验收边界和阅读顺序，再看 [PLAN.md](../../PLAN.md) 的现行设计。

本目录是 0.5.0–0.7.0 的历史交付材料：

- `IMPLEMENTATION_PLAN.md`、`ACCEPTANCE_CASES.json`、`FRONTEND.html`：原始规格和离线原型；不是当前完成度证明。
- `RESULT.md`、`REVIEW-2026-10-28.md`、`review-evidence-2026-10-28.json`、`review-repro-2026-10-28.mjs`：0.5.0 回交、发现三个 P1 的原始证据。
- `FIX_PLAN-2026-10-28.md`、`EXECUTION_PLAN-0.5.1.md`：正确性修复的历史设计与逐轮记录；不重新执行已完成任务。
- `R5` / `R7` / `R8` 验收和 `evidence*`：各轮真实覆盖及未覆盖项，不能互相替代或改成新版本测试结果。
- `BASELINE.json`、`TOOL_SCHEMA_BASELINE.json`：冻结的来源与 schema 基线，不更新成当前源码哈希。
- [REVIEW_CHECKLIST.md](REVIEW_CHECKLIST.md)、[RESULT_TEMPLATE.md](RESULT_TEMPLATE.md)：仍维护的审查清单和回交模板。

`baseline-source/`、交接 ZIP 和某些临时产物只存在于原交付环境时，不代表当前仓库缺少依赖。不要用旧快照覆盖现有工作树。
