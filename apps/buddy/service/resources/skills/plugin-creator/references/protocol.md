# Lexora 插件 API 1

一个包包含根 `extension.json` 和包内文件。源码包支持自包含 `.ts`、`.mts`、`.js`、`.mjs`，以及静态 CSS、图片等资源；原始 HTML、Vue 单文件组件、npm 裸导入不属于当前编译协议。第三方库需作者预先打包。不要生成 `package.json`、锁文件、构建脚本、`node_modules` 或远程 CDN 依赖。

## 清单

窗口效果的最小清单（名称、ID、入口按实际需求修改）：

```json
{
  "schemaVersion": 1,
  "format": "source",
  "id": "local.typing-confetti",
  "name": "打字礼花",
  "description": "在对话输入时显示短暂礼花。",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": { "lexora": ">=0.7.3 <1.0.0" },
  "permissions": { "windowEffects": true },
  "contributes": {
    "views": [{
      "id": "local.typing-confetti.effect",
      "title": "打字礼花",
      "entry": "effect.ts",
      "location": "window-overlay",
      "resource": "none"
    }]
  }
}
```

可选字段：`icon`（包内 SVG/PNG/JPEG/WebP，≤64 KiB）、`categories`、`tags`、宿主 `entry`、`dataVersion`。不要添加未定义的字段。命令和视图 ID 以插件 ID 加 `.` 开头且不重复。文件路径相对包根，不能包含 `..` 或符号链接；512 文件、单文件 4 MiB、合计 16 MiB 上限。

## 视图类型

| location | resource | 行为 |
| --- | --- | --- |
| `page` | `none` | 独立页面，可作为导航入口 |
| `context` | `selected-file` 或 `none` | 工作区资源页签，由用户打开 |
| `window-overlay` | `none` | 启用后自动挂载的透明窗口效果，每插件最多一个；无法点击或聚焦 |

页面与小视图由插件绘制，均使用 `render(context, container)`，共用隔离和通信 API。窗口效果是当前已支持的独立挂载场景；没有看板宿主或任意宿主 DOM 插槽。

导航入口位于自动化下方，声明 `contributes.navigation: { "title": "插件名称", "view": "local.plugin.settings" }`，引用一个 `page` 视图。不需要设置页的效果插件可以没有导航。

页面与窗口效果不能使用 `context.setState()`；需要持久设置时声明宿主入口和隐藏命令，以 `context.storage.get/set` 保存。多个视图使用同一设置时明确刷新时机，插件局部开关必须能在不重载视图的情况下关闭并重新启用。资源页签的 `setState` 用于保存该页签的 JSON 状态。

## 权限

| permissions 字段 | 能力 |
| --- | --- |
| `windowEffects: true` | 窗口叠加绘制以及无内容的对话输入活动 |
| `notifications: true` | 宿主 `context.notifications.show({title,body})` |
| `schedules: true` | 宿主持久间隔任务，需要宿主入口与已声明命令 |
| `selectedResource: "read"` | 读取明确分配给视图的文件资源 |
| `network: ["https://example.com"]` | 通过宿主向列出的 HTTPS origin 发 GET 请求 |

未声明权限默认为关闭。视图无法访问 Node、宿主 DOM、全局键盘、网络 fetch 或任意本地文件。资源和网络调用通过 API；用户在安装确认中查看权限。没有一般性消息订阅、系统剪贴板或屏幕截图接口。

## 窗口效果

视图入口形式为 `export function render(context: ViewContext, container: HTMLElement)`，类型使用 `import type { ViewContext } from './lexora'`。在 `render` 内调用 `context.onActivity(listener)`，监听 `{type:"composer-input"}` 并在自己的 `container` 内绘制实际效果。

`onActivity` 仅用于 `window-overlay`。事件没有字符、按键、文本长度、坐标或任务 ID，最多约每秒 20 次，只来自前台 Lexora 对话输入框，包括输入法输入。宿主过滤程序性修改、其他输入框和减少动态效果模式。不要注册父窗口键盘事件。

宿主保持 iframe 透明且不拦截鼠标或焦点。插件使用 DOM、Canvas、Web Animations 或 requestAnimationFrame 绘制。保持 `html/body` 透明，不铺不透明全屏背景；无操作时不持续刷新。禁用、卸载和窗口销毁会关闭视图。通过 `context.signal` 清理事件、计时器与动画；粒子和同时运行的动画必须有上限。

## 页面、宿主与设置

完整类型见同目录 `api.d.ts`。每个视图是独立沙箱。`render` 可异步；没有 `mount`、全局 `lexora` 或 Vue 运行时。

宿主入口示意：

```ts
import type { ExtensionContext } from './lexora'

export function activate(context: ExtensionContext) {
  context.subscriptions.add(context.commands.register('local.example.read-settings', async () => context.storage.get()))
}
```

该命令须出现在 `contributes.commands` 中，例如 `{ "id":"local.example.read-settings", "title":"读取设置", "hidden":true }`。视图通过 `context.commands.execute(command, arguments)` 调用自身命令，返回 JSON。私有数据使用 JSON；更改结构时递增 `dataVersion` 并导出 `migrate(previous, from, to)`。

后台提醒使用 `context.schedules.set({ id, command, enabled, intervalMinutes })`，间隔最少 1 分钟；不要用页面 setInterval 代替跨页面提醒。Lexora 退出后暂停，重启继续，错过的提醒不会补发。

## 主题与样式

直接创建元素、设置样式，或引入包内 CSS：`link.href = new URL('./style.css', import.meta.url).href`。使用 `--lexora-background`、`--lexora-text`、`--lexora-muted`、`--lexora-border`、`--lexora-accent`、`--lexora-accent-solid`。`context.environment` 提供语言、配色与颜色；`context.onEnvironmentChange` 订阅切换。效果应柔和短暂，不遮挡正文或确认操作。
