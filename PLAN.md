# dsh-trivium 产品与架构

更新：2026-11-16。运行内核 `triviumdb@0.9.0`，宿主验证基线 DSH `0.2.2-rc.1`。发布/源码差异见 [CURRENT-STATE](docs/CURRENT-STATE.md)，后续任务统一在 [ROADMAP](docs/ROADMAP.md)维护。

## 产品定位

为 DeepSeek Harness 提供按工作区保存的长期图记忆。默认少注入，优先可靠事实、更新关系与已存来源；模型通过四工具按需展开。芯片与会话层是可选功能，fork 不是数据库隔离。

## 现行契约

| 项目 | 规则 |
|---|---|
| 四工具 | ctx_find、ctx_read、ctx_remember、ctx_link；新增 HTTP 不自动扩展工具 schema |
| 工作区 | 默认 cwd/.dsh/trivium.tdb，同工作区会话共享事实 |
| 数据 | entity/preference/decision/experience/workspace；可选 episode。业务边 about/decided/broke/fixed |
| 开场地图 | 默认 400 估算 token；首启全量，随后已有版本/差异/跳过与热度策略 |
| 同轮预算 | 芯片、召回和更正共享，默认 300，可设 0–2000；显式 0 关闭该部分，开场地图独立 |
| 写入 | 来源、敏感值和日期守卫，工作区队列及操作锁；同一 .tdb 仍为单写者 |
| 决策更新 | 默认 supersedeMode=propose，由人确认；ETag 防过期提交，拒绝也是有效决定 |
| Embedding | 默认关闭；已配置且被请求的路径才调用，正文或配置变化使旧响应失效 |
| 身份合并 | 默认关闭；相似度不能代替事实同一性 |

估算 token 不是实际账单，见[成本口径](docs/COST-MODEL.md)。

## 读写流程

1. 宿主事件经 source-events 归一，采集有限窗口；规则和模型抽取候选。快筛作观察，不凭旧白名单分数丢事实。
2. 候选经过来源、敏感值、日期、身份守卫，抽取经 MemoryWriter 写入；失败保留 pending，重放成功再消费窗口，首启先恢复后建地图。
3. 检索组合文本、可选向量与业务图关系，映射当前版本、检查期限/归档/坏链，按共享预算投递。更正、芯片和召回共用同轮账本。
4. 管理读取、具名查询与实体检索显式指定工作区，复用宿主句柄或捕获的固定代际快照。

## 决策更新

supersedes 是有界线性链，每点最多一个直接前驱和后继，拒绝循环/坏链。旧正文受保护；新说法建新节点，由人确认替代。自动检索映射当前版本；历史手工 pin 保留旧 ID 并标识。当前版本失效时不把旧决定复活。

确认/拒绝带候选 ID、ETag，服务端重核工作区与图状态；ctx_remember 的 link_label 不能绕过确认。现行接口见 [0.8.7 契约](docs/release-0.8.7.md)，旧方案比较见 [HISTORY](docs/HISTORY.md)。

## 模块边界

| 模块 | 责任 |
|---|---|
| index / extract-scheduler / source-events | 宿主事件、窗口、地图、预算调度与恢复 |
| extract / identity / hygiene / date-parse | 候选抽取和写入守卫 |
| store / memory-writer / workspace-lock | 原生库封装、写入端口和串行边界 |
| context-budget / turn-ledger / usage | 有界上下文、去重、已送达账本和派生热度 |
| revisions / supersede-review / revision-graph | 当前版本、人工提案和链约束 |
| provenance / change-log / recall-trace / recall-preview | 来源、持久变更与进程内诊断 |
| read-api / read-query / live-tql / read-snapshots | 显式只读查询、预算和快照 |
| entity-search 系列 / embed | 有界实体候选、可取消语义请求、快照 worker |
| inherit / router | 可选继承与集中写原型，尚未常驻集成 |
| pins / episode / client / server | 芯片、宿主压缩投影、设置页和 HTTP |
| sidecar / integrity / consumer-preferences | JSONL 交换、只读体检与授权偏好导出 |

模块都位于 lib/。完整 HTTP 契约见 [read-api](docs/read-api.md)。

## 界面

设置页按「记忆库／记忆变化／上下文／设置」组织，来源、历史和诊断按需读取，不补造引文或会话链接。源码新增事实查询和实体范围卡片位于上下文页，实体卡片还需真实宿主操作验收。芯片与会话层见[现行说明](PLAN-session-map.md)。

前端由宿主 ModuleLoader 装载，拆分 client.js 前需验证装载契约，不能直接假设相对 require 可用。结构渲染、截图和真实键盘操作属于不同验证层。

## 存储与并发

- JSONL 是业务交换文件，默认不自动写出；不含向量、episode、pins 和完整本地来源，不能代表完整库。关闭写出不禁止读已有 JSONL。
- 文件组由内核管理，主文件、payload、向量和标记须同代；只读诊断不自动推测修复丢失正文。
- 投递账本和召回 trace 是进程内状态；change log 和 pending 各有持久化边界，不能混称完整审计日志。
- scopeInheritance 默认关；父目录继承是原型，未来工单应传显式项目作用域，不从临时 worktree 的父目录猜测。
- Router 原型串行写同一句柄，常驻化前仍需持久候选、幂等键和提交回执。命名图不会取消单写锁要求。

## 开发取舍

优先复用原生图/属性/向量访问与现有守卫，以相同预算提高覆盖、减少无关注入和重复计算。先做任务相关记忆包，再评估变更订阅和文档证据；版本前提与验收见 [ROADMAP](docs/ROADMAP.md)。

回归按[开发指南](docs/DEVELOPMENT.md)，发布按[检查清单](docs/release-checklist.md)。实现、隔离验证、部署、发布分别记录。
