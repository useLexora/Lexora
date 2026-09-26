# 分屏与临时交互

API 3 提供真实布局快照和可取消的交互会话。先查询 `lexora_plugin_capabilities({kind:"runtime"})`，类型以 [api.d.ts](api.d.ts) 为准。

## 分屏快照

宿主入口通过 `context.workbench.panes` 获取当前快照，并用 `onPanesChange` 订阅分割、拖动、关闭、页面切换和可见性变化。每个分屏只有不透明 `id`、`active`、`visible`、`rect`；坐标单位是 CSS 像素，相对 `workbench` 挂载口。不可见分屏的矩形归零，订阅可能合并中间更新。

不要读取宿主持久化文件、探测父 DOM、发送心跳或按宽度横排推测布局。只对可见分屏计算几何；用户切换页面或窗口隐藏时，暂停交互计时由插件负责。分屏 ID 只在当前布局中有效。

## 会话和退出

临时覆盖层在 `kind:"view"` 的 placement 声明 `interaction:"regions"` 或 `"exclusive"`，目标限定为 `workbench` / `workbench.pane`，必须为绝对定位。打开前创建会话：

```ts
const interaction = await context.interactions.start('互动游戏')
interaction.signal.addEventListener('abort', cleanup, { once: true })
try {
  await context.placements.show(`${context.extension.id}.game`, {
    interactionId: interaction.id,
    instanceId: originPaneId,
  })
}
catch (error) {
  await interaction.end()
  throw error
}
```

`instanceId` 仅适用于分屏挂载，省略时选择当前活动分屏；全工作台挂载省略该字段。同一会话可拥有多个视图。每个插件同时最多 4 个会话；会话不恢复到下一次启动。

宿主在覆盖区域外提供结束按钮，Esc 也可结束交互；无需重新输入命令。结束会立即撤回会话视图，再通知 `signal` 取消；即使插件清理失败，宿主仍能移除覆盖。禁用、崩溃或窗口文档替换都会回收会话。原有任务继续执行，结束交互不会停止模型任务。结束后的 ID 不能再次打开视图。

## 局部点击区域

`regions` 模式的 iframe 仅绘制。透明空白不会挡住下方的输入框、滚动或选择；只有显式声明的区域接收点击。不要依赖 iframe 内普通 DOM 监听器，使用：

```ts
await context.interaction!.setRegions([
  { id: 'target', label: '击中目标', rect: { x: 20, y: 30, width: 64, height: 64 } },
])
context.interaction!.onActivate(({ id, x, y }) => hit(id, x, y))
```

区域坐标相对当前视图，最多 64 个，ID 唯一、标签非空；裁剪与视图边界一致。宿主将鼠标、触摸点击或键盘按钮激活转发为统一事件；不提供全局键盘监听或任意事件透传。更新位置、大小或移除目标时同步更新区域；传 `[]` 暂停全部交互。

`exclusive` 模式允许 iframe 内完整交互，覆盖区域会阻挡下方操作，但仍保留宿主退出入口。普通持久挂载不需要会话。

## 多视图状态

宿主入口可用 `context.views.broadcast(message)` 向本插件当前视图广播有限 JSON，视图通过 `onMessage` 接收。广播不是持久化，也不保证新打开的视图收到历史消息；新视图应通过自己的命令拉取初始状态。布局订阅和会话状态由宿主入口统一维护，视图只绘制。涉及计时器、音频和事件监听时，绑定会话的 `signal` 或视图的 `signal` 清理。
