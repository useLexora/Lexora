---
title: "视图与交互"
description: "为插件选择页面、资源标签、挂载面板、菜单或输入命令。"
---

# 视图与交互

先决定用户从哪里进入、在哪里操作、关闭后如何再次打开，再选择视图与入口。

## 选择呈现方式

| 需求 | 声明与行为 |
| --- | --- |
| 独立导航页面 | `navigation` 引用 `resource: "none"` 的视图 |
| 文件标签或通用工具标签 | `location: "context"`，用命令、文件关联或启动入口打开 |
| 工作台或分屏中的面板 | `placements` 的 `kind: "view"`，声明 `target` 与 `presentation` |
| 宿主内容区或控件 | `kind: "slot"` / `"control"`，由宿主提供位置和默认回退 |
| 不接收指针的装饰 | `kind: "decoration"`，绑定正式锚点 |

`render(context, container)` 在独立隔离页面中运行。容器填满视口、无默认内边距，插件负责自己的布局；不读取父页面 DOM。Vue、React 等先构建为浏览器模块，见[依赖与计算](./workers)。

## 命令与菜单

命令须同时在 `contributes.commands` 声明并在后台注册。仅供自己视图调用的命令可设 `hidden: true`。输入命令添加 `slash: {name, description?}`，使用 `/插件调用名:命令`，不会自动向模型发起请求。

`contributes.menus` 把命令放进公开菜单目标。仅用户点击且声明 `selectedContent` 后才提供相应文本；文件仍使用独立资源权限。输入菜单返回 `{insertText}` 时，宿主只向未被修改的原草稿插入文本，不自动发送。

```ts
context.subscriptions.add(
  context.commands.register(`${context.extension.id}.open`, async () => {
    await context.views.open(`${context.extension.id}.panel`)
  }),
)
```

## 挂载与可见性

挂载内容和外框分开定义。`presentation` 提供位置、尺寸和顺序，后台 `placements.show/hide` 打开或关闭面板；视图 `setPresentation` 调整自身外框。进入分屏时固定原 `instanceId`，异步完成后不重新选择焦点。

`when` 使用宿主公开页面上下文控制可用性；`visible/onVisibilityChange` 反馈实际可见状态。隐藏可能保留实例和订阅，暂停动画或媒体由插件决定。实例恢复不意味着应重放用户操作。

插槽和控件的 `show/hide` 表示当前宿主生命周期中的启用状态。持久偏好由插件保存，`setActive(false)` 可表示当前没有可展示内容，宿主随后呈现默认内容。

## 只读数据与绑定范围

视图呈现位置、数据来源与访问权限相互独立。先在清单逐项声明：

```json
{ "permissions": { "data": ["task.metrics", "context.usage"] } }
```

`context.data.read({ source, scope: 'bound' })` 读取当前快照，`observe(query, listener)` 持续观察。两者只访问宿主为当前实例绑定的范围，不接受任意 `taskId`、`branchId` 或 `actorId`，也不跟随其他分屏焦点。没有绑定的页面返回 `no_target`；挂载到 footer、装饰或插槽不会自动获得授权。后台与 Worker 没有此全局数据入口。

| 来源 | 范围与数据 |
| --- | --- |
| `task.metrics` | 绑定任务的可见分支运行树；回合 `turns`、步数 `steps`、输入/输出与缓存 token、`throughput` |
| `context.usage` | 绑定任务、分支与角色的模型上下文；`tokens`、`window`、`percent`，不是历史累计 token |

统计与内置任务面板同源，但内置面板默认全任务，只有范围相同时才可直接比较。`throughput.tokensPerSecond` 是有效样本的输出 token 总数除以输出阶段总时长；无有效样本时为 `null`，`samples` 为 0。缺失上下文或计时事实不能推测补齐。

快照是只读的 `{ source, status, value }`。`ready` 才有值；`denied` 表示缺少来源权限，`no_target` 表示无绑定，`unavailable` 表示暂不可用，后三者的 value 均为 null。非 ready 状态不可显示成零或沿用上一任务的值；直接读取的协议或运输错误仍会拒绝 Promise。

```ts
import type { ViewContext } from './lexora'

export function render(context: ViewContext, container: HTMLElement) {
  context.data.observe({ source: 'task.metrics', scope: 'bound' }, (snapshot) => {
    container.textContent = snapshot.status === 'ready'
      ? `回合 ${snapshot.value.turns} · 步数 ${snapshot.value.steps}`
      : ''
  })
}
```

`observe` 异步交付初始状态，无权限也交付 denied，无绑定也继续等待后续变化，不需要先 read 再 observe。返回的 Disposable 可提前停止回调；视图关闭或 signal 取消会清理订阅。恢复只保证当前快照，不重放每个中间值。底层 `data:changed` 事件不会自行建立观察，通常不必再订阅它。

## 编辑器交互

交互视图可通过 `setDocumentInfo({title,dirty})` 更新名称和修改标记；它不会保存内容。`onBeforeClose` 可等待保存并决定是否继续关闭，仍应持续维护恢复草稿，见[文件与文档](./files)。

复制粘贴通过 `context.clipboard.read/write`，需要独立权限及前台可见焦点。文本与 HTML 合计最多 4 MiB；关闭或失焦后操作会失败。浏览器的 `navigator.clipboard` 不替代宿主接口。

## 验证界面

检查两份实例的状态独立、切换页面后的行为、主题变化、关闭与重新打开入口，以及停用后的清理。数据视图另检查分屏绑定、逐来源拒绝、无目标、恢复与撤权，不能只验证数字显示。控件还要验证旧版本提交被拒绝和失败时宿主默认内容可用。
