# 发布检查清单

每次发 npm 包按顺序执行。目的是避免 0.5.1 那次「README 里写着旧版本号、体检脚本没进包」的问题。

## 1. 冻结范围

- [ ] 本轮该修的 issue / 验收项已关闭，没有「顺手再加一个」。
- [ ] `git status` 干净；没有把 `.tmp/`、测试库、`*.tdb` 带进提交。
- [ ] `docs/release-<version>.md` 已写清变更、升级方式、旧数据处理、已知限制。

## 2. 版本与文档（打包前全部完成）

- [ ] `npm version <x.y.z> --no-git-tag-version`，确认 `package.json` 与 `package-lock.json` 同步。
- [ ] `README.md` / `README.zh-CN.md`：
  - [ ] `## Release info` / `## 发布信息` 的包版本是新版本。
  - [ ] 更新说明（Changelog）顶部有新版本条目。
  - [ ] 新增的命令、参数、支持范围已经写进正文或排障章节。
- [ ] `PLAN.md` 的内核版本、宿主版本与实际依赖一致。
- [ ] 确认 `package.json` 的 `files` 覆盖所有**文档承诺随包分发**的文件（尤其 `scripts/` 与 `bin` 目标）。
- [ ] `bin` 目标带 shebang，`node <script> --help` 能跑。

## 3. 回归

- [ ] `npm test`：所有脚本通过（当前 23 组）。
- [ ] 发布相关专项：打包脚本/P22、issue 回归（p15）。
- [ ] `npm pack --dry-run` 文件清单人工过一遍：版本号、文件数、`README`、`LICENSE`、`bin` 目标都在。
- [ ] 独立消费目录 `npm install <tgz> <真实 peers>` → `node scripts/verify-package.mjs <dir>`；不允许 `--force` / `--legacy-peer-deps`。
- [ ] 真实宿主走查（启动一个隔离 `DSH_HOME`）：
  - [ ] 设置页出现「Trivium 记忆」，节点数与短地图正常。
  - [ ] 设置开关能保存并影响下一轮 pre-step。
  - [ ] 如果本轮改了 UI/CLI：对应入口实际点过/跑过。
  - [ ] 如果是正确性版本：至少一条注入链路与一条冲突/失败链路。

## 4. 打包与发布

- [ ] `npm whoami` 确认登录（token 只放在用户级 `~/.npmrc`，不进仓库）。
- [ ] `npm publish --dry-run`，核对 tarball 文件名、大小、文件数与 shasum。
- [ ] `npm publish --access public`（或按需 `--tag next`）。
- [ ] 等 registry 处理完成后用 **HTTP 直查** 验证（`npm view` 可能被本地缓存拖住）：

  ```powershell
  $meta = Invoke-RestMethod https://registry.npmjs.org/dsh-trivium
  $meta.'dist-tags'
  $meta.versions.'<x.y.z>'.dist
  ```

- [ ] `git tag v<x.y.z>`，`git push origin main`，`git push origin v<x.y.z>`。
- [ ] 在 `docs/release-<version>.md` 补发布时刻与 tarball shasum，单独提交并推送。

## 5. 发布后

- [ ] 如果上一个版本有已知严重问题，评估 `npm deprecate dsh-trivium@<old> "<message>"`（需要明确决定，不自动做）。
- [ ] 相关 issue 回复准确版本号、升级命令、旧数据处理方式；确认发布产物后再关闭。
- [ ] 已发布 tag 不移动、不覆盖；需要修复就发新 patch。
