# 项目记忆交接协议（开发中）

协议先独立于宿主实现。主宿主显式给出 projectScopeId、主工作区和 ticketId/assignmentId/workerId 映射；不从临时目录父级、工单文本或模型输出推导授权。现有继承和 Router 默认开关保持关闭。公开 Super Agent 扩展点稳定后再接入宿主生命周期。

## 本机接入

源码新增 `dsh-trivium/handoff` 入口（npm 尚不包含本轮变更）：

```js
import {configureHandoff,submitHandoff,handoffReceipt} from 'dsh-trivium/handoff';

// 只由主宿主配置；cwd 是持久主项目，不是 Worker 临时目录。
const assignments=[{ticketId:'OPS-17',assignmentId:'assignment-1',workerId:'worker-1'}];
await configureHandoff(cwd,{projectScopeId:'project-A',assignments});

const envelope={
  version:1,projectScopeId:'project-A',...assignments[0],eventId:'source-event-42',sessionId:'executor-1',
  sourceTurns:[{role:'user',text:'记住：服务端口是 7431。',messageId:'message-42',seq:42,recorded:true}],
  candidates:[{type:'decision',name:'端口',text:'服务端口是 7431。',quote:'服务端口是 7431。'}],
};
const accepted=await submitHandoff(cwd,envelope); // 先写中央文件，成功回执才允许发送者消费自己的副本。
const current=handoffReceipt(cwd,envelope);
```

中央进程显式 `startRouter({cwd,allow:true,handoff:{projectScopeId:'project-A',assignments}})`，或用持有正确工作区句柄的 `drainHandoff(cwd,db)` 处理。Worker 仅提交文件队列，不能自行开同一 TDB。Router 启动时接收之前的队列，运行时每秒检查；`drainHandoff()` 可由主宿主主动触发。

## 身份、确认与失败

- 稳定事件键为 projectScopeId、ticketId、assignmentId、eventId 的规范哈希；登记的 workerId 也须相符。同键同内容返回原回执，同键不同内容拒绝，不能把不同内容伪装成一次重试。
- `queued` 仅表示中央候选已持久接收；`committed` 表示图已 flush，且回执文件已写入；`needs_review` 表示候选和来源留在中央记录，未被当作有效事实。
- 当前只自动接收可由用户来源核对的候选。工具原文或无法核对的改写保留待复核；不追加判断模型，不猜替代关系，不合并或删除旧事实。
- 每个候选有稳定 URI，覆盖「图已写入、回执尚未保存」的中断窗口。重试先核对该节点，flush 后再确认。节点被改写或归档时拒绝自动结算，交给人工处理。
- 写锁忙、磁盘失败、队列不可读、未知版本、身份冲突都明确失败；发送者保留原信封重试。主目录队列和已完成回执均不因 Worker 退出清理。
- 同一项目文件属于可信本机宿主边界。注册映射是路由约束，不代替远程身份认证；文件访问权不受工单文本控制。当前没有向远端发送记忆的功能。

## 容量与范围

单信封最多 128 KiB、24 条候选（提交时按实现上限校验），每条正文最多 240 字符；来源最多 16 段。中央历史最多 4096 个事件，满后拒绝新增，不删历史。后续压缩和归档需要独立的可审阅设计。评测只使用合成目录，不接入真实用户库。
