# 批量写入：导入路径（2026-11-03）

基线 `main` @ `fdde4f0`。零模型调用、零费用。

## 修前

`applyCandidates` 每写一条事实就 `db.flush()` 一次（本机实测约 **91 ms/次**）。
外部导入（WorkBuddy / Claude Code / Codex 的 `MEMORY.md`、`CLAUDE.md`、`AGENTS.md`）一次会写十几到二十几条，
而每一次都要单独落盘 —— 用户能直接感觉到的等待。

实测（同一台机器、`applyCandidates` 直调，22 条实际写入）：

```
before  2020 ms   flushes=47   written=22
```

47 次 flush 多于 22 条事实，因为合并（merge）本身也落盘。

## 修后

`lib/markdown.js` 的 `importExternal` 与 `lib/pins.js` 的 `addChipsFromText` 把写入包进
`runDeferredWrites(db, …)`，并在 `finally` 里 `flushWorkspaceDb(db)`：

```
after    110 ms   flushes= 2   written=22
speedup: 18.4x
```

**为什么 flush 放在 `finally`**：批窗口内如果第 5 条抛错，前 4 条已经写进引擎了；
不 flush 就等于把它们丢在内存里。放在 `finally` 让"已经发生的写"保持与旧行为一致的持久性。

## 验收

```
node scripts/smoke-p83.mjs   → 12/12（新增）
node scripts/run-all.mjs     → 84/84（改前 83/83）
```

p83 覆盖：

| 断言 | 说明 |
|---|---|
| 12 行 `CLAUDE.md` 导入报成功、写入 ≥8 条 | 真实 `importExternal` 路径 |
| 整次导入 flush ≤3，且 **flush 数 < 事实数** | 批处理生效，且不随条数线性增长 |
| 重复导入不新增节点、flush 仍 ≤3 | 合并也在同一批里 |
| 芯片粘贴仍然"一份正文 = 一条事实"，pin 同批写入 | 保持既有语义 |
| 批内抛错后，**抛错前写入的事实仍在库里** | finally flush 的语义 |

## 未覆盖 / 已知边界

1. **芯片粘贴不按行拆分**：`splitChipDraft` 返回整段正文，所以"粘贴 20 行"本来就只有 1 条事实；
   这次给它加批处理只是让"事实 + pin"共用一次 flush，不是加速大输入。
2. **导入有 24 条上限**（`MAX_WRITE_ITEMS`）：实测 100 行只写入 22 条，这是既有规则，不是本次回归。
3. **`distill` 没包**：一次抽取通常 1–2 条，省 1 次 flush（约 91 ms）意义不大，保持原样以免影响热路径语义。
4. **JSON 导入（`importGraph`）本来就是单事务**，不需要改。
5. **没有测真机导入**：以上是离线计时，宿主里还要叠加文件读取与 HTTP 往返。
6. **批窗口仍然只在同步直线内安全**：任何在批内 `await` 的调用方都可能看到未落盘的写。
