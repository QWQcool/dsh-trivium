# 历史测试数据（账本与已知局限）

> R1/R2 审查确认这些文件哈希完整，但部分实验设计/评分不可靠；旧抽取文件也没有完整候选。**完整性不等于结论有效。** 当时的修复见 [R1/R2 结果](../next-memory/R1-R2-RESULTS.md)，当前版本和后续验证见[文档入口](../README.md)；历史文件不覆盖。

> 下方付费重跑命令是历史记录，其中第一条的预算超过本机单次上限，**不要直接执行**。如需重新设计实验，应明确指定不超过 ¥3 的单次预算，检查当日累计费用并保留新证据；预算不足时停止，不得覆盖历史结果。

这里保存 2026-10-29 部分历史实验账本，并非项目全部对外数据的来源。各文件记录当时可采集的回答、usage、判分和注入量；早期抽取文件不含完整候选，实验设计也有已知缺陷。A 系列等后续证据位于 `docs/next-memory/evidence-*`，请从相应结果报告追溯。

- 生成时间：2026-10-29
- 价目来源：[DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- 成本口径：**谷价（空闲时段）**，峰价同时记录；见 [COST-MODEL.md](../next-memory/COST-MODEL.md)
- 校验：`manifest.json` 里每个文件都有 `sha256` 与调用数；文件名带日期，不覆盖历史

## 数据集

| 文件 | 内容 | 调用 | 关键结论 |
|---|---|---:|---|
| `2026-10-29-c4-arms-6scenario.json` | 两个指定对手 + 我方 + 纯文本，7 臂 × 6 场景（修复前） | 42 | 我方 4/6、纯文本 6/6，暴露两个注入缺陷 |
| `2026-10-29-d0-step1-8arms-3reps.json` | 修复后 8 臂 × 6 场景 × 3 重复 | 147 | 注入臂 18/18、97 tok（纯文本 360）；部分其他臂复用库，不能作公平横评或等效结论 |
| `2026-10-29-d0-step2-alias-rerun.json` | `deepseek-chat` 别名重跑 | 31 | 回执 `model=deepseek-flash`：**不是第二模型** |
| `2026-10-29-d0-step2b-v4pro.json` | 真第二模型 `deepseek-v4-pro` | 24 | 6/6；样本很小，且部分对照受复用库影响，费用比不能外推 |
| `2026-10-29-d1-5turn-compaction.json` | 5 轮压缩会话，4 臂 | 120 | 旧模拟观察到 6/12 与 12/12；缺注入历史和短图，不能当真实宿主压缩质量或收益 |
| `2026-10-29-d1-10turn-compaction.json` | 10 轮压缩会话，4 臂 | 240 | 旧模拟 0.51×；缺少注入历史/短图，不能作宿主收益 |
| `2026-10-29-d2-extract-cost.json` | 抽取成本：每轮 / 批量 / 规则 | 18 | 每轮 1038 tok、批量 342 tok、规则 0 但抽不到（0/9） |
| `2026-10-29-scale-1k-10k.json` | 规模基准 1k / 10k | 0 | p95 201 ms / 1240 ms，命中 16/16 |
| `2026-10-29-cost-normalized.json` | 全部账本的峰价 / 谷价重算 | — | 旧格数汇总；按请求重算为 622 次，谷价 ¥0.17895998 |

## 怎么复核

```bash
# 1. 校验和（不联网）
node scripts/verify-evidence.mjs

# 2. 任意账本按谷价重算
node scripts/cost-normalize.mjs --out=.tmp/recheck.json docs/evidence/2026-10-29-d1-10turn-compaction.json

# 3. 重新跑（要 DEEPSEEK_API_KEY，费用按谷价量级）
node scripts/bench-c4.mjs --run --reps=3 --budget=12 --out=.tmp/c4/step1.json
node scripts/bench-d1.mjs --run --budget=3 --turns=10 --out=.tmp/c4/d1-10b.json
node scripts/bench-extract-cost.mjs --run --budget=2 --out=.tmp/c4/extract.json
```

重新生成证据包：`node scripts/pack-evidence.mjs`（保留请求/回答/候选；遇到已存在且不同的历史文件会拒绝覆盖，使用新的 --out-dir）。

## 为什么没有用「软链接」

README 里给的是一个**稳定路径** `docs/evidence/`，不是一个 symlink。原因：

- Git 里的 symlink 在 Windows 上默认被检出成普通文本文件（需要开发者模式 / `core.symlinks=true`），
  克隆到没开开发者模式的机器上就是一个坏指针；
- 我们的目标是「文档 → 数据」永久可达，路径稳定即可，链接语义由 `LATEST.json` 承担（指向当期数据集列表）。

如果确实需要系统级软链接，可以本地建一个指向本目录，但**不要提交**。

## 边界（这些数据不能证明什么）

- 全部是**合成语料**，不是真实用户会话；判据是结构化字段严格比较，不含主观质量。
- 每格 n=1～3，单/双模型，方差没有做统计检验。
- 抽取成本只测了「抽到没抽到」，没测抽到的内容是否正确。
- 对手的工具面（dsh-memory 27 个工具）**没有**接进对照，所以不能做产品排名。
- 10k 以上规模、真实 `dsh web` 端到端、压缩后多轮真实宿主行为都未覆盖。
