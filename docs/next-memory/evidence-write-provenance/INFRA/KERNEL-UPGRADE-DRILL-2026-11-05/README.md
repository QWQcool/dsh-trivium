# 内核升级演练：升级可以，降级不行（2026-11-05）

外部评审 F5 的发布门禁：0.9.0 直接作用于已有库，而此前只在临时库上跑过。
复现：`node scripts/verify-kernel-upgrade.mjs <含 trivium.tdb* 的目录> [--probe]`。零模型费用。

## 演练对象

仓库工作区 `.dsh/`：**10 个文件的库文件组**（`trivium.tdb` + `.gidx` `.pidx` `.pld.120` `.text`
`.text.meta` `.vec` `.wal` `.lock` `.flush_ok`），16 个节点 / 17 条边，由 `0.9.0-beta.3` 写入。

## 结果一：升级路径通过

```
open-historic        { nodes: 16, edges: 17 }        ← 历史库直接打开
read-sample          [{ id: 8, text: "演示口令…" }]   ← 历史正文可读
write                32
reopen               { nodes: 17, edges: 18 }        ← 重开后新节点在
kept-historic-nodes  true
restore              { nodes: 17, edges: 18 }        ← 整组备份恢复成功
restore-dropped-the-later-write  true
ok                   true
```

## 结果二：**降级不可行**

用 `0.9.0` 写过的库，再用 `0.9.0-beta.3` 打开：

```
kernel: 0.9.0-beta.3
ok: false
error: TDB_UNSUPPORTED_DATABASE_VERSION: 不支持的数据库文件版本：发现 v10，
       当前可读取 v5..=v9；v5 对应 TriviumDB 0.7.x/0.8.x
```

**0.9.0 把库文件版本升到了 v10，旧内核读不了。** 也就是说：

- 升级到 0.8.5 之后，**不能靠降级插件回退**；唯一的回退方式是恢复升级前的备份；
- 备份必须是**整个文件组**（只复制 `trivium.tdb` 会得到 `TDB_CORRUPTED_FILE: checkpoint vector file is missing`，
  这是本次演练第一版脚本踩到的真实错误）。

## 两条必须进入发布说明的结论

1. **升级前先备份整个 `.dsh` 目录**（插件关闭状态下），否则无法回退；
2. **回退 = 恢复备份**，不是 `npm i dsh-trivium@0.8.4`。

## 未覆盖

1. 只演练了仓库这一个库；没有覆盖更大的库与带 `history` 的节点族。
2 . 没有做"恢复到另一台机器"的演练（路径不同、锁文件残留）。
3. 没有验证 `0.9.0` 写入的 `.wal` 在异常中断后的恢复（正常关闭路径已通过）。
4. 旧内核版本号只测了 `0.9.0-beta.3`；更早的 `0.8.11`（Administrator 机）未测，按内核自述它支持 v5，大概率同样读不了 v10。
