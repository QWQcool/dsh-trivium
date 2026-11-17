# 开发与验证

更新：2026-11-17。功能状态和最近验证见 [CURRENT-STATE](CURRENT-STATE.md)，下一步见 [ROADMAP](ROADMAP.md)。本页替代按版本复制的开工提示词和机器交接稿。

## 环境与命令

Node 满足 `^22.19.0 || >=24`。源码运行依赖固定 TDB 0.9.1；开发依赖包含 0.9.0 的别名，仅用于合成旧库迁移回归，并固定真实 dsh-llm/dsh-tools 0.2.2-rc.1。依赖直接从 registry 安装，不要求已有用户 DSH profile。旧 .npmrc 的 omit/legacy-peer-deps 绕过已移除，干净安装会解析所需的 Cordis 等 peer 依赖。

```sh
npm ci
npm test
npm run test:list
npm test -- p93
npm test -- p99
npm test -- p100
npm test -- p101
npm test -- retrieval
npm run test:docs
```

筛选保持子串语义：`p8` 匹配 p8、p80 等，`p93` 只匹配该组；主题名匹配所属集合。`--list` 只列出匹配项。

真实宿主验收另用对应版本 DSH 和独立 `DSH_HOME`。`node scripts/link-dsh.mjs` 会修改所选 profile、联入源码并对齐宿主 peer 模块，只在准备联调时运行。

## 回归组织

`run-all.mjs` 发现数字 smoke 和主题集合。每个逻辑用例仍在独立子进程中运行，使用独立临时 DSH_HOME 和设置；合并不共享原生句柄、模块状态或测试数据。保留历史 p 编号筛选。

| 集合 | 历史用例 | 覆盖 |
|---|---|---|
| smoke-retrieval | p30/34/35/37/104 | 精确名、廉价门控、业务路径、注入覆盖、记忆包完整事实预算/C4/快照 |
| smoke-extraction | p43/45/46/49/50/66/100/103 | 指令里的事实、推理降级、敏感值、日期、来源、空回答、记忆回显与无来源候选的持久复核和宿主重放 |
| smoke-revisions | p31/48/64/67/69 | 版本链、提案、历史正文、重复事件、拒绝保护 |
| smoke-audit-locks | p53/54/55/56 | 审计、工作区锁、双进程和真实 HTTP |
| smoke-evaluation | p33/39 | 评分、实验隔离、请求前费用预留 |
| smoke-kernel | p99 | 用真实 0.9.0 创建合成库，核对 0.9.1 打开、写入、重开前后的节点、向量和边 |
| 其余 smoke-pN / p2-cases | 原编号 | 较大的端到端、UI、宿主、查询和发布契约 |

自调用 worker、路径敏感用例和冻结 UI 测试本轮保留原文件。以后按职责合并，不为每次修复新建脚本，也不为文件数把所有测试塞进一个模块。

## 实验与维护

| 目的 | 入口 |
|---|---|
| 回归与文档 | `npm test -- <selector>`、`npm run test:docs` |
| 成品干净消费 | `node scripts/verify-package.mjs <installed-directory>` |
| 本地向量、范围检索、缓存重放 | `verify-local-embedding.mjs`，参数见[结果](reviews/LOCAL-EMBEDDING-READ-RESULTS-2026-11-12.md) |
| 记忆离线基线（零模型调用） | `node scripts/memory-eval.mjs --out FILE --reps N`（`--split dev` 或 `--split holdout` 可只跑一组），夹具 `scripts/fixtures/memory-eval-v1.json`，见[基线](reviews/MEMORY-EVAL-BASELINE-2026-11-16.md) |
| TQL 负载、写延迟 | `bench-live-tql.mjs`，见[方法](reviews/WRITE-LATENCY-RESULTS-2026-11-12.md) |
| 原始证据完整性 | `node scripts/verify-evidence.mjs` |
| Router / 并发 | `bench-router-queue.mjs`、`bench-lock-contention.mjs` |
| 随包维护 CLI | check-integrity、clear-expired-until、prefs-export、query-snapshot |

bench-c3/c4/d1、成本归一和评分工具仍被实验回归调用，继续保留。旧实验结论按 [HISTORY](HISTORY.md) 理解。先核对离线/联网参数，不批量运行带 `--run` 的历史实验。

记忆评测须在独立进程运行，`--out` 选择不存在的新文件；`--reps` 为 1–20 整数。v2 同时记录源码/依赖哈希、冻结夹具哈希、待核对候选、同 ID 正文不符与记忆包预算违规。离线入口替换 `fetch` 拒绝意外 provider 请求，结束时恢复环境；token/账单和最终回答仍为未测。来源检查与只读记忆包的结果见 [2026-11-17 记录](reviews/MEMORY-EVAL-2026-11-17.md)。桌面隔离时同时设置 `DSH_HOME` 和 `DSH_TRIVIUM_SETTINGS`，后者用于隔离插件设置文件。

## 文档维护

- 用户操作在双语 README；源码契约在 PLAN/read-api；状态在 CURRENT-STATE；任务在 ROADMAP；发布动作在[检查清单](release-checklist.md)。
- 完成工作更新已有状态和结果入口；有独立测量/复现才新增报告，不再复制提示词、回交模板和“下一轮”清单。
- 旧阶段资料已合并到 HISTORY，通过固定提交链接查原文。保留报告更新状态提示和链接，原日期、失败结果、发布回执和原始 JSON 不改成今天的结果。
- 文档校验检查 Markdown 本地链接目标，不验证外链可用性及全部标题锚点。外部能力判断记录来源、版本和核对日期。

## 发布

发布须有单独明确授权，按 [release-checklist](release-checklist.md)冻结范围、同步版本、回归、审查最终 tarball、标准干净安装和隔离宿主验收，再发布同一产物。历史交接稿不构成今天的发布任务。

格式变更单独验收。开发依赖不能用来掩盖成品的 peer 冲突；消费验证不使用 `--force` 或 `--legacy-peer-deps`。不移动已发布 tag，本轮维护不改版本号。
