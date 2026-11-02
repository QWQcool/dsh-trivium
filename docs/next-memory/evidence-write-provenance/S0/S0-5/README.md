# S0-5 证据：作用域抽象（阶段 0 铺路）

基线：S0-4 之后（`fd99a7d`）。零模型调用、零费用。

## 修前

- 记忆边界硬编码在 `cwd`：`dbPathFor(cwd) = <cwd>/.dsh/trivium.tdb`，`openWorkspaceDb(cwd)` 只吃一个位置参数。
- 没有"作用域"这个词。等到 Super-agent 每个 work item 一个目录时，"读上级库"这件事会散落在
  `store`、`server`、`tools` 三处各自实现——改动点无法收敛。

## 修后

`lib/store.js` 新增一层解析，**只加参数、不改行为**：

| 名字 | 语义 | 本阶段状态 |
|---|---|---|
| `workspace`（默认） | 当前目录的库 | **完全实现**，`path = <cwd>/.dsh/trivium.tdb`（与 0.8.3 逐字节相同） |
| `parent` | 上一层目录的库 | 只解析成描述（`parentCwd = dirname(cwd)`，`path = null`，`implemented:false`），取路径/开库抛 `SCOPE_NOT_IMPLEMENTED` |
| `inherit` | 上级只读 + 写回上级 | 同 `parent`，留给阶段 1 |

接口：

- `SCOPES` / `scopeOf(options)`（接受 `{scope}` 或裸字符串）/ `resolveScope(cwd, scope)` / `scopeNotImplemented(resolved)`
- `dbPathFor(cwd, scope = "workspace")`
- `openWorkspaceDb(cwd, options = {})`、`openWorkspaceDbReadOnly(cwd, options = {})`

为什么 `parent` / `inherit` 选择"抛错"而不是"退化为 workspace"：退化会让阶段 1 的调用方在写错库时毫无症状，
而错误一旦落到别人的仓库级记忆里就收不回来。现在抛错，代价是一次显式的测试失败。

`resolveScope` 对未知名字抛 `UNKNOWN_SCOPE`（拼写错误不是一种作用域），并且**在创建任何目录之前**抛——
p77 断言被拒绝的 `openWorkspaceDb(cwd, {scope:"parent"})` 没有顺手建出 `.dsh/`。

## 命令与输出摘要

```
node scripts/smoke-p77.mjs   → P77: 20/20
node scripts/run-all.mjs     → 78/78 passed（S0-4 后 77/77）
```

对照验收：

| 要求 | 实测 |
|---|---|
| 三种 scope 可解析 | `workspace` → `implemented:true` + 真实路径；`parent` / `inherit` → `implemented:false` + `parentCwd=dirname(cwd)`；大小写不敏感；空串回落 `workspace` |
| 默认路径零变化 | `dbPathFor(cwd)` 与 `dbPathFor(cwd,"workspace")` 都等于 `join(resolve(cwd), ".dsh", "trivium.tdb")`；开库后 `listOpenWorkspaces()[0].path` 与之一致 |
| 默认落库位置不变 | 默认开库写入一条事实后，`<cwd>/.dsh/trivium.tdb` 存在，节点数 1；同一工作区重复打开仍是同一条记录 |
| 未实现的作用域有明确分支 | `dbPathFor` / `openWorkspaceDb` / `openWorkspaceDbReadOnly` 三条路径都抛 `SCOPE_NOT_IMPLEMENTED`（`err.scope` 带上名字）；`{scope}` 与裸字符串两种写法都覆盖 |
| 拼写错误不等于作用域 | `resolveScope(cwd,"sibling")` → `UNKNOWN_SCOPE` |
| 全量绿 | 78/78，既有 77 个脚本零改动 |

## 未覆盖 / 已知边界

1. **没有继承语义**：`parent` / `inherit` 不读、不写、不建目录。本阶段只保证"调用点收敛到 `resolveScope` 一处"。
2. **没有调用方真正传 scope**：`tools.js`（四工具）、`server.js`、`index.js` 仍走默认值。这是有意的——本阶段的要求是默认行为零变化。
3. **usage 旁路还没跟着 scope 走**：`lib/usage.js` 仍以 `cwd` 定位热度文件。等 `parent`/`inherit` 落地时需要一起决定热度是"本地"还是"跟随记忆库"，现在先不预判。
4. **`ensureWorkspaceRoot` 里的 workspace 节点名仍用调用方传入的 `cwd` 原值**（可能是相对路径），与 0.8.3 一致；改成绝对路径会改变已有库里的显示名，不在本阶段范围。
