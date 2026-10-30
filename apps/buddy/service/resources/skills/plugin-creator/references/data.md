# 只读数据来源与读取

数据源定义统计含义，`ViewContext.data` 提供读取与观察，视图挂载位置只负责呈现；三者独立。需要包含此数据能力的宿主，不能仅凭 API 主版本认定可用。发布时按实际支持范围声明 `engines.lexora`，本能力不改变 API 主版本。

## 查询与授权

`context.data.read({source, scope:'bound'})` 返回当前快照的 Promise。`bound` 只读取宿主为当前视图实例绑定的范围；不接受 `taskId`、`branchId`、`actorId` 或其他任意目标参数，也不随其他分屏的焦点改读任务。没有有效绑定时返回 `no_target`。数据权限不由 footer、插槽或装饰等位置推导；挂载到某个位置不会自动取得数据。

清单逐项申请来源，例如：

```json
{ "permissions": { "data": ["task.metrics", "context.usage"] } }
```

默认列表为空，更新新增来源需要审核。只申请实际使用的来源；没有“全部数据”布尔权限，不授予正文、日志、凭据、文件、模型调用或任意任务访问。此 API 属于隔离视图，不提供后台宿主或 Worker 的全局读取入口。

| source | 宿主绑定范围 | ready.value |
| --- | --- | --- |
| `task.metrics` | 当前实例绑定的任务与可见分支 | `taskId, branchId, turns, steps, tokens, throughput` |
| `context.usage` | 当前实例绑定的任务、分支与角色上下文 | `taskId, branchId, actorId, runId, tokens, window, percent` |

`task.metrics.tokens` 包含 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`。`throughput` 包含 `samples` 和 `tokensPerSecond`，无有效样本时分别为 0 和 null；均速为有效样本的输出 Token 总数除以输出阶段总时长，不是逐次速率的算术平均。

统计与内置任务面板使用同一来源。内置面板默认汇总全任务，插件只读取绑定分支的可见运行树；范围相同时口径一致。已有历史消息的开始、首内容块、成功完成时间与对应输出用量可形成样本，不要求重新运行任务。中断、无法配对或缺失计时的记录不计入均速，但已发生的消费仍保留在用量中。

`context.usage.actorId` 为字符串，`runId` 可为 null；它表示模型上下文用量，不是累计历史 token。快照中的 ID 仅用来区分来源范围，不是访问其他目标的授权。

## 状态与订阅

所有快照都是深只读的 `{source,status,value}`：

- `ready`：value 为该来源的值。
- `denied`：没有该来源权限，value 为 null；不附带任务、角色身份或数值。
- `no_target`：当前没有可读取的绑定，value 为 null。
- `unavailable`：来源暂时不能提供值，value 为 null。

非 ready 状态不应显示为零，也不能沿用上一个任务的数据。读取请求的协议、会话或运输错误会拒绝 Promise；用正常的异常处理展示失败，不把它伪装成统计值。

`context.data.observe(query, listener)` 返回 Disposable，异步交付当前状态后持续通知变化；无权限也交付 denied，不会静默等待。初始 no_target 不会结束订阅，之后建立绑定仍会通知。无需先 read 再 observe，避免两个请求之间的旧值覆盖。调用 `dispose()` 立即停止本地回调，即使注册尚未回应也会在注册完成后撤回。视图 signal 取消或视图关闭会清理订阅；不保留跨视图会话的订阅句柄。

观察注册或撤回的运输失败进入现有错误诊断，不产生未处理的 Promise 拒绝。观察者的同步异常与异步拒绝由既有事件机制隔离。应用恢复后订阅收到当前快照差异，不保证重放每个中间数值。

```ts
import type { ViewModule } from './sdk'

export const render: ViewModule['render'] = (context, container) => {
  context.data.observe({ source: 'task.metrics', scope: 'bound' }, (snapshot) => {
    container.textContent = snapshot.status === 'ready'
      ? `回合 ${snapshot.value.turns} · 步数 ${snapshot.value.steps}`
      : ''
  })
}
```

## 作用域事件

观察通过既有有序视图事件 `data:changed` 交付，载荷是 `{id, snapshot}`。id 是当前视图内的订阅 UUID；snapshot 为上述状态，或取消时的 null。null 只表示删除该订阅快照，不表示数据值为零。常规插件使用 `data.observe` 即可，不要同时订阅底层事件重复处理。

只调用 `events.on('data:changed', ...)` 不会建立数据观察；通配符也不扩大权限。未获批来源统一归一化为 denied。快照与通知使用相同授权规则，恢复缺失的订阅条目会通知取消。
