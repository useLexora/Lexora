# 入口、通信与状态

## 页面、宿主与设置

事件可通过作用域内的 `context.events.on` 统一订阅，支持命名空间和通配符，旧 `onMessage/onWorkbenchChange` 等入口继续可用；事件名与生命周期见 [作用域事件](events.md)。

完整类型见同目录 `api.d.ts`。每个视图是独立沙箱。`render` 可异步，前台加载须在 10 秒内完成；耗时内容先绘制加载状态，再异步填充。加载失败会结束该视图并提供重启入口，其他视图与宿主继续运行。没有 `mount`、全局 `lexora` 或 Vue 运行时。

宿主入口示意：

```ts
import type { ExtensionContext } from './lexora'

export function activate(context: ExtensionContext) {
  context.subscriptions.add(context.commands.register(`${context.extension.id}.read-settings`, async () => context.storage.get()))
}
```

该命令须出现在 `contributes.commands` 中，例如 `{ "id":"<plugin-id>.read-settings", "title":"读取设置", "hidden":true }`。视图通过 `context.commands.execute(command, arguments)` 调用自身命令，返回 JSON。私有数据使用 JSON；更改结构时递增 `dataVersion` 并导出 `migrate(previous, from, to)`。

文件工具仍可通过可见命令提供打开入口；支持新关联声明的 API 4 宿主也可使用 [文件关联](resources.md#文件关联与独立入口)。命令方式中，用户先在文件面板打开文件，再从命令面板执行它；宿主将收到的资源句柄传入视图：

```ts
context.subscriptions.add(context.commands.register(`${context.extension.id}.open`, async ({ resource }) => {
  if (!resource)
    throw new Error('请先打开一个文件')
  await context.views.open(`${context.extension.id}.reader`, { resource, state: {} })
}))
```

该视图声明 `resource: "selected-file"`，插件声明 `selectedResource: "read"`；视图从 `context.resource` 取得同一资源，通过 `resources.readText` 读取。句柄不是文件路径。只声明视图不会自动增加文件菜单或命令入口。

## 状态与模块

- `activate(context)` 管理命令、私有业务数据、通知和定时任务；`render(context, container)` 管理自己的隔离 UI。只需要视图时不创建空宿主；需要命令时必须同时声明宿主入口和命令 ID。
- 资源页签及普通挂载面板用 `ViewContext.state/setState` 保存该实例的筛选、阅读位置等 JSON。升级比较 `stateVersion` 与 `expectedStateVersion`，转换后再保存。导航页面、装饰、内容插槽和替换控件不支持这条持久化路径。
- 挂载目标和外框布局通过 `setPresentation` 更新；内容样式、交互及业务状态完全由插件实现，业务状态使用 `setState` 或宿主私有存储。宿主不会依据插件数量提供面板切换或自动避让。不能用父页面 CSS 选择器或 Vue Teleport 穿透隔离。
- 扩展级私有业务数据用宿主 `storage.get/set`。视图通过自身命令读写，不访问宿主内存；更改数据结构时增加 `dataVersion` 并提供 `migrate`。不要把一个文件的阅读位置存成覆盖所有文件的全局值。
- 每个视图具有独立 JS 环境。宿主通过 `views.broadcast(message)` 向本插件当前 generation 的视图同步状态，视图使用 `onMessage` 订阅；首次读取仍通过自身命令获取快照。共享状态由宿主持有，视图提交局部操作，避免旧快照覆盖其他视图的更改。源码中的纯函数可通过包内相对导入复用。
- 视图通过 `signal` 清理监听、定时器、音频和异步回写；销毁时不要再异步保存状态，正常交互中及时保存，并处理保存失败；宿主通过 `subscriptions` 释放注册，也可用 `ExtensionContext.signal` 绑定异步工作；Worker 由创建它的上下文管理生命周期。恢复视图不代表自动播放音频或重放上次用户提交。
