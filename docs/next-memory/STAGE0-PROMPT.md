# 阶段 0 开工提示词（一次性执行）

> 用法：整段复制给新会话的 AI。它自带基线、阅读顺序、五个工单、验收标准与硬约束。

---

你要在 `C:\Users\v_chchsli\Desktop\dsh-trivium` 上**一次性完成「阶段 0」的五项工程**。
这是已有项目的增量开发，不是从零开始。**先读、再核、再动手**，不要凭猜测改代码。

## 一、基线（先核实，不要相信本文的数字）

```powershell
cd C:\Users\v_chchsli\Desktop\dsh-trivium
git log --oneline -3          # 应为 59e8831 docs: turn the borrowed ideas into work orders...
git status -s                 # 应为空
node scripts/run-all.mjs      # 记录当前通过数（写作时是 73/73，你必须自己确认）
node -e "console.log(require('./package.json').version)"   # 应为 0.8.3
```

任何一项与上面不符：**先停下并报告**，不要继续。

## 二、必读（按顺序，读完再写代码）

1. `docs/next-memory/CURRENT-STATE.md` —— 当前状态与"别再重复做的实验"
2. `docs/next-memory/ROADMAP-AND-SUPERAGENT.md` —— **第五节（B1–B6 工单）** 与 **第六节阶段 0**
3. `docs/release-0.8.3.md` —— 上一版改了什么、有哪些已知限制
4. `docs/next-memory/SUPERSEDE-CONTRACT-OPTIONS.md` —— 为什么"改口建链"不再扩大改动范围

## 三、代码地图（省你翻仓库的时间）

| 关注点 | 位置 |
|---|---|
| 会话启动、注入短地图、状态对象 | `lib/index.js`（`onAgentStart`、`runExtract`、`workspaceStatus`） |
| 短地图生成、节点列表 | `lib/store.js`（`buildShortMapReport`、`listNodes`） |
| 抽取入口、内容门、闸门 | `lib/extract.js`（`distill`、`shouldExtractBatch`、`filterCandidates`） |
| 写锁 | `lib/workspace-lock.js`（`acquireWorkspaceLock`、`withWorkspaceLock`） |
| 变更记录 | `lib/change-log.js`（`CHANGE_REASONS`、`noteChanges`、`readChanges`） |
| 工具（**不许改**） | `lib/tools.js`（`ctx_find`/`ctx_read`/`ctx_remember`/`ctx_forget`） |

## 四、五个工单（按此顺序做，一个工单一个提交）

> 顺序理由：B2 是 B3 的前置（没有"哪些是热的"就算不出差异），B1/B5 互不依赖，作用域抽象放最后做，避免干扰前面四项的回归。

### S0-1　B2 地图热度（`lib/store.js` + `lib/tools.js` 的调用点）

- **做什么**：`ctx_read` / `ctx_find` 命中时更新节点的 `lastUsedAt`，地图排序改为
  `(引用次数, 最近使用, 更新时间)` 降序；写盘走**旁路 JSON**，节流（≤1 次/60 秒/工作区），不要进主库事务。
- **不许做**：不改四工具的参数与返回结构（只在命中时记录副作用）；不改 schema 版本。
- **验收**：新测试（沿用编号，见第六节）构造 50 条事实、只问其中 3 条，重建地图后 3 条必须在
  400 token 预算内出现；同一夹具的注入 token 数**不上升**。

### S0-2　B3 增量地图注入（`lib/index.js`）

- **做什么**：地图带 `mapVersion`（事实集合指纹 + 预算）；会话内记录上次注入的版本，
  未变化则**不重复注入**；变化时注入"变更摘要 + 差异行"。
- **必须强制全量的场合**：会话首轮；距上次注入超过 N 轮（自己定 N 并写进注释与测试）；
  版本号不可计算（旧库/异常）。
- **约束**：四工具不动，模型必须仍能靠 `ctx_find`/`ctx_read` 补全；摘要行里要明确"还有多少条未展开"。
- **验收**：连续 3 轮无新事实的会话，注入 token 下降 ≥50%，且"该提到的事实仍被提到"（用现有夹具判定）。

### S0-3　B1 事件两级过滤（`lib/extract.js`）

- **做什么**：新增 `screenEvent(text) → 0|1|2`（0 = 寒暄/纯工具指令；1 = 可能有事实；2 = 明确有事实）。
  0 分不进窗口、不调用模型；2 分进 batch 前排。**不新增模型调用**，"语义慢判"仍复用抽取调用本身。
- **红线**：0 分只能命中**完整白名单**（寒暄、纯命令、纯路径），规则要可审计、可测试；
  宁可给 1 分也不要把可能有事实的句子判 0。
- **验收**：同一批夹具下模型调用数下降 ≥20%，抽取命中不下降；为误判准备 ≥5 条反例测试。

### S0-4　B5 卡住检测与自愈（`lib/index.js` + `lib/change-log.js`）

- **做什么**：把"抽取超时 / 锁未释放超过 TTL / 重放超预算"记成 `stuck` 事件（进 status 与变更记录）；
  下次会话启动清理 stale 锁并重放 pending 后，补一条 `recovered` 记录。
- **约束**：每类事件每会话只记一次（避免日志噪声）；不改锁的 TTL 默认值。
- **验收**：桩让抽取卡 30 秒 → status 出现 `stuck`；下一轮正常抽取并记录 `recovered`。

### S0-5　作用域抽象（`lib/store.js` + 调用点）

- **做什么**：把 `cwd` 参数抽象为 `scope`：`workspace`（默认，行为与现在完全一致）/ `parent` / `inherit`。
  本阶段**只加参数、不实现继承语义**，`parent` 与 `inherit` 可以抛"未实现"或退化为 `workspace`，但必须有明确分支与注释。
- **为什么现在做**：等 Super-agent 上 DSH（每个 work item 一个目录）时，改动点收敛到一处。
- **验收**：默认路径行为零变化（全量回归绿）；新增测试证明三种 scope 都能被解析且默认不改变落库位置。

## 五、硬约束（违反即视为失败）

- **不发布**：不 `npm publish`、不打 tag、不建 Release、**不改版本号**。
- **不改契约**：四工具名称/参数/返回、schema 版本、`DIM=1536`、`triviumdb` pin 全部不动。
- **不花钱**：不调用真实模型（需要时用本地桩 `.tmp/r3/stub.mjs`，或直接给假 `llmCall`）。
- **不动真实环境**：不改 `~/.dsh`、不写默认工作区 `Documents/deepseek-harness/default-workspace`；
  需要宿主时用隔离 `DSH_HOME` + 临时工作区。
- **不覆盖别人的测试**：新增测试用**下一个可用编号**（当前最高 `p72`，从 `p73` 起），
  建文件前先 `Get-ChildItem scripts -Filter "smoke-p*.mjs"` 确认没占用。
  （历史教训：有人用 `p56` 覆盖了既有测试，被迫改名重做。）
- **不改测试期望来凑绿**：若认为旧期望本身错了，单独说明理由，不要静默放宽。
- 遇到阻塞（接口不明、回归解释不通）**停下来报告**，不要用猜测补齐。

## 六、每个工单的交付形态

1. 代码改动（最小必要）
2. 新增 `scripts/smoke-pNN.mjs`，覆盖该工单的"验收"条目 + 反例
3. 全量 `node scripts/run-all.mjs` 必须全绿（通过数只增不减）
4. 一个提交，信息格式：`feat(context): <一句话>` + 正文写「改了什么 / 为什么 / 验收怎么测的 / 已知边界」
5. 证据文档 `docs/next-memory/evidence-write-provenance/S0/<工单号>/README.md`：
   修前行为、修后行为、跑过的命令与输出摘要、未覆盖的部分

## 七、测试写法上的坑（都是踩过的）

- `check()` 若接收 async 回调**必须 `await`**，否则打印 ok 时断言还没跑。
- `store.openWorkspaceDb` 与 `store.closeAll()` 的顺序要留意：中途 `closeAll()` 后再 open 同一工作区可能拿到已关闭的句柄；测试脚本建议**结束时统一 close**。
- 内容门会跳过"继续。""ok"这类填充句，测试要喂真实句子，否则根本不会调用模型。
- 临时目录统一 `mkdtempSync(join(tmpdir(), 'trivium-pNN-'))`，`finally` 里删除。

## 八、完成后的报告格式

```
基线：HEAD 59e8831 → HEAD <新>；run-all <前> → <后>
S0-1 B2 地图热度   ：改了什么 / 验收结果 / 未覆盖
S0-2 B3 增量注入   ：同上
S0-3 B1 两级过滤   ：同上
S0-4 B5 卡住自愈   ：同上
S0-5 作用域抽象   ：同上
新增测试：p73..pNN，各自条数
未发布确认：version 仍 0.8.3，无 tag、无 publish
遗留问题：<逐条列，不要隐藏>
```

如果某项做不到（例如 B3 的 token 降幅不达标），**照实说"未达标 + 实测数字 + 原因"**，
不要用"基本达到"一类措辞。
