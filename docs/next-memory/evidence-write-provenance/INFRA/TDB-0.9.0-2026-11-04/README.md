# 内核适配：triviumdb 0.9.0-beta.3 → 0.9.0（2026-11-04）

pin 从 `0.9.0-beta.3` 升到 `0.9.0`（正式版）。全量 **86/86**，改前在 0.9.0 下是 **30/86**。

## 三段

### ① 类型化 payload 拒绝 `undefined`

0.9.0 的存储层会直接拒绝：

```
undefined cannot be represented as a serde_json::Value
```

beta.3 是**静默丢弃**这些键。我们的 payload 全部由"展开可选字段"构造（`fail`/`until`/`aliases`/`source.kind`…），
逐处修调用点会漏：只修 `insertNode` 是 65/86。

改法：**在引擎边界兜住**。`store.js` 的 `hardenEngine` 按 `triviumdb.d.ts` 的写面包一层
`pruneForStorage`（深层丢弃 `undefined`/函数/symbol）：

```
insert / insertWithId / updatePayload / updateEdge / commitTransaction
```

效果：65/86 → 80/86。

### ② 导入事务是第五条写路

剩下 6 个失败里，`p5`「re-import merges by uri」暴露了真正的原因。连两次同一个 graph：

```
first  { ok:true, created:1, merged:0 }
second { ok:false, code:"TRANSACTION_FAILED",
         message:"导入事务失败，未写入任何内容：undefined cannot be represented as a serde_json::Value" }
```

`importGraph` 走的是 `db.commitTransaction(ops)`，ops 数组里的 payload 同样带 `undefined`。
把 `commitTransaction` 加进写面后 80/86 → **86/86**。

### ③ `npm install` 会删掉 peer 包

`@deepseek-ai/dsh-llm` / `dsh-tools` 是 peer，registry 上只有 `0.0.1-rc.1`（不满足 peer 范围），
只能用宿主 profile 里那份。任何一次 `npm install` 都会删掉本地副本，让 17 个脚本
`ERR_MODULE_NOT_FOUND`，而且报错里看不出是这个原因。

新增 `scripts/link-peers.mjs`，并在 `run-all.mjs` 启动时调用：缺了就重建 junction，缺不到就警告。

## 性能对比（同一台机器，单次运行）

| 指标 | beta.3 | 0.9.0 |
|---|---|---|
| 单条 `insertNode`（20 条均值） | 188 ms | **155.5 ms** |
| 单次 `db.flush()`（20 次均值） | 91 ms | **73.7 ms** |
| Router 队列 10 Worker × 50 写 p95 | 206 ms | **483 ms** |
| 同上吞吐 | 1462 /s | **559 /s** |

单写更快，**批量路径更慢**（p95 2.3×，吞吐 1/2.6）。500 条仍然全部落库、0 丢写，
559/s 也远高于批处理之前的 5/s；但如果以后把批窗口调大，需要重测这条。

## 阶段 2、3 的结论

- **阶段 2（句柄与租约）**：`closeAll()` 再 `open` 的四处（bench、p85、router close、p84 收尾）在 0.9.0 下全部通过，
  没有额外的代码改动需要。
- **阶段 3（只读并发）**：p84 里三个 Worker 仍然全部 `via: "router"` —— **0.9.0 没有解锁"另一个进程只读打开"**，
  所以 `readInheritedMap` 的 Router 回退必须保留。

## 未覆盖

1. **老库文件兼容性没有单独验**：只在测试用的临时库上跑过，没有拿真实工作区的历史 `.tdb` 做升级验证。
2. **Windows 打开竞态**（0.9.0 release notes 里修的）：没有专门复现，只是全量套件不再撞到。
3. **性能是单次运行**，没有多轮取中位数。
4. **`hardenEngine` 是兜底而不是清理**：调用点仍然在传 `undefined`，等 pin 稳定后应逐步收敛到构造处。
