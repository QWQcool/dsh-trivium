# A-1：工具指令句不再吞掉事实（未提交）

日期：2026-10-30。分支 `codex/r1-r2-reliability`。版本仍 0.8.1，未发布、未推送。
起点证据：[R3 结果 F1](R3-HOST-RESULTS.md)（`lib/extract.js` 的整轮过滤）。

## 问题（修前实测失败）

`distillableTurns()` 对用户轮用 `TOOL_DRIVE_CUES`（`只用 ctx_` / `贴工具原文` / `按顺序调用`）**整轮丢弃**，而且发生在门控之前：

```text
输入：按顺序调用工具，生产端口是 9443。
shouldExtractBatch → { call: false, reason: "empty" }
```

后果不是“延后抽取”，而是这一窗口被成功消费、规则与模型都不跑、pending 也不保留。

## 改法

`lib/extract.js` 把“整轮过滤”改成“**整句过滤**”：

- 按句切分（`。！？!?` 与换行）；
- 一句话只有在**去掉指令短语和 `ctx_*` 工具名之后，剩余字符全部落在极小的指令填充白名单里**（请/先/然后/一下/把/工具/原文/查/看看/的了吧…，≤10 字）才算“纯操作句”；
- 一个用户轮**所有句子都纯操作**才整轮丢弃；只要有一句带数字、拉丁标识、名字或额外分句，就整轮保留，走原有抽取路径。

方向仍是 R1 的原则：**证不空就交给抽取**；多调一次模型只花几分钱，丢事实不可逆。

## 验收

新增 `scripts/smoke-p43.mjs`（17 条，被 `run-all` 自动发现）。

修前（同一份用例，实际输出节选；脚本在更后面的断言处因取值方式写错而中断，所以没有打印总数）：

```text
FAIL mixed tool cue keeps the fact: 按顺序调用工具，生产端口是 9443。
FAIL extraction prompt carries the fact text: '' 没有匹配 /生产端口是 9443/
FAIL gate does not report a skip for a mixed turn: Cannot read properties of undefined (reading 'skipped')
FAIL extracted fact is applied to the database: 0 !== 1
```

（`distill()` 当时走的是“无内容”早退，返回对象里连 `gate` 字段都没有。）

修后：

```text
ok mixed tool cue keeps the fact: 按顺序调用工具，生产端口是 9443。
ok mixed tool cue keeps the fact: 只用 ctx_find，负责人是张三。
ok mixed tool cue keeps the fact: 贴工具原文：预算上限改成 5000 元。
ok mixed tool cue keeps the fact: 只用 ctx_read 读一下，别再推荐看过的视频。
ok count fact survives the cue
ok pure operation wording may skip: 只用 ctx_find。
ok pure operation wording may skip: 按顺序调用工具。
ok pure operation wording may skip: 贴工具原文
ok assistant fact still opens the window
ok rule candidate still produced for a mixed turn
ok extraction prompt carries the fact text
ok gate does not report a skip for a mixed turn
ok extracted fact is applied to the database
ok pure operation turn applies nothing
P43: 17/17
```

全量：`node scripts/run-all.mjs` → **44/44 passed**（p36 宽松门控、p38 中文事实/待处理/长文本等全部保持通过）。

真实宿主复验（隔离 `DSH_HOME`，本地模型桩，零费用）：同一句混合句 + 一轮“继续”，`F1CHECK: 4/4`

```text
ok extraction was requested for the mixed turn — requests=1
ok extraction prompt carried the fact
ok fact is in the workspace database — ["…workspace…", "生产端口是 9443。"]
ok session resumed
```

（修前这一轮 `reason:"empty"`，不会产生抽取请求，也不会有节点。）

## 取舍与残留

- **白名单是保守方向的近似**：宁可多调一次模型，也不把带内容的句子当操作语。已知漏网（会被保留、多花一次调用）例如 `只用 ctx_find 查一下端口`——`端口` 不在白名单，保留是对的。
- 仍未处理：`贴工具原文` 出现在**句首但整句是工具名+事实**时保留（正确）；但**纯操作句与事实分句在同一行没有标点分隔**（如 `按顺序调用工具 生产端口是 9443`）依赖白名单判断，属同一近似。
- 与 R3 的 S3 长文本尾部漏记（F7）**无关**，那是另一条链路，尚未定位。
- 本次没有改任何默认开关、预算、DIM、数据格式；`distill()` 的返回结构与 pending 语义不变。
