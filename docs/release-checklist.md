# 发布检查清单

> 状态提示（2026-11-16）：以下保留原日期的发布/测量记录；文中的“当前、下一步”和旧脚本文件名按当时理解。现状见 [CURRENT-STATE](CURRENT-STATE.md)，当前运行方法见 [DEVELOPMENT](DEVELOPMENT.md)。

当前基线见 [文档入口](README.md)。本清单用于已经获用户授权的发布任务；日常文档整理、审查和本地修复不自动授权 npm 发布、推送或 issue 留言。

每次发 npm 包按顺序执行。目的是避免 0.5.1 那次「README 里写着旧版本号、体检脚本没进包」的问题。

## 2026-11-17 发布准备结论

**现有内容足够组成发布候选**。建议先 `0.9.0-rc.1`、dist-tag `next`，再发稳定版 `0.9.0`。本轮仅完成源码推送与本地正式插件更新，没有发布 npm、移动 tag 或自动合并 main。功能提交为 `10e09ac`；[正式更新和数据保留回执](reviews/DESKTOP-QUALITY-UPDATE-2026-11-17.json)。

- 发布重点：默认保留卸载数据、记忆回显/同轮重复防护、无来源候选及人工核对、实体检索/显式记忆包、TDB 0.9.1 和已实现的写入优化。无需等 Super Agent 或全部跨语言检索工作完成。
- 已验证：本机完整回归 93/93；正式安装前后 39 文件、3 数据库不变；实际 Electron 宿主可读原工作区 4 节点；项目目录外干净 npm 安装后 13 项成品检查通过。测试和付费桥接不进入 npm 包。
- registry 当前 `latest` 仍为 0.8.9 / TDB 0.9.0，含旧 `preuninstall`。新版本应写清安全升级方式：停止宿主、直接添加新包，不先卸载旧包；确认官方 CLI 的 `--ignore-scripts` 用法。TDB 升级可能推进整组文件格式，须说明旧内核不能直接降级及完整文件组要求。
- 发布前仍需：确定合入主线的源码；同步 package/lock、双语说明及用户版本声明；在文档检查中区分 `latest` 与 `next`；对**新版本号**重做打包、干净消费和升级验证。已有验证覆盖本机 Windows/Node 24，补充所声明支持的 Node/平台验证后再扩大稳定版承诺。
- 已确认 npm 登录身份为 `qwqcool`，没有读取 token；实际发布认证在发布执行时验证。版本号不能重用，规则见 [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。
- 记忆包仍显式启用、默认 0。真实对照为旧通道 12/12、记忆包 10/12；发布说明不应宣称它普遍提质降费。金额账单未测，完整 Agent 多轮与多模型泛化仍未验证。

## 1. 冻结范围

- [ ] 本轮必须修复的缺陷及验收项已满足交付门槛（issue 的最终关闭在发布验证后处理），没有「顺手再加一个」。
- [ ] 发布源码已提交、`git status` 干净；没有把 `.tmp/`、测试库、`*.tdb` 带进提交。
- [ ] `docs/release-<version>.md` 已写清变更、升级方式、旧数据处理、已知限制。

## 2. 版本与文档（打包前全部完成）

- [ ] `npm version <x.y.z> --no-git-tag-version`，确认 `package.json` 与 `package-lock.json` 同步。
- [ ] **四处版本声明一起改**（之前每次都漏一处）：`README.md` 横幅 + Release info、`README.zh-CN.md` 横幅 + 发布信息、
  `docs/README.md` 发布状态表（含 tag）、`docs/CURRENT-STATE.md` 的 `latest`。
- [ ] `README.md` / `README.zh-CN.md`：
  - [ ] `## Release info` / `## 发布信息` 的包版本是新版本。
  - [ ] 更新说明（Changelog）顶部有新版本条目。
  - [ ] 新增的命令、参数、支持范围已经写进正文或排障章节。
- [ ] `docs/release-<version>.md`（和 `.en.md`，如果上一版有英文）写成**回执**而不是计划：不出现"待发布/尚未发布"。
- [ ] `docs/README.md`、`docs/CURRENT-STATE.md` 和 `PLAN.md` 的内核／宿主与实际依赖一致；更新 ROADMAP 的完成状态，历史结果保留原测量日期。
- [ ] **`node scripts/smoke-p91.mjs` 必须通过**——它就是上面这些声明的自动检查，版本没同步会直接失败。
- [ ] 确认 `package.json` 的 `files` 覆盖所有**文档承诺随包分发**的文件（尤其 `scripts/` 与 `bin` 目标）。
- [ ] `bin` 目标带 shebang，`node <script> --help` 能跑。

## 3. 回归

- [ ] `npm test`：所有逻辑用例通过；集合文件数不代表覆盖数，用 `npm run test:list` 核对。
- [ ] 发布相关专项：打包脚本/P22、issue 回归（p15）。
- [ ] `npm pack --dry-run` 文件清单人工过一遍：版本号、文件数、`README`、`LICENSE`、`bin` 目标都在。
- [ ] 独立消费目录 `npm install <tgz> <真实 peers>` → `node scripts/verify-package.mjs <dir>`；不允许 `--force` / `--legacy-peer-deps`。
- [ ] 真实宿主走查（启动一个隔离 `DSH_HOME`）：
  - [ ] 设置页出现「Trivium 记忆」，节点数与短地图正常。
  - [ ] 设置开关能保存并影响下一轮 pre-step。
  - [ ] 如果本轮改了 UI/CLI：对应入口实际点过/跑过。
  - [ ] 如果是正确性版本：至少一条注入链路与一条冲突/失败链路。

## 4. 打包与发布

- [ ] `npm whoami` 确认为预期账号 `QWQcool`；不读取、打印、复制或提交用户级 `~/.npmrc` 中的 token。
- [ ] `npm publish --dry-run`，核对 tarball 文件名、大小、文件数与 shasum。
- [ ] `npm publish --access public`（或按需 `--tag next`）。
- [ ] 等 registry 处理完成后用 **HTTP 直查** 验证（`npm view` 可能被本地缓存拖住）：

  ```powershell
  $meta = Invoke-RestMethod ("https://registry.npmjs.org/dsh-trivium?x=" + [guid]::NewGuid().ToString("N"))
  $meta.'dist-tags'
  $meta.time.'<x.y.z>'
  $meta.versions.'<x.y.z>'.dist
  ```

- [ ] `git tag v<x.y.z>`，`git push origin main`，`git push origin v<x.y.z>`。
- [ ] 在 `docs/release-<version>.md` 补发布时刻与 tarball shasum，单独提交并推送。

## 5. 发布后

- [ ] 如果上一个版本有已知严重问题，评估 `npm deprecate dsh-trivium@<old> "<message>"`（需要明确决定，不自动做）。
- [ ] 相关 issue 回复准确版本号、升级命令、旧数据处理方式；确认发布产物后再关闭。
- [ ] 已发布 tag 不移动、不覆盖；需要修复就发新 patch。
