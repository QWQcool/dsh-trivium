# A-6：改口时自动退休旧决策（A-5 CORRECTION 缺口的修法）

日期：2026-10-30。分支 `codex/r1-r2-reliability`。真实模型复验 10 次、费用 **¥0.083433**。未发布、未推送。

前置：[A-5 扩样基线](A5-WIDER-BASELINE-2026-10-30.md) 里 CORRECTION 只有 3/5。

## 1. 根因

A-5 的失败不是抽取漏，而是**两条决策并列**：

```text
decision:方案 A            先别动旧方案 A，我们还在评估。
decision:不再使用旧方案 A    不再使用旧方案 A，改用方案 B。
```

抽取把它们写成两个独立节点，短地图把两条都列出来，模型有时挑了旧的那条。`lib/revisions.js` 本来就有 `supersedes` 链和 `currentHeadOf()`，但**没有任何写入路径会建立这条链**。

另一个放大因素：规则层（`ruleCandidates`）和模型常把同一句话各写一遍，于是“同一个标签”往往对应 2 个旧节点。

## 2. 改法

### 2.1 写入时建立替代链（`lib/extract.js`）

- 只有**显式替换词**才触发：`更正|改为|改成|改用|不再使用/采用/用|替换|取代|放弃|作废|deprecat|replace|switch to`。没有这些词就不动（`采用方案 C 作为备选` 不会retire 任何东西）。
- 目标判定：新决策正文里出现了旧决策的**标签**（`name` 或正文里的“方案 X”），且旧决策仍是活节点（未被取代、非 archived）。
- **多目标不猜单个**：按 id 从旧到新串成链（`旧1 ← 旧2 ← … ← 新`），保证每个退休节点恰好一个后继、不产生 fork；`currentHeadOf()` 仍能一路走到新决策。
- 每次链接都会回报（`superseded[]`），供状态与实验采集。

### 2.2 短地图只列当前（`lib/store.js`）

`buildShortMapReport` 现在跳过**已有后继**的决策，`decisions=` 计数也只算当前决策。历史节点仍在库里，`ctx_read(id)` 照样能查到——只是不再和它的替代者并排出现。

## 3. 验收

新增 `scripts/smoke-p48.mjs`（13 条）：

```text
ok the replacement is linked to the old decision
ok the old decision now resolves to the new one
ok exactly one successor, no fork
ok the retired decision leaves the short map
ok the current decision stays in the short map
ok the map counts current decisions only
ok no replacement word, no retirement
ok two live labels for the same subject are all reported
ok the chain length is reported
ok each retired decision has exactly one successor
ok the chain does not look like a fork
P48: 13/13
```

全量：`node scripts/run-all.mjs` → **49/49 passed**。

## 4. 真实模型复验（CORRECTION ×5，费用 ¥0.030778）

| 轮 | 地图 | 回答 |
|---|---|---|
| r1 | `decisions=1 · decision:Plan B replaces Plan A` | B |
| r2 | `decisions=1 · decision:停用旧方案A` | B |
| r3 | `decisions=1 · decision:方案切换` | B |
| r4 | `decisions=1 · decision:Plan selection: Plan B over Plan A` | **“记忆里没有相关记录（…均为 0）”** |
| r5 | `decisions=1 · decision:方案B替换方案A` | B |

- 5/5 都建成了替代链（`retired` 1–4 个节点），短地图**全部只列当前决策**（`decisions=1`）。
- 回答 4/5（修前同一夹具 3/5）。
- 唯一失败 r4 不是版本问题：它的地图明确写着 `decisions=1`，但提问轮模型声称“全为 0”。这是**注入/取用**问题（那一轮短地图可能没进上下文，或模型无视了它），需要在提问轮抓实际 prompt 才能定性。

## 5. 成本

| 项 | 运行 | 费用 |
|---|---|---|
| 第一轮复验（3 次，链尚未成型） | 3 | ¥0.021964 |
| 第二轮复验（5 次，含链条指标） | 5 | ¥0.030691 |
| 第三轮复验（5 次，修正采集顺序） | 5 | ¥0.030778 |
| **合计** | 13 | **¥0.083433** |

（其中两轮因为采集脚本的 bug 记成了 ¥0；那些请求实际已经发生，但账本没抓到，按“不可核账”处理，不计入上表。）

## 6. 仍存在的问题

1. **实体标签仍在**:地图里仍有 `entity:方案 A`。它是规则层从“方案 A”抽出的实体，不是决策；本轮没有动它，因为实体也可能被别的决策引用。r4 那种“声称记忆为 0”如果是被实体误导，还需单独查。
2. **n=5 太小**：4/5 对 3/5 不能宣称统计显著，只能说方向对了、机制可验证（链条与地图都是确定的）。
3. **fork 保护**：链式退休保证每个旧节点一个后继；但如果将来有别的路径直接连边，`currentHeadOf` 会返回 `fork` 并拒绝解析——这是有意的，但还没有对应的回归用例。
4. **“记忆为 0”未定位**：需要在提问轮记录注入的 map 文本（本轮只记录了落盘后的地图，不是当轮实际注入的）。
