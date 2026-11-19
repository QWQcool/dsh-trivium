# 项目记忆交接协议（本机）

协议先独立于宿主实现。主宿主显式给出 projectScopeId、主工作区和 ticketId/assignmentId/workerId 映射；不从临时目录父级、工单文本或模型输出推导授权。现有继承和 Router 默认开关保持关闭。公开 Super Agent 扩展点稳定后再接入宿主生命周期。

## 本机接入

npm 0.9.1 提供 `dsh-trivium/handoff` 入口。

```js
import {configureHandoff,submitHandoff,handoffReceipt} from 'dsh-trivium/handoff';

// 只由主宿主配置；cwd 是持久主项目，不是 Worker 临时目录。
const assignments=[{ticketId:'OPS-17',assignmentId:'assignment-1',workerId:'worker-1'}];
await configureHandoff(cwd,{projectScopeId:'project-A',assignments});

const envelope={
  version:1,projectScopeId:'project-A',...assignments[0],eventId:'source-event-42',sessionId:'executor-1',
  sourceTurns:[{role:'user',text:'记住：服务端口是 7431。',sourceSessionId:'main-session',messageId:'message-42',seq:42,recorded:true}],
  candidates:[{type:'decision',name:'端口',text:'服务端口是 7431。',quote:'服务端口是 7431。'}],
};
const accepted=await submitHandoff(cwd,envelope); // 先写中央文件，成功回执才允许发送者消费自己的副本。
const current=handoffReceipt(cwd,envelope);
```

中央进程显式 `startRouter({cwd,allow:true,handoff:{projectScopeId:'project-A',assignments}})`，或用持有正确工作区句柄的 `drainHandoff(cwd,db)` 处理。Worker 仅提交文件队列，不能自行开同一 TDB。Router 启动时接收之前的队列，运行时每秒检查；`drainHandoff()` 可由主宿主主动触发。

## 身份、确认与失败

- 稳定事件键为 projectScopeId、ticketId、assignmentId、eventId 的规范哈希；登记的 workerId 也须相符。同键同内容返回原回执，同键不同内容拒绝，不能把不同内容伪装成一次重试。
- 跨 Worker 去重使用同一主工作区内的项目、已记录来源定位、原文、事实类型、名称和正文。名称和正文去除首尾空白后精确比较。`messageId` 沿用宿主的原始消息标识。消息 ID 按会话分配或只提供 `seq` 时，各 Worker 应转交相同的原始 `sourceSessionId`。旧信封仍可使用，缺少原始会话的序号只在 `sessionId` 内比较。无法定位来源时，只对同一次交接重试去重。
- `queued` 表示中央候选已持久接收。同来源的同一事实落盘后，各 Worker 的回执会返回同一个 `nodeId`，复用的结果标记 `reused: true`。`needs_review` 表示至少有一条尚需复核，`committed` 表示全部已写入或复用，`reviewed` 表示已处理完毕且至少一条被不采纳（`dismissed`）。
- 当前只自动接收可由用户来源核对的候选。工具原文或无法核对的改写保留待复核；不追加判断模型，不猜替代关系，不合并或删除旧事实。
- 稳定 URI 覆盖「图已写入、回执尚未保存」的中断窗口。重试先核对节点，flush 后再确认。新版可复用旧回执指向的未变更节点。已处理节点被改写、归档、替代或删除后，相同来源的投递转待核对，保留既有记录。
- 写锁忙、磁盘失败、队列不可读、未知版本、身份冲突都明确失败；发送者保留原信封重试。主目录队列和已完成回执均不因 Worker 退出清理。
- 同一项目文件属于可信本机宿主边界。注册映射是路由约束，不代替远程身份认证；文件访问权不受工单文本控制。当前没有向远端发送记忆的功能。

## 人工复核

在中央工作区打开「设置 → Trivium 记忆 → 运行记录 → 待补写」。交接候选会标出工单、分配、Worker 和交接事件。补充依据、确认记住、不采纳都沿用原面板。处理记录和原始信封保存在中央收件箱，也可在「候选复核历史」按页查看。依据不足的候选继续待核对，不采纳保留原文和回执。接受后关联同来源已写入的节点，或新增一条人工确认的记忆。

复核由持有中央库写句柄的宿主处理。独立 Router 占用中央库时，面板仍可读取中央收件箱，等 Router 释放写句柄后再提交复核。

## 容量与范围

单信封最多 128 KiB、24 条候选（提交时按实现上限校验），每条正文最多 240 字符；来源最多 16 段。中央历史最多 4096 个事件，满后拒绝新增，不删历史。后续压缩和归档需要独立的可审阅设计。评测只使用合成目录，不接入真实用户库。
