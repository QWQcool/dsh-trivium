# W2 证据：安全的自动替代

基线 `db35034`（0.8.2）。零模型调用、零费用。

## 修前（p51-before.txt）

14 条断言里 **12 条失败**，与计划里的 F-W01a/F-W01b 一致：

- 「只是讨论是否替换方案 A」→ 仍建了替代边，A 被退休；
- 「不再使用方案 A；方案 B 保持原样」→ **B 也被退休**（同名标签串链）；
- 「不要替换 A」「假如换掉 A」「文档提过更换 A」「要不要换掉 A」→ 全部被当成替代；
- 模型自造 quote（原文里根本没有）→ 也能退休真实决策；
- 两个同名活节点 → 被按 id 串成链，两个都退休，新节点直接进短地图。

## 修后（p51-after.txt）

14/14。规则收紧为：

1. **证据来自用户原句**：候选的 `quote` 必须在缓冲的用户轮里匹配到（`matchQuote` 只查 role=user），模型自己写的 quote 不算证据。
2. **意图判断看用户原句**，不看模型转述；原句含讨论/疑问/假设/引用/否定/"保持原样" 时不触发。
3. **唯一目标才自动替代**：目标必须是同一工作区里唯一一个仍有效、且标签出现在用户原句中的决策。
4. **歧义不猜、不串链**：多个活节点命中同一标签时，谁都不退休，新决策写入但打 `review: ambiguous-supersede`，短地图不再把它当作当前答案。
5. **失败留全尸**：建边抛错时同样转 `review: supersede-failed`，不留下半条链。

## 契约纠正（p48）

p48 原来的断言是"多个同名目标都串入替代链"，本轮按计划改成：

```text
ok an ambiguous replacement is reported as pending
ok ambiguous targets keep their current status
ok the unconfirmed decision is not offered as current
```

合法单目标替代、历史读取、幂等正例继续保留（p48 12/12）。

## 本片未覆盖

- `ensureLink` 抛错的分支（`review: supersede-failed`）没有专门的故障注入用例，只做了代码路径与 try/catch。
- "明确替代多个独立决策"没有硬塞进线性链，也没有新的图关系；按计划交给既有人工流程，未做 UI。
