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

## 编辑器交互

交互视图可通过 `setDocumentInfo({title,dirty})` 更新名称和修改标记；它不会保存内容。`onBeforeClose` 可等待保存并决定是否继续关闭，仍应持续维护恢复草稿，见[文件与文档](./files)。

复制粘贴通过 `context.clipboard.read/write`，需要独立权限及前台可见焦点。文本与 HTML 合计最多 4 MiB；关闭或失焦后操作会失败。浏览器的 `navigator.clipboard` 不替代宿主接口。

## 验证界面

检查两份实例的状态独立、切换页面后的行为、主题变化、关闭与重新打开入口，以及停用后的清理。控件还要验证旧版本提交被拒绝和失败时宿主默认内容可用。
