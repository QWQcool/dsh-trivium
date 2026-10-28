# R7 验收记录（0.6.0，2026-10-28）

环境：DSH `0.2.1-rc.4` Web（隔离 `DSH_HOME`，端口 3093）/ 内核 `triviumdb@0.9.0-beta.3` / 插件 0.6.0 源码。

## A1 随包分发的维护命令

- `package.json` 新增 `bin`：`dsh-trivium-check`、`dsh-trivium-clear-until`；`files` 纳入两个脚本。
- `npm pack`：37 个文件（0.5.1 为 35）。
- 干净消费目录安装 tarball（`--omit=peer`）后 `node_modules/.bin` 出现三平台 shim；实跑：

```json
{ "ok": true, "nodes": 2, "edges": 0, "issues": [] }
```

```json
{ "applied": false, "staleDecisions": 0, "cleared": [], "rows": [] }
```

- `verify-package` 13 项仍通过（真实 `dsh-llm/dsh-tools 0.2.1-rc.4`）。

## B1 真实双窗口

两个真实标签页，同一浏览器会话：

1. 两页读同一节点 ETag `c318fd6b392317b7`。
2. 窗口 A 改正文，ETag 变为 `3dfde7ab6165381b`。
3. 窗口 B 用旧 ETag 提交替代：

```json
{ "status": 409, "code": "etag", "message": "旧决策已在别处变更，请刷新后再确认。" }
```

4. 窗口 B 重新读取 ETag 后重试：`{ "status": 200, "ok": true }`，节点进入 `superseded`。

## B2 轮标识（真实会话日志）

宿主写入的 `session.v4.jsonl.zstd` 是多帧 zstd；逐帧解码后：

- `agent/inbox/spliced` 与 `user/message` 里的同一条用户消息都带
  `id: "0a6deb10-e941-491e-bdd7-d86060ea7946"`。
- 因此 `turnKeyOf` 取 `uid:0a6deb10-…`，不依赖对象身份回退；多步工具循环不会因消息对象重建而重置预算。
- 该轮 `preStep.count = 3`，最后一步计划 `tokens: 0`（内容已在前一步送达）。

## C2 旧期限清理

`smoke-p22` 覆盖：

- 正文含 `2020-01-01` 且 `until=2020-01-01` 的旧决策：dry-run 标记 `textMentionsUntil=true`，`--apply` 清除；
- 正文不含日期、期限显式填写的过期决策：`--apply` 不动，`--apply --all` 才清；
- 未来期限与无期限节点保持不变；
- 清理后重开仍是空期限。

## 回归

- `npm test`：**23/23**（新增 `smoke-p22`，25 条断言）。
- `smoke-p21` 89 条、`smoke-p15` 48 条不变。
- 真机设置页/召回无回归。

## 未覆盖

- 两个**不同浏览器进程**（而非同一浏览器两个标签页）的竞争；当前证据已覆盖独立页面上下文与真实服务端队列。
- 390px 仍不支持（既定范围）。
- 多进程写同一 `.tdb` 仍不支持。
