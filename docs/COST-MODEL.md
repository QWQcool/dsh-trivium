# 成本口径

更新：2026-11-16。目标是同质量下减少实际开销。旧的“省 80%”结论已撤回；当前开发顺序见 [ROADMAP](ROADMAP.md)。

## 1. 每轮分别记什么

- 生成模型调用、正文 embedding、query embedding 分开计数，包含失败、重试和工具循环。
- 记录请求模型、实际返回模型、prompt/completion/cache token、延迟、价格来源与生效日期。缺少用量不能记成零费用。
- prompt 中的估算 token 用于上下文预算，不当作实际计费 token；候选检索命中不当作回答质量。
- 本地推理可无 API 账单，但仍报告 GPU/CPU 时间、吞吐、磁盘和缓存空间。增加一个筛选模型的成本也算进去。

## 2. 实际账单与归一比较

2026-10-29 的历史约定是同时保留峰价上界与谷价归一值，对外比较使用谷价。这个约定继续用于重算那些冻结实验，归一值不是实际账单。

新实验先固定提供商、模型版本、价格快照与费用预算，原始账单和同价归一结果并列。不能按请求发生时间猜价格，也不能把未知费用或未完成请求删掉。真实价格在开跑时核对[官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，不把旧表当成今天报价。

## 3. 历史冻结数据（2026-10-29）

C4、D0、D1、抽取成本专项共 **622 次调用**，当时冻结价格的峰价为 **¥0.35791996**，谷价归一为 **¥0.17895998**。这是这一组实验，不是项目截至今天的全部花费。旧 618 是把格数和请求数混用，已纠正。

原始账本和 manifest 在 [evidence](evidence/README.md)。既有 pricing/model-ledger/cost-normalize 工具保留当时重算能力，不用今天的新价格覆盖它们。

```sh
node scripts/cost-normalize.mjs --out=.tmp/cost-normalized.json <ledger.json...>
```

输出按臂记录 calls、promptTokens、cachedTokens、completionTokens、cnyPeak、cnyOffpeak 和 grandTotal；不联网，不覆盖原始证据。

## 4. 低成本改进的放行条件

先用相同语料、预算和模型比较：事实入库不漏、错误注入不增、最终回答不退步，再判断减少了多少请求、实际 token 和费用。分开报告冷启动/缓存命中、词面/向量路径及 p50/p95。失败样本、预算拒绝和缓存失效必须在报告中。
