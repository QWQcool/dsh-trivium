# A-8：清掉凭空写出来的绝对日期

日期：2026-10-30。分支 `codex/r1-r2-reliability`。零模型调用、零费用。未发布、未推送。

前置：[A-5 扩样基线](A5-WIDER-BASELINE-2026-10-30.md) §2.4 记录的一条落库文本：

```text
On 2026-04-06 (per conversation context), user corrected: no longer use old Plan A, switch to Plan B.
```

对话发生在 2026-10-30，这句话里的日期**从未在对话里出现过**。抽取 prompt 明确要求“把日期留在事实文本里”，模型于是编了一个。

## 1. 改法

`lib/extract.js` 在候选进入写库前加了一道日期核对：

- 抽出候选正文里的**绝对日期**（`YYYY-MM-DD` / `YYYY/MM/DD` / `YYYY年M月D日`），统一成 `YYYY-MM-DD` 比较；
- 与**本轮窗口原文**（未截断的 turn 文本，不是给模型的那份 2400 字剪裁版）比对；
- 原文里没有的日期 → 从正文里删掉（连同 `On … ,` / `在 …，` / `（…）` 这类包裹），**事实本体保留**；
- 删完不足 6 字（说明整条就是那个日期）→ 整条拒写，原因记 `unsupported-date`；
- 每次删除都通过 `adjusted[]` 上报，`lastExtract.adjusted` 可见。

方向与 A-1/A-4 一致：**能救的事实救下来，救不了的说清楚**，不静默编造。

## 2. 验收

新增 `scripts/smoke-p49.mjs`（13 条）：

```text
ok the fact is still written
ok the invented date is gone from the stored text
ok the fact body survives
ok the removal is reported
ok the removed date is named
ok a supported date is kept
ok nothing is reported when the date is supported
ok format differences do not count as invented
ok no adjustment for a cross-format match
ok a date-only candidate is not stored
ok the refusal is named unsupported-date
ok an inline invented date is removed
ok the fact body still survives
P49: 17/17
```

全量：`node scripts/run-all.mjs` → **50/50 passed**（含 4 条相对时间放行用例）。

说明：这条**只有单测验证**。幻觉日期在真实运行里约 1/30 出现，重跑若干次也不能保证复现，所以没有“复现前/复现后”的对照证据。

## 3. 代价与已经补的放行

这道闸是**字面比对**，最初会误伤一类**正确**行为：用户说“下周五前必须提交”，模型解析成 `2026-11-06`，原文没有这个日期串 → 被当幻觉删掉。

已补放行规则（同轮）：

- 若窗口原文含**相对时间表达**（今天/明天/下周X/月底/年底/`N 天后`…）**且**该日期落在 `[now − 7 天, now + 400 天]` 内 → 视为合法换算，保留；
- 落在窗口外（如 A-5 那次差了半年的 `2026-04-06`）→ 仍然删除并上报。

p49 增加 4 条：正确换算保留、不误报；同窗口下的 `2020-01-01` 仍被删并上报。

仍有的边界：

- 只认 `YYYY-M-D` 三种写法；`04/06/2026`（美式）和 `6 April 2026` 不认。
- 中文数字日期（“二〇二六年四月六日”）不认。
- 过去 7 天以外的“上周三”这类解析仍会被删（窗口下界是有意的）。
- 日期出现在 `until`/`untilAt` 字段的路径不受影响。

## 4. 仍未解决

1. 相对时间换算放行（见上）。
2. 更大范围的日期格式（美式、英文月份）。
3. 时区：比较只用 `YYYY-MM-DD`，跨时区边界的“今天”可能差一天。
4. 中文数字日期（“二〇二六年四月六日”）不认。
