# 主题样式与窗口装饰

## 主题与样式

完整主题包、欢迎内容与主题编辑器 API 见 [主题](themes.md)。修改用户主题需要 `themeManagement: true`；仅贡献主题无需权限。

API 3 的 `contributes.iconThemes` 可贡献独立的文件与目录图标主题，无需脚本入口或权限，详见 [文件图标主题](file-icon-themes.md)。

源码包可在清单声明 `"styles": { "uno": true }`，编译器提取包内 TS/JS 的完整类名并生成 `lexora-uno.css`，宿主在视图渲染前自动加载。该文件名保留给编译器，源码不要自行创建。不需要安装 UnoCSS，也不执行插件的 UnoCSS 配置或构建脚本。预编译包使用同一编译工具生成并携带该 CSS。使用此能力时，`engines.lexora` 的最低版本须覆盖提供该能力的宿主。

例如 `container.className = 'flex items-center gap-2 rounded-micro bg-accent-surface text-accent-text p-3'`。常用语义类包括 `bg-surface`、`bg-raised`、`text-fg`、`text-muted`、`border-border`、`bg-accent`、`text-on-accent`、`hover:bg-accent-hover`、`text-danger`、`font-sans` 和 `font-mono`。普通交互背景使用 `hover:bg-hover`、`active:bg-pressed`，选中及选中后悬浮使用 `bg-selected`、`hover:bg-selected-hover`；实色按钮使用 `bg-accent hover:bg-accent-hover active:bg-accent-pressed text-on-accent`，强调文字使用 `text-accent-text`。这些颜色会一起响应主题切换；警告、错误和中性底色保留各自语义。动态状态使用完整类名映射；无法静态提取的完整类名放在 `styles.safelist` 数组，不拼接 `bg-${color}`。

颜色来自 `context.environment`，跟随当前主题实时更新，无需重建视图。原有 `--lexora-background`、`--lexora-text`、`--lexora-muted`、`--lexora-border`、`--lexora-accent`、`--lexora-accent-solid` 保持可用；其中 `accent` 是强调文字色，`bg-accent` 使用 `accent-solid`。更多语义变量与工具类同名，如 `--lexora-accent-surface`、`--lexora-focus`。Canvas 等绘制逻辑可通过 `context.onEnvironmentChange` 响应变化。

复杂效果仍可创建元素、设置样式，或引入包内 CSS：`link.href = new URL('./style.css', import.meta.url).href`。效果应柔和短暂，不遮挡正文或确认操作。CSS 只作用于插件自己的隔离页面。

临时覆盖层、分屏布局订阅与局部点击区域见 [交互会话](interactions.md)。

## 窗口效果

视图入口形式为 `export function render(context: ViewContext, container: HTMLElement)`，类型使用 `import type { ViewContext } from './lexora'`。在 `render` 内调用 `context.onActivity(listener)`，在自己的 `container` 内绘制实际效果。输入锚点事件为 `{type:"composer-input", caret:{x,y,width,height}|null}`，坐标相对当前锚点。

`context.anchor` 和 `onAnchorChange` 提供 `{kind,visible,width,height}`，不包含屏幕坐标。呈现范围与事件来源按下表选择，不能因输入触发就默认选输入框装饰：

| 呈现范围 | 声明 | 活动与坐标 |
| --- | --- | --- |
| 整个客户端窗口 | `kind: "decoration"`、`anchor: "window"` | 在所有页面显示，包括设置页、顶栏和两侧栏，输入活动坐标相对窗口；不接收指针与焦点 |
| 任务主工作区 | `kind: "decoration"`、`anchor: "workbench.workspace"` | 仅任务页的跨分屏连续区域；不包括顶栏、侧栏和资源面板，切换到其他页面时隐藏，输入活动坐标相对该区域 |
| 整个输入所在分屏 | `kind: "decoration"`、`anchor: "workbench.pane"` | 每个分屏独立实例，只接收自己内部的对话输入活动，caret 相对该分屏；可以覆盖对话区域，不能越过分屏边界 |
| 对话历史区 | `kind: "decoration"`、`anchor: "task.history"` | 每个可见历史视口独立实例，背景不随消息滚动；不提供消息内容，不覆盖输入框 |
| 输入框内部 | `kind: "decoration"`、`anchor: "composer.input"` | 只接收该输入框活动，caret 相对输入框，绘制裁剪在输入框内 |
| 整个 Lexora 窗口 | 视图 `location: "window-overlay"` | API 1、API 2 均只收到 `{type:"composer-input"}`，不含来源分屏与坐标；插件自行选择窗口内的位置 |

分屏装饰随分屏创建、改变尺寸和关闭；页面隐藏时保留实例并更新可见性。事件绑定输入发生的分屏，不随之后的焦点切换转交其他分屏；插件无需读取任务或分屏 ID。多个分屏及多个插件的实例各自隔离。此锚点提供透明装饰区域，不提供交互面板外壳。

事件没有字符、按键、文本长度或任务 ID，最多约每秒 20 次，只来自前台 Lexora 对话输入框，包括输入法输入。宿主过滤程序性修改、其他输入框和减少动态效果模式。不要注册父窗口键盘事件。

宿主保持 iframe 透明且不拦截鼠标或焦点。插件使用 DOM、Canvas、Web Animations 或 requestAnimationFrame 绘制。保持 `html/body` 透明，不铺不透明全屏背景；无操作时不持续刷新。禁用、卸载和窗口销毁会关闭视图。通过 `context.signal` 清理事件、计时器与动画；粒子和同时运行的动画必须有上限。


## 窗口样式

API 3 的宿主 `context.window.styles.set(id, css)` 注入普通 CSS，需要 `windowEffects`。同一插件的同名样式表原位替换，`remove(id)` 仅撤回自己的样式表；停用、崩溃、更新和卸载会清理全部注入样式。样式不持久化，激活时由插件恢复；主页面重载会停止插件宿主并撤回样式，重新激活后可再次注入。

CSS 作用于整个应用文档，支持选择器、变量、伪元素、动画、媒体查询和其他浏览器支持的 CSS；不限定为工作台、背景或某一组属性。宿主不向插件开放父页面 DOM 或脚本执行。已有区域提供稳定的 `[data-lexora-region="window"]`、`app.sidebar`、`workbench.sidebar`、`workbench.workspace`、`workbench.pane`、`task.history` 和 `composer.input` 标识。跨插件按插件 ID、样式表 ID 升序放置，之后遵循标准 CSS 层叠规则。

窗口根节点的 `data-lexora-page` 与 `page.id` 一致：任务为 `lexora.tasks`，自动化为 `lexora.automations`，伙伴为 `lexora.buddies`，插件管理为 `lexora.extensions`，设置为 `lexora.settings`。插件自有页面为 `extension:<插件 ID>`；其 iframe 内部样式由插件自身管理。

`data-theme-surface` 标记可定制的宿主表面，输入框等嵌套部件的标记位于实际绘制底色的节点。值为 `layout`（页面布局和侧栏）、`header`（区域标题栏）、`panel`（内容卡片和设置分组）、`input`（任务和自动化提示词输入框）。标记本身不修改外观，插件可按类别选择透明化、边框等效果，或用以下语义 class 选取、排除具体部件：

| 部件 | 稳定 class |
| --- | --- |
| 任务标题、输入框 | `desktop-chat-workspace-header`、`desktop-chat-composer` |
| 自动化列表、编辑页 | `desktop-automation-workbench`、`desktop-automation-editor`；各自的 `__header`、`__content` |
| 伙伴侧栏、资料页 | `desktop-buddies-sidebar`、`desktop-buddy-profile`；各自的 `__header` |
| 伙伴资料卡片、设置区 | `buddy-profile-card`、`buddy-settings-section` |
| 插件管理页 | `desktop-extension-workbench` 及其 `__header`、`__content` |
| 已安装、不可用、市场插件卡片 | `extension-card`、`extension-unavailable-card`、`extension-catalog-card` |
| 设置侧栏、设置页 | `desktop-settings-sidebar`、`desktop-settings-page`；各自的 `__header` |
| 设置分组 | `desktop-settings-group`；登记的分组另有 `data-settings-group` |

例如 `[data-lexora-page="lexora.tasks"] [data-theme-surface]:not([data-theme-surface="input"])` 可选择任务页表面并保留输入框底色；`:not(.desktop-settings-group)` 可排除设置分组。表格之外的内部 DOM 层级与原子 class 不作为稳定接口。

`context.resources.getUrl({id})` 返回本插件私有文件或已授权本地文件的 URL；`getUrl({packagePath})` 返回已验证的包内资源 URL。视图也支持这两种形式。无需再次选图审批，不接受任意本机路径；URL 只在当前宿主 generation 有效，停用后失效，资源释放后不能再读取。资源 URL 可用于 CSS 图片、字体或包内样式表，不应保存进插件数据；每次激活重新取得。窗口的 CSP 继续限制网络和脚本。

```ts
const image = await context.resources.getUrl(file)
await context.window.styles.set('appearance', `
  [data-lexora-region="task.history"] {
    border: 1px solid var(--buddy-accent);
    background: url(${JSON.stringify(image)}) center / cover;
  }
  @media (width < 800px) {
    [data-lexora-region="task.history"] { border-width: 0; }
  }
`)
await context.window.styles.remove('appearance')
```

窗口样式不会修改主题选择或主题数据；CSS 可以覆盖主题的视觉输出，撤回后按正常层叠恢复。作者也可使用主题入口，或把主题和窗口样式组合使用。需要交互的按钮和面板继续通过视图、挂载与交互区域能力接入。
