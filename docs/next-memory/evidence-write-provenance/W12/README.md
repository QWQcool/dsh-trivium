# W12 证据：独立验收的 5 个 P1 阻塞项，逐条修复

基线 `2c77f58`（验收对象）。验收方报告：`.tmp/independent-083-20261102/REVIEW.md`（未入库）。
本轮零模型费用，全部离线复现与回归。

## 0. 先承认结论

验收方判定**不可发布**，5 项 P1 全部复现属实。作者此前"69/69 通过"的表述没有覆盖这些方向，
尤其是 R-03、R-04 被错误地归入"只是还有重复副本"。

## 1. 逐条：现象 → 原因 → 修法

| 编号 | 现象（复现 key） | 原因 | 修法 |
|---|---|---|---|
| **R-01** | 用户只说"发布负责人是张三"，候选带 `supersedes: "方案 A"` 就把上线方案退休（`explicit-no-intent`）；写"上一个方案"同样（`deictic-no-intent`） | `resolveExplicitSupersede` 只校验 quote 命中用户轮 + 不是讨论，**没有要求句子表达替换**；代指名也被当成证据 | 新增 `wordingBacksIt`：句子或候选正文必须含替换词；**代指名不算证据**（代指只用于解析目标）。不满足 → `no-replacement-wording`，不退休 |
| **R-02** | "不要换掉方案 A，继续沿用。" 与 "请把"换掉方案 A"这句话翻译成英文。" 都退休了 A（`negative-cue`/`quoted-cue`） | 否定词表只有"不要替换"，不含"不要换/别换/继续沿用/翻译/引用"；引号内的替换词也被当指令 | 扩充 `NON_REPLACEMENT_CUES`（补回被误删的 `保持原样/先不动/暂不` 等）；新增 `cueInsideQuotes()`，引号内的替换词 → `quoted-replacement` |
| **R-03** | 两个会话都有 `seq=1` 且无 messageId 时，新会话的"改 B"被当成旧写入，`action=merge`，旧正文被覆盖（`cross-session-seq`） | 去重只比 `seq`，没有比 `sessionId`；序号只在会话内唯一 | `sameEvent()` 在缺 messageId 时**同时要求 sessionId 相同**，否则不算同一事件 |
| **R-04** | 同一句里的第二条事实（预算）被折进链节点并抛 `REVISION_PROTECTED`，预算没写入（`two-facts`）；同一改口重放为更长文本也抛错（`repeat-linked`） | ①"同事件 + 已存节点有替代边"被当作同一写入，证据不足；②`mergeInto` 对版本链节点改正文会抛错，而调用方没有兜底；③替换词属于整句，同句里的其他事实也拿到替换意图 | ①删除该折叠条件（只保留同名折叠）；②`REVISION_PROTECTED` 时改为 insert 而不是让整次写入失败；③替换意图要求**候选自身**含替换词或方案标签 |
| **R-05** | 合成凭据没有入库，但回环 `/status` 返回了它的片段 | 日期清洗先产生 `adjusted.preview`，凭据闸门在其后；预览直接进 `lastExtract` | 凭据闸门**前置**到日期清洗之前；`adjusted.preview` 再次过闸，不通过写 `<redacted>` |
| **R-06** | `emptyAnswer` 只在内部状态，HTTP `/status` 查不到 | 服务端白名单没有该字段 | `/status` 增加 `emptyAnswer`（与 `recovery` 同为进程内状态） |

## 2. 修后核对（同一批反例脚本，未改期望）

| 反例 | 修前 | 修后 |
|---|---|---|
| `explicit-no-intent` | 退休 A，head=3 | `no-replacement-wording`，head=2 |
| `deictic-no-intent` | 退休 A | `no-replacement-wording`，head=2 |
| `negative-cue` | 退休 A | `discussion-or-question`，head=2 |
| `quoted-cue` | 退休 A | `discussion-or-question`，head=2 |
| `cross-session-seq` | `merge`，旧正文被覆盖 | `insert`，旧正文保持，正常建链 |
| `two-facts` | `REVISION_PROTECTED`，预算丢失 | 两条都写入，只有改口建链 |
| `repeat-linked` | 第二次抛错 | 两次都写入，链不分叉 |
| 诊断脚本 | `adjustedLeaks=true`、`hasEmptyAnswer=false` | `adjustedLeaks=false`、HTTP 泄露 `false`、`hasEmptyAnswer=true` |

正例未被牺牲：`positive-chain` 仍保留旧正文、`currentHeadOf` 指向新节点、短地图 `decisions=1`、`ctx_read` 可读旧文。

## 3. 回归

- 新增 `p69` **18/18**：R-01/R-01b/R-02(否定、引用)/R-03/R-04(双事实、长文本重放) 全覆盖。
- 更新两处**期望**（不是放宽代码）：
  - `p65` 的"已替代目标"用例改成带替换词的句子，否则会先命中 `no-replacement-wording`；
  - `p67` 的"改名改写"用例改为断言**两条独立节点、不抛错**——按 R-04，没有同名证据就不该折叠。
- 全量 `run-all` **70/70**。

## 4. 仍然存在（与验收方判断一致）

1. 同义重复仍可能留下两条（改名/改措辞时不折叠），这是为了不误合并而接受的代价。
2. "零请求空回答"仍未复现，仍未定位；现在至少 `/status` 能看到 `emptyAnswer`。
3. 偶发 66/67 未复现，不声称已修。
4. `ctx_read` 不返回合并历史；历史只在 `listNodes` 与 UI。
