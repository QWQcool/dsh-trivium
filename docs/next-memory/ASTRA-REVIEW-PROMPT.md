# 给 Astra 的验收提示词（0.8.3 发布前）

> 用法：整段复制给 Astra。它要求"先跑再判"，并明确禁止发布和付费调用。

---

你是这次改动的**独立验收人**，不是开发者。目标是判断：这批改动能不能作为 **0.8.3** 发布。
请以"想办法推翻作者的结论"为默认姿态，而不是"确认它看起来没问题"。

## 一、环境与基线

```
仓库：C:\Users\v_chchsli\Desktop\dsh-trivium
分支：main   HEAD：7257628
npm：latest = 0.8.2（这批改动尚未发布）
范围：v0.8.2..HEAD 共 19 个提交，86 个文件，+6900/-539
```

作者声称的基线（请自己复核，不要采信）：

```powershell
cd C:\Users\v_chchsli\Desktop\dsh-trivium
git log --oneline v0.8.2..HEAD
git status --short                     # 应为空
node scripts/run-all.mjs               # 声称 69/69
node scripts/verify-evidence.mjs       # 声称 9/9
node -e "console.log(require('triviumdb/package.json').version)"   # 应为 0.9.0-beta.3
node -e "console.log(require('./package.json').version)"           # 仍为 0.8.2
```

## 二、按风险排序的验收点

每条都写了"怎么验"和"通过标准"。**不要只看测试名，要看不通过时会发生什么。**

### A. 写入正确性（会丢事实或给出过期答案，最高优先）

1. **改口必须建链，且旧正文不能被覆盖**
   - 验：`node scripts/smoke-p63.mjs`、`smoke-p65.mjs`、`smoke-p67.mjs`
   - 手工反例：造两条决策 A → 用户说"算了，不用 A 了，改 B"，模型候选把两句写进同一句。
   - 通过标准：旧节点正文保持原样 + 新节点 + `supersedes` 边；`currentHeadOf(旧)` 指向新节点。
   - **要主动尝试的反例**：把"讨论/疑问/引用/假设/保持原样"混进去（例如"我们还在讨论要不要换掉方案 A"），必须**不**退休任何决策。

2. **替换语义的四道闸不能互相抵消**
   - 代码位置：`lib/extract.js` 的 `REPLACEMENT_CUES` / `NON_REPLACEMENT_CUES` / `detectReplacementIntent` /
     `resolveExplicitSupersede` / `DEICTIC_SUPERSEDE` / `findDuplicateWrite`。
   - 要回答：放宽替换词和裸字母之后，有没有可能把**仍然有效**的决策退休？
   - 通过标准：每条放宽都有对应的反例测试，且反例真的走的是那条分支（不是被别的条件挡住）。

3. **日期闸门**
   - 验：`smoke-p49.mjs`。
   - 通过标准：幻觉日期被删且上报；正确的相对时间换算（"下周五"→具体日期）被保留；
     A-5 那种差半年的日期仍被删。
   - 已知边界（不算缺陷，但要说清）：不认 `04/06/2026`、英文月份、中文数字日期。

4. **空抽取与可疑空回答**
   - 验：`smoke-p44.mjs`、`smoke-p66.mjs`。
   - 通过标准：空字符串 = 失败（保留 pending）；`{"candidates":[]}` = 成功；
     但"窗口明显含决策 + 规则层也没产出"时会**再问一次**，最多一次，且仍走同一套闸门。

5. **凭据闸门**
   - 验：`smoke-p46.mjs`。
   - 通过标准：GitHub/AWS/Google/npm/Slack/JWT/PEM、中文"密码/口令/密钥 + 值"被拒；
     "token 预算 500"、"密码学很难"这类**不被**误拒；拒绝报告里不回显密文。
   - **重点质疑**：`reasoningEffort: "off"` 之后模型不再自行隐去敏感内容，安全职责全压在这套正则上。
     请判断这个取舍能不能接受，以及正则的覆盖边界是否被如实记录。

### B. 可追溯与并发

6. **来源贯穿**：`smoke-p50.mjs`。节点要带 `seq/messageId/at/role/quoteMatch`；没有来源的老节点要显示 unknown，
   **不能**用节点 id 或当天日期伪造。要质疑：`hostText` 恒为 `unavailable` 是不是在掩饰什么。

7. **单写者**：`smoke-p54.mjs`、`smoke-p55.mjs`。两个进程同时写一个工作区时，只能有一个写，
   另一个报 `lock-busy` 且保留 pending；锁在**开库之前**获取（顺序错了第二个进程会崩，实测过）。

8. **变更记录与合并历史**：`smoke-p53.mjs`、`smoke-p64.mjs`。
   上限 200 条、裁剪要写 marker、落盘前脱敏、`opId` 幂等、按工作区隔离；
   合并覆盖正文前把旧正文存进 `payload.history`（上限 3、倒序、凭据旧文变 `<redacted>`）。

### C. 行为变化（发布说明必须写清）

9. **决策不再被"合并"覆盖**：替换场景改为新增节点 + 建边。旧库里同一个决策的多次改写会变成链。
   - 要判断：这对外是不是 breaking change？release notes 该怎么写？
10. **短地图只列当前**：已替代的决策不再出现在短地图，`ctx_read` 仍可读到。
11. **会话启动最多等 8 秒**重放 pending（`PENDING_REPLAY_WAIT_MS`），超时后台继续。

## 三、证据怎么查

```
docs/next-memory/WRITE-PROVENANCE-RESULTS.md      总表（F-W 编号与状态）
docs/next-memory/CORRECTION-CHAIN-ANALYSIS.md     改口建链的成因与三方案对比
docs/next-memory/evidence-write-provenance/W1..W11/   每片的修前/修后证据
```

每一片都应有：修前失败输出 + 修后通过输出 + 说明。**请抽查至少 3 片**，
确认"修前"确实是失败的（不是事后编的），以及"修后"的命令能重现。

## 四、作者已声明的未解决问题（请判断是否阻塞发布）

1. **同义重复只修好 1/3**：`findDuplicateWrite` 按"同一事件 + 同名 / 同一事件 + 已建替代边"折叠，
   真机 3 次里 r1 折叠成功、r2/r3 仍存两条措辞不同的副本。根因未完全隔离。
2. **"零请求的空回答"未复现**：W9 真机有一轮提问根本没有发出模型请求；用桩只能复现"空文本"这一种，
   两者不同源。现在有 `status.emptyAnswer` 计数与每任务请求数记录，但没有修复。
3. **偶发 66/67 未复现**：代码冻结后连跑 3 次均 69/69，早先那次失败没有留下脚本名。
4. **`status.emptyAnswer` 只做了单测**，没有在长驻宿主里端到端验证过。

## 五、不要做的事

- **不要发布**（不要 `npm publish`、不要打 tag、不要创建 GitHub Release）。
- **不要改版本号**、不要改 schema/DIM、不要动 `triviumdb` 的 pin。
- **不要跑付费模型实验**（需要用户单独批准；离线与桩足够完成本次验收）。
- **不要动真实默认工作区** `%USERPROFILE%\Documents\deepseek-harness\default-workspace`；
  需要干净库时用临时目录 + 隔离 `DSH_HOME`。
- 不要为了让测试变绿而修改测试期望——若认为期望本身错了，请单独指出并给理由。

## 六、交付格式

请给出：

1. **结论**：可以发布 0.8.3 / 不可以（列出阻塞项，每条给出文件:行号与复现命令）。
2. **逐条判定**：上面 11 个验收点各自「通过 / 未通过 / 无法判定」，附你实际跑的命令与输出摘要。
3. **主动找到的问题**（如果有）：作者没提到、但你在 diff 或测试里发现的。
4. **发布说明建议**：如果可发布，指出 release notes 里必须写明的行为变化与已知限制。
5. **你验证到哪一层**：只跑离线 / 也起了真宿主 / 只读了代码。请明确区分，不要用"看起来没问题"代替验证。
