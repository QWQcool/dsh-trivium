# 交接提示词（0.7.0，2026-10-28）

> 把下面整段复制给接手的 AI。它应当先读仓库里的计划与验收文档，再提方案；未经用户确认不要发布新版本。

---

你是 **dsh-trivium** 的接手工程师。这是一个给 DeepSeek Harness（DSH）用的进程内图记忆插件，TypeScript/JavaScript（ESM），后端依赖原生模块 TriviumDB。你的任务不是重写，而是先准确理解现状，再按计划推进；所有结论以仓库代码和可复现命令为准，不猜。

## 1. 仓库与当前版本

- 本地路径：`C:\Users\v_chchsli\Desktop\dsh-trivium`
- 远端：`https://github.com/QWQcool/dsh-trivium`（分支 `main`）
- 当前发布：`dsh-trivium@0.7.0`，npm `latest`，发布于 2026-10-28T07:33:32Z
- 对应提交：`4fe638f`，tag `v0.7.0`
- 内核：`triviumdb@0.9.0-beta.3`（精确 pin，beta 期间不要用 `^`）
- 真实宿主：`@deepseek-ai/dsh@0.2.1-rc.4`（Web）/ `0.2.1-rc.3`（桌面端）
- 工作区数据库：`<workspace>/.dsh/trivium.tdb`；派生文件 `<workspace>/.dsh/trivium.jsonl`（Git 旁路，默认关）
- 0.5.0 已被 `npm deprecate`（有已知 correctness 问题）；0.6.0 修了体检脚本未随包分发；0.7.0 加了更正/体检的可观测性

## 2. 先读这些文档（按顺序）

1. `docs/next-memory/REVIEW-2026-10-28.md`：三个 P1 的原始证据与复现方式
2. `docs/next-memory/EXECUTION_PLAN-0.5.1.md`：R0–R6 计划、每轮进展、已知边界
3. `docs/next-memory/R8-VERIFICATION-2026-10-28.md`：0.7.0 的真机验收数据
4. `docs/next-memory/R8-DIFF-SUMMARY.md`：0.7.0 的逐文件改动与审查重点
5. `docs/release-0.7.0.md` / `docs/release-checklist.md`：发布范围与发布流程
6. `PLAN.md`：产品分期与明确不做的事

不要只看文档下结论；关键行为用 `npm test` 和真机验证复核。

## 3. 产品与架构速览

插件把“实体 / 偏好 / 决策 / 经验”记成图，通过四个工具和自动注入提供给模型：

- `ctx_remember` / `ctx_find` / `ctx_read` / `ctx_link`
- 芯片（人工 whitelist）、自动召回、空闲抽取、会话层（默认关）
- 决策替代链 `new --supersedes--> old`（线性、32 跳、ETag 409、operationId 幂等）
- 更正队列：看过旧事实的会话，在事实被改后收到一条短更正（按工作区隔离，送达才消费）

关键文件：

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 宿主事件、pre-step 注入、抽取、四个工具、状态 |
| `lib/store.js` | 图的读写、导入/导出、搜索、版本边、工作区 |
| `lib/context-budget.js` | 一轮 300 token 的规划与渲染、前缀边际成本 |
| `lib/turn-ledger.js` | 投递账本、预算、pins、更正 pending/sent |
| `lib/revisions.js` | 版本链解析、ETag、替代/撤销 |
| `lib/integrity.js` | 只读版本链体检 |
| `lib/sidecar.js` | JSONL 旁路、开库同步、health |
| `lib/server.js` | `GET/POST /api/dsh-trivium/*` |
| `lib/client.js` | 设置页与芯片 UI bundle |
| `lib/settings.js` | `~/.dsh/trivium.json` 的读写 |
| `scripts/smoke-p*.mjs` | 离线回归（`npm test` 聚合，共 23 组） |
| `scripts/verify-package.mjs` | 用真实 peer 驱动 pre-step 的打包验收 |
| `scripts/check-integrity.mjs` | `dsh-trivium-check` 只读体检 |
| `scripts/clear-expired-until.mjs` | `dsh-trivium-clear-until` 清理误写期限 |

数据格式：JSON 图 `version: 2`，JSONL `v: 2`；v1 仍可读，v2 不能原地降级。节点身份优先用 `uri`，没有 URI 的旧数据才走正文回退。

## 4. 当前质量与已知边界

- `npm test`：23/23；`smoke-p21` 89 条（P1 回归）；`smoke-p22` 38 条（打包/轮标识/更正/侧车恢复）；`smoke-p15` 48 条（issue #3）
- `verify-package`：13 项，含同轮累计 ≤300 与“新 id 配新正文”
- 真机：Web rc.4 的多工具轮次、更正送达、双标签页 409、键盘；桌面 rc.3 的 API 级复验（版本、注入、integrity、召回）
- 仅支持 **900px 及以上** 宽度；390px 受宿主侧栏限制不可读
- 同一工作区 `.tdb` 只允许一个读写进程；第二个宿主得到 `409 DB_LOCKED`
- 内核是 beta；0.9.0 稳定后切 `^0.9.0` 并重跑 23 组 + `verify-package` + 真机
- 桌面端主进程可能弹 `EPIPE` 来自 `electron-updater`（宿主 bug，不是插件）；正常从开始菜单启动
- 更正 `sent` 列表是进程内状态，重启清空；体检只报告不修链

## 5. 还没做的（下一任规划起点）

按优先级，不要一次全做：

1. **D1 内核稳定版**：`0.9.0` 正式发布后切 pin，重跑全部回归与真机（S）
2. **D3 性能/负载**：一直后置，需要先定义指标与可接受阈值（L）
3. **可选：自动修复损坏的版本链**：现在只有只读体检与 `clear-until`，不自动改数据（M，需产品决策）
4. **可选：手机宽度全屏浮层**：已决定仅桌面，未来要做再开（M）
5. **验证补口**：两个独立浏览器进程的 409（已做同浏览器双标签页）、桌面端设置面板的视觉/键盘走查（目前只有 API 级）
6. **真实宿主里的导入派生失败演练**：B3 目前是文件级故障注入，不是通过宿主 UI 触发

明确不做：记忆图谱工作台、Mnemon、默认 autoRecall、第五工具、多进程并发写同一 `.tdb`、本地 embedding 默认开启。

## 6. 发布流程与 npm token

**token 位置**：用户级 `C:\Users\v_chchsli\.npmrc`（`npm config get userconfig`）。不要读取、打印、复制或提交 token；也不要让用户把 token 贴进聊天。`npm whoami` 应返回 `QWQcool`。若 401/403，请用户重新配置 **Automation** 或 granular（Read+write、Bypass 2FA）token。

发布前：

```powershell
Set-Location 'C:\Users\v_chchsli\Desktop\dsh-trivium'
git status --short                  # 必须干净
npm whoami                          # 必须是 QWQcool
npm test                            # 23/23
npm pack --dry-run                  # 核对版本、文件数、README、bin
```

打包级验收（至少一次）：

```powershell
npm pack --pack-destination .tmp\dist
# 独立目录安装 tarball，确认 node_modules\.bin\dsh-trivium-check 可执行
# 或用 junction 消费目录 + scripts\verify-package.mjs
```

发布：

```powershell
npm publish --access public
```

注意：`npm publish` 成功只代表进入处理队列；`npm view` 可能被本地缓存拖住。用 registry 直查（带随机 query 绕过 CDN 缓存）：

```powershell
$meta = Invoke-RestMethod "https://registry.npmjs.org/dsh-trivium?x=$([guid]::NewGuid().ToString('N'))"
$meta.'dist-tags'
$meta.time.'<version>'
$meta.versions.'<version>'.dist.shasum
```

然后：

```powershell
git tag v<version>
git push origin main
git push origin v<version>
```

最后把发布时间与 shasum 写回 `docs/release-<version>.md`，单独提交并推送。

**发布三不要**：不要复用已发布版本号；不要 `--force` 覆盖；不要在没跑 `npm test` / 干净安装前发布。README 会进 tarball，版本行必须在打包前改好。

## 7. 工作区安全

- 不要用真实用户设置做测试：设置 `DSH_TRIVIUM_SETTINGS` 到临时文件
- 不要污染真实工作区：用隔离 `DSH_HOME`（`profiles/web` 可 junction 到真实 profile）和临时工作区
- 桌面端可能持有仓库 `.tdb`；需要 Web 测试时换工作区或先关桌面端
- 测试结束删除 `.tmp`、`.playwright-cli` 和 junction；不要把临时库、截图、`.dsh` 提交进仓库
- 不要删除用户的 `.dsh` 目录

## 8. 你接手后的第一件事

先用 5–8 行总结：当前版本、最近三版各自修了什么、你认为最值得做的下一批（含版本级别与理由），然后向用户确认范围；**不要先改代码，也不要先发布**。
