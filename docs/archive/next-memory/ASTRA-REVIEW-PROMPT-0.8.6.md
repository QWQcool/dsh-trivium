# 0.8.6 最终复核提示词

你是独立验收人。请核对当前工作树的实现和证据，给出可发布 / 有条件发布 / 不可发布。
不要将历史送审数据或测试脚本数量直接当作质量证明。

## 范围与已确认决策

- 已发布基线 v0.8.5；当前 package.json 为 0.8.6，内核仍是 triviumdb 0.9.0。
- 快筛只记分：原窗口保持顺序进入既有抽取/内容门，评分不消费或重排；wouldDrop 是假设值，dropped 为 0。
- p88 已合并到 p74/p75，保留有效断言；scripts/ 有 120 个 .mjs，全量入口为 88 个 smoke。
- 部分提交的 newNodesBeforeFailure 保留；未知 created/merged/applied/skipped 为 null。
- Router/inherit/scope 随包但默认关闭、明确实验；MemoryWriter 和 identity 守卫是默认主链路。
- 不追加付费真机复测；无用户消息的宿主不能推断轮次，诊断计数的作用域限制继续保留。

## 先读

1. docs/reviews/0.8.6-FINAL-RESULTS.md：最终结果与证据路径。
2. docs/reviews/0.8.6-REVIEW-PACKET.md：先读 §十；§一～九是送审和返修历史。
3. docs/release-0.8.6.md 与 .en.md：核对当前对外口径。

## 自行核查

```bash
git status --short
git diff --shortstat v0.8.5
git diff v0.8.5 -- lib/tools.js lib/tool-defs.js lib/schema.js
node -e "console.log(require('./package.json').version)"
node -e "console.log(require('triviumdb/package.json').version)"
node scripts/smoke-p74.mjs
node scripts/smoke-p75.mjs
node scripts/smoke-p82.mjs
node scripts/smoke-p83.mjs
node scripts/smoke-p86.mjs
node scripts/smoke-p87.mjs
node scripts/run-all.mjs
npm pack --dry-run
```

上述六个定向脚本不运行 UI。run-all 包含既有 UI 脚本；AGENTS.md 禁止新增 UI 断言，
运行既有冻结脚本是允许的。若只跑非 UI 子集，必须说明未独立复跑全量。
如果没有文件系统访问，列出命令请送审人代跑，不要凭材料数字判通过。

## 重点检查

1. 空键/无 id content[]/六个真实轮次正向对照是否都覆盖真实消费者，而非仅辅助函数。
2. 评分全零时原事件是否仍到抽取入口；既有内容门是否仍生效；混合窗口是否保持原顺序。
3. 损坏 pending 是否明确失败；批量部分失败是否持久化、是否给出准确的已知/未知计数。
4. p88 的七个评分检查和三个预算检查是否分别保留到 p75/p74；不得靠削弱断言换取通过。
5. 发布说明是否区分历史真机记录、当前离线验证、实验功能和未验证边界。

## 禁区与交付

不推送、不打 tag、不发布、不改版本/pin/schema/DIM、不运行付费模型，不动真实默认工作区。
不新增 UI/UX 或体感性能断言；测试数据与 DSH_HOME/设置必须隔离。

按严重程度列问题，每条给文件、行号、复现命令；明确是否阻塞发布。
说明实际验证层级、测试结果与未验证项，不能把受控钩子验证称为真机验收。
