# 公司电脑接手与 npm 发布交接（2026-11-12）

源码：[QWQcool/dsh-trivium](https://github.com/QWQcool/dsh-trivium)，**直接交付 `origin/main`，不走 PR**。起点 `aec511e` 已含 #4、#6；本轮功能提交 **`9d7b96a0eec85e0dc07daa7273f50b76352f062c`**（`feat(read)`）增加在线自由只读 TQL。开发分支 `codex/live-read-tql` 仅供追溯。

**已验**：最终全套 **92/92**，p96 **27/27**、p97 **26/26**，bench **148/148**（585／5000 节点各 74 项）；585 节点／1536 维合成库复现 Issue 原样 JOIN，默认 limit=200 返回 12 行，执行器结果 JSON 约 75 KiB（字节预算截断）。干净目录严格安装真实 llm/tools **0.2.1-rc.4**、内核 **0.9.0**，verify-package **13 项**及成品 HTTP/CLI **14 项**通过。

验证专用 tgz：版本 **0.8.8**、**57 文件／291,260 字节**、SHA1 **`32df17c5e094cb92685b5bcd16dd7e8c2268246e`**；它不是 registry 上的 0.8.8，不能原版本重发。**公司待验**：真实 DSH 启动／UI，以及维护者选择未占用 SemVer 后的最终候选提交和 tgz 全流程；本轮未发布 npm。

## 1. 取码与环境

以下为 PowerShell。已有仓库就进入它，从 `git status` 开始；有本地修改先处理归属。

```powershell
$ErrorActionPreference = 'Stop'
function Check-Exit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed: $LASTEXITCODE" } }
git clone https://github.com/QWQcool/dsh-trivium.git
Check-Exit 'clone'
Set-Location -LiteralPath '.\dsh-trivium'
git status --short
git fetch origin --prune --tags
Check-Exit 'fetch'
git switch main
Check-Exit 'switch'
git pull --ff-only origin main
Check-Exit 'pull'
$releaseRepo = (Get-Location).Path
$handoffSha = (git rev-parse origin/main).Trim()
git show -s --format=fuller $handoffSha
git log --oneline aec511e..origin/main
git merge-base --is-ancestor 9d7b96a0eec85e0dc07daa7273f50b76352f062c origin/main
Check-Exit 'feat(read) delivered on main'
```

确认本次功能提交已在 main，且 `lib/live-tql.js`、p97、bench 都存在。Node 要求 `^22.19.0 || >=24`，内核 pin 为 `triviumdb@0.9.0`。记录实际 Node/npm、DSH、llm/tools 版本；历史宿主 `0.2.2-rc.1` 不是公司环境的既定版本。

仓库 `.npmrc` 为 `omit=peer`、`legacy-peer-deps=true`，只用于源码联调。`link-peers.mjs` 默认读用户 profile，**不跟随 DSH_HOME**；显式指定公司的真实 peer scope：

```powershell
node --version
npm --version
npm ci
Check-Exit 'npm ci'
$env:DSH_RELEASE_PEER_SCOPE = Read-Host '真实 profile 中含 dsh-llm/tools 的 @deepseek-ai 目录'
node --input-type=module -e "import {ensurePeers} from './scripts/link-peers.mjs'; const r=ensurePeers({scope:process.env.DSH_RELEASE_PEER_SCOPE}); console.log(r); if(Object.values(r).some(v=>v==='missing'||String(v).startsWith('failed')))process.exit(1)"
Check-Exit 'real peers'
node -e "for(const p of ['triviumdb','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-tools'])console.log(p,require(p+'/package.json').version)"
```

## 2. 选版、文档与回归

按[发布清单](release-checklist.md)执行；上一版来源见 [0.8.8 回执](release-0.8.8.md)。先实时确认目标版本未占用：

```powershell
$publishRegistry = 'https://registry.npmjs.org/'
$candidateVersion = Read-Host '下一 npm 版本号'
$meta = Invoke-RestMethod ('https://registry.npmjs.org/dsh-trivium?check=' + [guid]::NewGuid().ToString('N'))
if ($meta.versions.PSObject.Properties[$candidateVersion]) { throw 'Version already published' }
npm version $candidateVersion --no-git-tag-version
Check-Exit 'version'
```

同步 `package.json/package-lock.json`、README 双语横幅／Release info／变更说明、`docs/README.md`、**`docs/next-memory/CURRENT-STATE.md`**，新增中英 `docs/release-<版本>.md/.en.md`。更新在线 TQL、快照和限制说明；p91 检查的是源码声明一致性，不代表 registry 已发布，发布时刻和 hash 只在核验后补回执。

```powershell
node scripts/run-all.mjs
Check-Exit 'full suite'
node scripts/smoke-p91.mjs
Check-Exit 'version declarations'
New-Item -ItemType Directory -Force -Path '.tmp' | Out-Null
node scripts/bench-live-tql.mjs --sizes 585,5000 --reps 3 --query-timeout-ms 50 --hard-timeout-ms 90000 > .tmp\release-bench.json
Check-Exit 'bench'
$bench = Get-Content -Raw -LiteralPath '.tmp\release-bench.json' | ConvertFrom-Json
$bench.results | Select-Object fixture,ok,outcomes,pagination,boundedPagination
```

bench 不在 npm test 中。5000 节点全库排序分页 6/6 是**预算拒绝**；64 节点工作集分页各 6/6 才是成功。保留 success/budget/deadline/busy/error 分项；baseline 与带查询延迟分别报告，event-loop lag 还含写 flush，不能宣称零阻塞。公司重新记录结果，不把预计组数或历史回归数当本轮通过。

在线 TQL 无节点数门槛；25/50ms 是协作 deadline 加完成检查，不是硬抢占。原生 prepare 确认安全时才用 limit+1／字节预算探针，已有分页或其他语法回退原文；聚合／排序保持完整输入。默认 200、最多 1000 行，16 KiB 入参、512 KiB 响应；必要时如实返回截断或 408／413／422。

## 3. 冻结、审包、干净消费

审阅并提交准确文件后，要求工作树干净，记录候选 SHA。任何修复均重测、重新打包。p91／全套通过后核对 `files/bin/exports/dsh`：`lib/live-tql.js`、读 API／快照模块、`lib/snapshot-query-worker.mjs`、四个 CLI、双语 README、LICENSE、patch 均在包中。审查无真实库／snapshot／设置／token／`.env`／`.npmrc`／`.tmp`／私有资料。

```powershell
git diff --check
Check-Exit 'diff check'
if (git status --porcelain) { throw 'Commit the candidate first' }
$releaseSha = (git rev-parse HEAD).Trim()
$artifacts = Join-Path $releaseRepo '.tmp\npm-release'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
$dry = npm pack --dry-run --json | ConvertFrom-Json
Check-Exit 'pack dry run'
$dry[0].files | Select-Object path,size
$pack = npm pack --json --pack-destination $artifacts | ConvertFrom-Json
Check-Exit 'pack'
$candidateTgz = Join-Path $artifacts $pack[0].filename
if ((Get-FileHash -Algorithm SHA1 -LiteralPath $candidateTgz).Hash.ToLowerInvariant() -ne $pack[0].shasum) { throw 'Tarball hash mismatch' }
$consumer = Join-Path ([IO.Path]::GetTempPath()) ('dsh-consumer-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $consumer | Out-Null
$llmTgz = (Resolve-Path -LiteralPath (Read-Host '匹配宿主的真实 dsh-llm tgz')).Path
$toolsTgz = (Resolve-Path -LiteralPath (Read-Host '匹配宿主的真实 dsh-tools tgz')).Path
Push-Location -LiteralPath $consumer
try {
  npm init -y
  npm install --legacy-peer-deps=false --include=peer --save-exact $candidateTgz $llmTgz $toolsTgz
  Check-Exit 'strict clean install'
} finally { Pop-Location }
node scripts/verify-package.mjs $consumer
Check-Exit 'verify installed package'
$installed = Join-Path $consumer 'node_modules\dsh-trivium'
foreach ($path in ($pack[0].files.path | Where-Object { $_ -ne 'package.json' })) {
  if ((Get-FileHash -LiteralPath (Join-Path $releaseRepo $path)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $installed $path)).Hash) { throw "Source mismatch: $path" }
}
```

真实 peer 产物来自公司受信源／DSH 分发，也可用匹配版本的 registry spec；不能用占位旧包、force 或 legacy-peer-deps 绕过消费验收。另核对包内 package.json 的 version/exports/files/bin/dependencies/peerDependencies/dsh 与候选源一致，逐个运行四个已装 CLI 的 `--help`。`verify-package` 验证工具和 pre-step，新增接口和 UI 仍需真宿主走查。

## 4. 隔离真实 DSH 与功能验收

在**单独测试窗口**填入前述 tgz 的绝对路径和公司 DSH `lib/bin.js`，用完关闭窗口；验证前核对实际 cwd/dbPath，不能只切面板下拉框：

```powershell
$candidateTgz = (Resolve-Path -LiteralPath (Read-Host '已验 tgz 绝对路径')).Path
$hostBin = (Resolve-Path -LiteralPath (Read-Host '真实 DSH lib\bin.js')).Path
$hostRoot = Join-Path ([IO.Path]::GetTempPath()) ('dsh-release-' + [guid]::NewGuid().ToString('N'))
$env:DSH_HOME = Join-Path $hostRoot 'home'
$env:DSH_TRIVIUM_SETTINGS = Join-Path $hostRoot 'trivium.json'
$workspace = Join-Path $hostRoot 'workspace'
New-Item -ItemType Directory -Force -Path $workspace | Out-Null
Set-Location -LiteralPath $workspace
node $hostBin plugin --profile web add $candidateTgz
if ($LASTEXITCODE -ne 0) { throw 'Isolated plugin install failed' }
node $hostBin web --no-open --port 3197
```

按实际宿主 `--help` 调整安装方式／空闲端口，token URL 仅本机使用。`link-dsh.mjs` 是源码 junction，不是候选包验收。检查设置、一次注入、#4 开关；按 [read-api.md](read-api.md) 验证在线 JOIN／参数／聚合／新写入立即可见、写语法拒绝及错误后可继续读写。捕获 snapshot 后继续写：live 看到新事实、旧代际看不到；停宿主后候选包的 query/check `--snapshot` CLI 仍能用。记录 host/peers、加载路径和结果；HTTP bench 不替代真实宿主／模型验收。

## 5. 发布同一个 tgz 与核验回执

后续取得目标版本和发布授权后，使用公司既有 npm 账号／组织、2FA 或 trusted publishing；认证材料不写入命令记录。交互发布示例如下，OIDC 则由现有受信 CI 发布同一已验产物：

```powershell
npm config get registry
npm whoami --registry $publishRegistry
Check-Exit 'npm identity'
npm owner ls dsh-trivium --registry $publishRegistry
npm publish $candidateTgz --dry-run --access public --tag latest --registry $publishRegistry
Check-Exit 'publish dry run'
npm publish $candidateTgz --access public --tag latest --registry $publishRegistry
Check-Exit 'publish'
$remote = Invoke-RestMethod ('https://registry.npmjs.org/dsh-trivium?receipt=' + [guid]::NewGuid().ToString('N'))
$published = $remote.versions.PSObject.Properties[$candidateVersion].Value
if (-not $published -or $remote.'dist-tags'.latest -ne $candidateVersion) { throw 'Registry version/tag not confirmed' }
if ($published.dist.shasum -ne $pack[0].shasum -or $published.dist.integrity -ne $pack[0].integrity) { throw 'Registry tarball differs' }
if ($published.gitHead -and $published.gitHead -ne $releaseSha) { throw 'gitHead mismatch' }
git tag -a "v$candidateVersion" $releaseSha -m "dsh-trivium $candidateVersion"
Check-Exit 'release tag'
git push origin main
Check-Exit 'release source push'
git push origin "v$candidateVersion"
Check-Exit 'release tag push'
git rev-parse "v$candidateVersion^{commit}"
```

若先发 next 或公司流水线需 tag 触发，沿用该机制，回执准确区分 dist-tag。tarball 发布可能没有 gitHead，应记录缺失，并用源树比对、release SHA、tag、tgz integrity/shasum 建立追溯。创建 GitHub Release，中英说明补发布时间、hash、大小／文件数、实际测试与环境；参考 0.8.8 回执。网络失败先查 registry，同版本不能覆盖，已发布 tag 不移动；修复用新版本，调整 dist-tag／deprecate 按明确决定执行。

#5 已在 #6 后按 source-fixed 关闭；本轮是补完整在线 A。源码推送可先说明源码状态，**npm 核验后**再补准确版本和升级命令，不混用两个时点。清理／降级数据库不作为自动回退。

## 6. 后续界面与可复制提示词

先完成发布验收与文档示例。API／CLI 已满足读路径；有实际操作者需求时，再讨论在现有上下文／诊断页加只读查询面板。静态 HTML 详情图可选，依据实际页面和 live／snapshot 两条路径，不列为发版门槛；讨论与实施分开。技术后续看上游独立输出行游标／异步只读查询，以及目标机写并发时的 p95 延迟与预算拒绝率，用数据决定继续投入。

> 我在公司电脑接手 https://github.com/QWQcool/dsh-trivium 。请先读本交接稿、release-checklist.md、read-api.md，定位当前仓库；没有则在我指定位置克隆。保留我的本地修改，fetch/pull 远端 main，核对本次 feat(read) 和最终 SHA，不沿用旧分支或 Administrator 路径。
> 请审查并准备下一 npm 包：记录公司 Node/DSH/peers，跑回归和 bench、核对聚合与预算拒绝，隔离真宿主验收；选未占用版本，同步中英文 README、docs 状态和 release notes/p91；审包、严格 peer 干净安装、核对 tgz 与来源。发布授权或目标版本尚未明确时，先完成具体候选包再确认；已有授权不重复询问。按公司现有认证机制发布同一已验 tgz，核对 registry/tag/Release 并补实际回执和 issue 状态。
> 完成后与我讨论后续计划：API/CLI 是否足够，是否需要在现有页面加只读查询面板或做静态 HTML 详图；上游独立输出行游标／异步只读查询是否可用，目标机并发写入时的 p95 与预算拒绝率是否值得继续优化。先给小范围方案；讨论不等于开始 UI/HTML 实施。
