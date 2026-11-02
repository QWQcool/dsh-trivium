# W15 证据：第四轮复验的 4 个 P1 + 1 个 P2（测试自身）

基线 `b15c976`。复验报告：`.tmp/reaccept-b15c976/REVIEW.md`（未入库）。零模型费用。

## 1. 四项 P1

| 编号 | 现象 | 成因 | 修法 |
|---|---|---|---|
| **P1-1** | "方案 A 换成方案 B **吗**，请确认。" 退休 A（隐式与显式都错） | 问句守卫只看整句末尾 | 逐分句判断：含替换词的分句以 `？/吗/呢` 结尾 → 整句按问句处理（`discussion-or-question`） |
| **P1-2** | "他**说**别用方案 A 改用方案 B" 退休 A；加"但我还没有批准"仍退休 | 只处理了带引号的引用 | 新增 `REPORTED_SPEECH`（第三人称 + 说/表示/要求/提到）与 `UNAPPROVED`（还没有/尚未 + 批准/同意/确认/拍板），命中即不替换 |
| **P1-3** | "A **不再**继续使用" 被当成保留 A；而"方案 A 继续使用"在显式路径下仍被退休 | keep 无视否定；显式路径未检查 keep | keep 前 3 字含 `不再/不/别/未/没` 则不算保留；显式路径增加 `supersedes-retracted` |
| **P1-4** | 同样的两条候选，仅换顺序：改口先写 head=方案 B，预算先写 head=预算 | "谁先处理谁退休"，与内容无关 | 应用候选前稳定排序：带 `supersedes` 的最前，其次候选正文含替换词，其余最后 |

## 2. 复验方的 12 条攻击用例（原脚本、原期望）

| 用例 | 修前 | 修后 |
|---|---|---|
| `mid-question-implicit` / `-explicit` | 退休 ❌ | 不退休 ✅ |
| `reported-speech-implicit` / `-explicit` | 退休 ❌ | 不退休 ✅ |
| `reported-unapproved-implicit` / `-explicit` | 退休 ❌ | 不退休 ✅ |
| `negated-keep-implicit` | 不退休 ❌ | 退休 ✅ |
| `negated-keep-explicit` | 退休 ✅ | 退休 ✅ |
| `real-retraction-implicit` | 不退休 ✅ | 不退休 ✅ |
| `real-retraction-explicit` | 退休 ❌ | 不退休 ✅ |
| `budget-first` | head=预算 ❌ | head=方案 B ✅ |
| `plan-first` | head=方案 B ✅ | head=方案 B ✅ |

`attacks.mjs` **12/12**。三套历史脚本复跑：`punctuation` 11/11、`additional` 6/6、`counterexamples` 全部符合。

## 3. P2：`p71` 的断言没有 await（我的测试 bug）

`check()` 是同步函数，`await check(async () => …)` 只是让外层等待一个立即返回的 promise，
12/12 的打印**不代表**十二条断言都被等待。已改为 `async function check` + `await fn()`，
并在 `p72` 里对所有涉及 distill 的用例统一 await。

## 4. 回归

新增 `p72` **13/13**（四项 P1 + 两种候选顺序），`p71` 修复后仍 12/12，全量 **73/73**。

## 5. 关于契约：同意复验方的判断

复验方指出"模型显式指认 ≠ 用户授权"，本轮四个案例里有三个在**带显式 `supersedes` 时同样出错**，
所以我在上一轮说的"显式指认就不会误退休"不成立，撤回这个说法。

如果继续做，建议改成：

- 抽取产出的替代关系一律只是**提案**（写入 `review: supersede-proposed`，UI 显示"建议替代"）；
- **硬链接**只由两种方式创建：用户在界面上确认，或调用方通过结构化参数显式给出目标 id；
- 短地图对"被提案替代"的节点保留可见，不提前隐藏。

代价：召回下降（没人确认就不退休）、需要 UI 改动；收益：不再有自动误退休。这条需要产品决策。
