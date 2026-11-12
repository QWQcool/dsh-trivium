# 本地 embedding 与只读查询验收

2026-11-12。基于 `3edc7fa` 后的本次源码改动；npm 包仍为 **0.8.9**，本报告中的新查询卡片、向量修复和批量回填尚未发布。未修改 TDB 0.9.0、默认查询预算、召回排序或身份合并阈值。费用 **¥0**，没有付费模型生成调用。

## 本地模型实测

环境：Node 24.15.0、npm 11.12.1、Windows、RTX 3080 10GB、Ollama 0.40.16。实际下载 `rjmalagon/gte-qwen2-1.5b-instruct-embed-f16`，权重 SHA-256 为 `224550f5a5221748d8d1af5aa5a1aad3510d26f20beb8dec918dab67510c075e`。

原始模型在 Ollama 的 11434 端点报 `This server does not support embeddings. Start it with --embeddings`。下载的 GGUF 声明 1536 维，但缺少 pooling 元数据；增加 CAPABILITY 的试验别名也未解决。因此本轮使用 **Ollama 已安装的 llama-server**、同一份原始权重，在独立的 loopback 11435 端口启用 embedding、last pooling、非因果 attention 和 CUDA。没有另装推理工具链或修改原模型文件。这是同权重的本地真实推理，不能表述成原始 Ollama `/v1/embeddings` 已可直接使用。

[官方模型卡](https://huggingface.co/Alibaba-NLP/gte-Qwen2-1.5B-instruct)规定查询加任务指令、正文不加，并使用末 token 池化。插件增加可选 `embeddingQueryPrefix`；本轮前缀见 JSON 证据。模型公开评测不代替以下插件实测。

### 检索质量

固定 [36 条合成项目记忆、32 个问题](../../scripts/fixtures/local-embedding-corpus.json)，包含中文、英文、跨语言改写、标识符、数值与否定。人工预先标注相关文档；Top-K 命中指前 K 条包含至少一个相关文档。相同存储、相同插件排序和关键词退化路径，只切换查询向量；没有按结果调整权重或阈值。

| 方案 | Top-1 命中 | Top-5 命中 |
|---|---|---|
| 关键词 + 图，关闭向量 | 22/32 | 25/32 |
| 插件混合检索，原始问题向量 | 26/32 | 30/32 |
| 插件混合检索，带查询指令 | **27/32** | **31/32** |
| 纯向量，带查询指令（诊断） | 23/32 | 32/32 |

本样本支持“本地模型有召回价值”，不支持真实会话准确率、回答质量或优于其它模型的排名结论。混合检索仍会把“存储位置”问题的工作区隔离事实排在前面；768 维契约问题的正确文档未进混合 Top-5，纯向量则能召回。三条无答案问题也会得到最近邻，不能把有相似结果当作有答案。

身份语料另作诊断：同事实对 cosine 范围约 **0.886–0.992**，不同事实对约 **0.820–0.994**。数值变更与否定也可能极相似，区间明显重叠。本轮没有启用语义合并；`sameFact` 阈值保持原值。

### 5000 条回填与持久性

5000 条业务记忆为吞吐用合成数据，与质量小语料分开。完成的一轮共 **5148 次**本地 embedding HTTP 请求、174714 个报告的输入 token，错误维度/非法向量 0。HTTP 计时包含连接/服务响应，回填统计在响应体解析前结束；不把它当成纯 GPU 内核耗时。

| 项 | 实测 |
|---|---|
| 成功 / 失败 / 跳过 | **5000 / 0 / 0** |
| 回填总耗时 / 吞吐 | 117.692s / 42.48 条/s |
| 向量写入 / flush | 5000 / **313** |
| HTTP p50 / p95 | 12.69 / 14.90ms |
| 单次 flush p50 / p95 | 138.13 / 401.27ms |
| 新进程只读重开 | 5000 条全部为有限、非零的 1536 维向量；范数约 1 |

之前两次运行被执行会话中断，未完成，未计入成功回填或耗时；小语料结果一致。全部调用都在本地，费用仍为 0。完整结果、重开核对与控制实验见[证据目录](evidence-local-embedding-read-2026-11-12/)；不提交原始向量库。

另用缓存的真实向量，复制相同的 5000 条业务节点库，交替顺序做 3 轮、每轮更新 128 条，隔离掉 HTTP 和推理：

| 128 条更新 | 旧方式：每条读取整节点并 flush | 新方式：payload 读取、16 条一批 |
|---|---|---|
| 三轮总耗时中位数 | 17.466s | **0.920s** |
| 每轮 flush | 128 | **8** |

中位总耗时降低约 94.7%。这是 128 条缓存向量更新的控制实验，**没有测旧路径完整 5000 条网络回填**。批处理减少 flush 次数，不能消除单次同步 flush 尖峰（F-LAT-01）。

## 插件改动

- 拒绝错误维度、非数值、非有限值与全零向量，失败回退关键词检索，停止静默补齐/截断（F-EMB-01）。
- 回写前校验同一请求任务、当前正文、创建时间和 embedding 配置版本；删除、关闭、旧模型响应失效。复用工作区队列和跨进程锁；网络等待在锁外（F-EMB-02）。
- 只回填未归档的业务类型，排除 workspace/episode；每 16 条一次 flush，并报告成功、失败、已变更跳过。显式空密钥可关闭环境变量继承，供无 key 的本地端点使用。
- 新增 `currentFacts`，复用现有当前版本/期限语义；live 与 snapshot 共用选择器。`getPayload` 避免搬运向量；`reachableDetailed` 限制一跳遍历。5000 节点库中的小邻域和少量实体不再因全库节点数被一概拒绝，工作预算保持。
- 「上下文 → 事实查询」提供三类查询、精确名/类型/关系方向/标签条件、来源切换、显式快照捕获、条数/截断和错误；迟到响应不能带回另一工作区数据。详情为只读摘要。

## 验收与复现

离线全量：`node scripts/run-all.mjs` → **85/85**。原 p98 四项归属检查并入 p89，并补查询响应的工作区隔离检查；断言保留，测试文件数由 86 变 85。`scripts/*.mjs` 仍为 **120**。没有新增 UI/UX 测试，没有扩充冻结的 p13/p24/p26/p78。

`npm pack --dry-run --json` → 57 文件，新查询 worker 在包内；版本保持 0.8.9，未生成新发行或发布。实验结束后隔离宿主和 embedding 运行器已停止，试验别名已移除，下载的原始模型保留。隔离 home 中凭据文件为 0，真实用户 `memory.db` mtime 与实验前基线一致。

- p5：向量形状、HTTP 降级、指令仅用于查询、空 key、乱序/删除/配置切换/关闭、锁冲突、34 条 3 次 flush、重开持久性。
- p93（含合并用例）：当前/历史/归档/过期/提案与坏链、5000 节点局部读、预算拒绝、具名快照与捕获时间、完整孤立检查、既有 TQL/CLI/快照安全契约。
- 真实 DSH 0.2.2-rc.1：1440px 与 760px 下三类 live 查询均 200，当前事实返回 50 条且明确截断；快照孤立实体结果 200 且捕获时间一致；非法 limit 为 400；大范围具名查询为 422 并显示中文预算说明。两种窗口均无 pageerror。通过实际浏览器操作和截图核对，未新增布局测试。
- 真实设置页保存查询前缀后刷新读回一致；独立小库回填 7 条可用业务节点，200 / failed=0 / skipped=0；live TQL 读回实际 1536 维向量。真实用户记忆库未用于本轮实验。

可选真实 embedding 实验，不属于离线回归：

```powershell
node scripts/verify-local-embedding.mjs --url http://127.0.0.1:11435/v1/embeddings --model gte-local --output .tmp/embedding-run --budget 0 --nodes 5000
node scripts/verify-local-embedding.mjs --compare-workspace .tmp/embedding-run/bulk --writes 128 --output .tmp/write-comparison --budget 0
```

脚本只接受 loopback HTTP、预算 0、新输出目录；在隔离 home/库中运行。后一个命令不发 HTTP，只比较缓存向量写入。

本机同权重运行器的启动方法（在单独 PowerShell 窗口执行，验证后可退出）：

```powershell
$localModel = 'rjmalagon/gte-qwen2-1.5b-instruct-embed-f16'
$modelFile = ((ollama show $localModel --modelfile | Select-String '^FROM ').Line -replace '^FROM ', '').Trim('"')
$runnerDir = Join-Path $env:LOCALAPPDATA 'Programs/Ollama/lib/ollama'
$env:GGML_BACKEND_PATH = Join-Path $runnerDir 'cuda_v12/ggml-cuda.dll'
$env:PATH = "$(Join-Path $runnerDir 'cuda_v12');$runnerDir;$env:PATH"
& (Join-Path $runnerDir 'llama-server.exe') -m $modelFile --embeddings --pooling last --override-kv qwen2.attention.causal=bool:false --ctx-size 4096 --batch-size 512 --ubatch-size 512 --gpu-layers 99 --host 127.0.0.1 --port 11435
```

设置页填 11435 的 `/v1/embeddings`、模型 `gte-local`，无 key。查询前缀填 JSON 证据中的两行指令。更换模型后重新回填；同维度不代表不同模型的向量空间兼容。`embeddingReady` 仍是配置状态，界面已改称“连接已配置（需回填验证）”。

## 剩余事项

- **F-EMB-03**：原始 Ollama 模型包在 11434 的 embedding 加载尚未修复；本轮证明的是同权重显式运行器路径。自动化常驻与模型包修订另议。
- **F-EMB-04**：小样本仍有误召回、无答案也返回邻居；需要用户场景语料再决定排序改法。自动合并继续关闭。

  后续已复现 Top-5 的唯一漏题：纯向量第 1，在当前加权 RRF 下被文本通道通用词命中压到第 19。扩大候选池仍不进 Top-5；关闭文本通道也有 Top-1 退步。详见[归因与对照评测](F-EMB-04-ATTRIBUTION-2026-11-12.md)。排序尚未修改。
- **F-LAT-01**：单次同步 flush 尖峰仍在；本轮只减少调用次数，没有改内核或预算。
- **F-READ-01**：大量实体的完整孤立检查仍可能超预算；快照沿用同一预算，不承诺任意大库查询成功。分页扫描协议和上游异步查询/游标留待实际使用反馈。

源码实现、隔离实机验收与 npm 发布分别记录。发布仍需另行确定版本及授权。
