# 测试数据（可复核的原始账本）

这里是本项目所有对外数字的来源。每一份 JSON 都是一次真实运行的账本：**逐格回答、逐请求 usage、
判分结果、注入 token**，没有手工填写的汇总表。文档里的每个结论都应能在这里找到对应数据。

- 生成时间：2026-10-29
- 价目来源：[DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- 成本口径：**谷价（空闲时段）**，峰价同时记录；见 [COST-MODEL.md](../next-memory/COST-MODEL.md)
- 校验：`manifest.json` 里每个文件都有 `sha256` 与调用数；文件名带日期，不覆盖历史

## 数据集

| 文件 | 内容 | 调用 | 关键结论 |
|---|---|---:|---|
| `2026-10-29-c4-arms-6scenario.json` | 两个指定对手 + 我方 + 纯文本，7 臂 × 6 场景（修复前） | 42 | 我方 4/6、纯文本 6/6，暴露两个注入缺陷 |
| `2026-10-29-d0-step1-8arms-3reps.json` | 修复后 8 臂 × 6 场景 × 3 重复 | 147 | 我方 18/18、注入 97 tok（纯文本 360） |
| `2026-10-29-d0-step2-alias-rerun.json` | `deepseek-chat` 别名重跑 | 31 | 回执 `model=deepseek-flash`：**不是第二模型** |
| `2026-10-29-d0-step2b-v4pro.json` | 真第二模型 `deepseek-v4-pro` | 24 | 同样 6/6，费用为纯文本 0.43× |
| `2026-10-29-d1-5turn-compaction.json` | 5 轮压缩会话，4 臂 | 120 | 不省 token（1.01×），但把压缩后正确率从 6/12 拉回 12/12 |
| `2026-10-29-d1-10turn-compaction.json` | 10 轮压缩会话，4 臂 | 240 | 累计 prompt **0.51×**、费用 0.85×、正确率不降 |
| `2026-10-29-d2-extract-cost.json` | 抽取成本：每轮 / 批量 / 规则 | 18 | 每轮 1038 tok、批量 342 tok、规则 0 但抽不到（0/9） |
| `2026-10-29-scale-1k-10k.json` | 规模基准 1k / 10k | 0 | p95 201 ms / 1240 ms，命中 16/16 |
| `2026-10-29-cost-normalized.json` | 全部账本的峰价 / 谷价重算 | — | 618 次调用：峰价 ¥0.35794 / 谷价 ¥0.17896 |

## 怎么复核

```bash
# 1. 校验和（不联网）
node -e "const m=require('./docs/evidence/manifest.json');for(const f of m.files)console.log(f.name,f.sha256.slice(0,12),f.calls)"

# 2. 任意账本按谷价重算
node scripts/cost-normalize.mjs --out=.tmp/recheck.json docs/evidence/2026-10-29-d1-10turn-compaction.json

# 3. 重新跑（要 DEEPSEEK_API_KEY，费用按谷价量级）
node scripts/bench-c4.mjs --run --reps=3 --budget=12 --out=.tmp/c4/step1.json
node scripts/bench-d1.mjs --run --budget=3 --turns=10 --out=.tmp/c4/d1-10b.json
node scripts/bench-extract-cost.mjs --run --budget=2 --out=.tmp/c4/extract.json
```

重新生成证据包：`node scripts/pack-evidence.mjs`（只瘦身与改名，不改数字）。

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
