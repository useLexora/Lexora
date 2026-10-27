---
title: "主题与外观"
description: "使用声明式主题、文件图标、隔离视图样式和窗口装饰。"
---

# 主题与外观

按修改范围选择能力：配色主题管理用户选择的整体外观，视图样式只影响插件内容，窗口样式和装饰用于明确授权的宿主区域。

## 配色与图标主题

API 3 的 `contributes.themes` 可声明多个主题，包含颜色、可选欢迎内容和材质。纯主题包无需脚本入口或权限，启用插件后由用户选择主题。

`contributes.iconThemes` 独立提供文件和目录图标映射，不改变配色主题。图片随插件打包，保留来源许可；不是宿主操作按钮的图标替换通道。

主题编辑器使用 `context.themes` 校验、预览和保存用户副本，需要 `themeManagement` 权限。不要通过修改应用配置文件写入主题。

## 隔离视图样式

视图可使用普通 CSS 或在源码清单添加 `"styles": {"uno": true}`。固定编译器生成并打包 `lexora-uno.css`，视图自动加载：

```ts
container.className = 'flex gap-3 p-4 bg-surface text-fg'
```

使用完整工具类字符串；动态拼接无法静态提取时放入 `styles.safelist`。不执行插件提供的 UnoCSS 配置。`--lexora-background`、`--lexora-text`、`--lexora-accent-solid` 等变量跟随主题变化，Canvas 可订阅 `onEnvironmentChange` 重绘。

## 窗口样式与装饰

`windowEffects` 开放后台 `window.styles.set/remove`，可用稳定的 `data-lexora-region` 区域标识注入自己的样式表。停用、崩溃或更新会撤回样式，激活时按配置恢复；不开放宿主 DOM 脚本访问。

动画使用 `kind: "decoration"` 的隔离视图。先分别选择事件来源和呈现范围：整个窗口、任务工作区、分屏、历史或输入框并不相同。输入活动不包含字符或按键，局部坐标只相对于所属锚点。

装饰不接收指针和焦点；保持背景透明，限制同时运行的动画，尊重减少动态效果。关闭时清理，空闲时停止绘制。需要交互的内容使用普通视图或临时交互。

## 实际检查

检查亮暗主题、尺寸变化、页面切换、减少动态效果以及停用后的撤回。仅看静态截图不能证明动画停止、控件回退或资源清理有效。
