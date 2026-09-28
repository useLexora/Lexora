# 作用域事件

当前 SDK 中，宿主和视图的 `context.events.on(patterns, listener, options?)` 提供只读订阅，返回可提前释放的订阅句柄。`patterns` 可以是一个名称，也可以是只读数组。订阅随所属宿主或视图销毁释放；可传 `{once:true}` 或 `{signal:AbortSignal}`。已取消的 signal 和空数组不创建订阅。

事件使用 `{type,data}`，`type` 是「领域:对象:事实」或「领域:事实」，`data` 使用有含义的命名字段。类型声明根据订阅推导可区分的事件联合，检查 `event.type` 后即可取得对应载荷。支持精确名称、结尾 `:*`（一层）、结尾 `:**`（任意层）；单独 `*` 只匹配不含冒号的名称，`**` 匹配当前作用域全部事件。不支持任意正则表达式。

```ts
const subscription = context.events.on(['configuration:changed', 'workbench:**'], (event) => {
  if (event.type === 'configuration:changed')
    updateConfigurationDisplay(event.data.configuration, event.data.changedKeys)
  else if (event.type === 'workbench:panes:changed')
    updatePanes(event.data.panes)
})
// 也可提前停止整组订阅。
subscription.dispose()
```

| 作用域 | 事件 | data / 原有入口 |
| --- | --- | --- |
| 宿主 | `configuration:changed` | `{configuration, changedKeys}`，观察已保存配置；实际热应用另用 `configuration.onChange` |
| 宿主 | `workbench:panes:changed` | `{panes}`；`workbench.onPanesChange` |
| 视图 | `view:message:received` | `{message}`，本插件私有广播；`onMessage` |
| 视图 | `workbench:context:changed` | `{context}`，公开上下文；`onWorkbenchChange` |
| 视图 | `view:visibility:changed` | `{visible}`；`onVisibilityChange` |
| 视图 | `view:environment:changed` | `{environment}`，语言与主题；`onEnvironmentChange` |
| 视图 | `view:mount:changed` | `{mount}`，当前挂载几何；`onMountChange` |
| 装饰视图 | `view:anchor:changed` | `{anchor}`，当前锚点几何；`onAnchorChange` |
| 装饰视图 | `composer:input:received` | `{caret?}`，仅活动和可选局部光标矩形，不含输入文本；`onActivity` |
| 控件视图 | `control:changed` | `{control}`，控件快照；`control.onChange` |
| 交互视图 | `interaction:activated` | `{regionId, x, y}`，自己命中区域的局部点击；`interaction.onActivate` |

旧入口和原有回调载荷继续可用，与事件订阅共用同一来源，API 仍为 3。不要同时订阅新旧入口来处理同一变化。宿主事件只属于当前扩展，视图事件只属于当前实例；私有广播仅分发到本插件当前 generation 的视图。通配符不增加数据权限，`**` 也不包含任务、对话历史、凭据或未授权资源。插件没有发布宿主事件的入口。

数组是一个订阅组：同次发布即使同时命中多个 pattern 也只调用一次；`once` 表示整组只接收第一次匹配的事件；`dispose()` 或 signal 取消会释放整组。分别调用两次 `on` 是独立订阅，不互相去重或释放。

每次派发固定订阅快照，新加订阅从下次生效，已释放订阅不再调用。`once` 在回调前释放，重入不会重复调用。同一 pattern 按注册顺序调用；不同 pattern 间不要依赖顺序，异步监听器也不保证完成顺序。状态类事件先更新只读快照再通知；订阅不重放历史，初始状态仍通过对应读取接口获取。私有广播的 message 保持 JSON 契约，不用于发布系统事件。

普通通知不会等待异步监听器；同步异常和 Promise 拒绝均被隔离。包括 `configuration:changed` 在内，普通订阅及 `**` 都不表示插件已应用配置。

需要热应用时显式注册 `context.configuration.onChange(configuration => applyConfiguration(configuration))`，返回的 Promise 应在应用完成后解决。宿主先保存配置并撤销旧调用，再等待这些应用处理器。没有处理器、应用失败或超时会回退到重启，已经保存的配置保留；新的工具调用等待应用或重启完成。迟到的旧代结果不会恢复已撤销的调用。

视图初始化使用当前作用域的只读快照，随后接收增量。宿主在权限与实例过滤后确定顺序；初始化期间发生变化、出现缺口或缓冲溢出时，SDK 重新读取快照并通知实际差异，不要求插件实现补偿。一次恢复最多尝试三次，失败后较新的增量会触发下一轮有界恢复。输入活动、私有消息和点击不提供历史重放；已初始化实例收到但尚未交付的这些通知会在恢复后交付一次，旧实例与初始化快照之前的通知不重放。命令超时表示结果尚未确认，读取当前状态后再决定下一步，不自动重做可能已经执行的操作。
