# 视图、挂载与页面上下文

## 视图类型

| location | resource | 行为 |
| --- | --- | --- |
| `page` | `none` | 独立页面，可作为导航入口 |
| `context` | `selected-file`、`none` 或 API 4 的 `optional-file` | 工作区资源页签，由用户打开 |
| `window-overlay` | `none` | 启用后自动挂载的透明窗口效果，每插件最多一个；无法点击或聚焦 |

页面与小视图由插件绘制，均使用 `render(context, container)`，共用隔离和通信 API。API 2 起将视图内容与挂载位置分开，通过 `contributes.placements` 选择正式扩展点；`page` 和 `window-overlay` 继续可用。插件不能查询或修改宿主 DOM。

所有视图的 `container` 默认填满隔离视口，无内边距，根元素与子元素使用 `border-box`，支持 `w-full`、`h-full` 和百分比高度。页面、插槽、控件和挂载面板使用相同盒模型，插件自行提供间距；宿主不为插件内部的 `main` 等语义元素增加样式。页面内容超出视口时可正常滚动；需要内部滚动时由插件明确设置自身滚动区域。装饰的绘制范围受锚点及祖先裁剪约束，装饰视口不滚动。

导航入口位于自动化下方，声明 `contributes.navigation: { "title": "插件名称", "view": "<plugin-id>.settings" }`，引用一个 `resource: "none"` 的视图（API 1 仍需 `location: "page"`）。不需要设置页的效果插件可以没有导航。

导航页面、装饰、内容插槽和替换控件不能使用 `context.setState()`；需要持久设置时声明宿主入口和隐藏命令，以 `context.storage.get/set` 保存。多个视图使用同一设置时明确刷新时机，插件局部开关必须能在不重载视图的情况下关闭并重新启用。资源页签的 `setState` 用于保存该页签的 JSON 状态。

交互视图可用 `context.setDocumentInfo({title,dirty})` 更新自己的文档名称与未保存标记。标题去除首尾空白后为 1–256 个字符。资源页签随布局持久化，导航页面只保留当前会话的信息；不会更改文件内容、授予保存权限或代替 `onBeforeClose`。插件应在打开、重命名、编辑、保存和返回管理页时同步自己的真实状态，恢复文档后再次核对标记。

系统剪贴板使用独立的 `permissions.clipboardRead` 与 `permissions.clipboardWrite` 授权，默认均为 `false`。交互视图用 `context.clipboard.read()` 读取 `{text?,html?}`，用 `context.clipboard.write({text?,html?})` 原子替换这些格式；至少传一项，空字符串有效，文本与 HTML 的 UTF-8 总量最多 4 MiB。HTML 内容与属性保留，不传递图片、文件路径或其他原生格式。没有支持的格式时读取返回 `{}`；过大内容或失败操作会拒绝 Promise。

剪贴板调用要求安装授权及当前前台窗口中可见、聚焦的插件 iframe；读取交付前和写入前均复验视图身份与焦点。此授权不是逐次用户手势检查：已聚焦的插件可主动调用，用户无需每次确认。失焦、隐藏、关闭或插件停用后不可调用；后台入口、Worker、装饰、内容插槽和替换控件不提供此能力。纯视图插件无需后台入口。iframe 的浏览器 `navigator.clipboard` 权限仍被禁止，编辑器应注入此 SDK 适配器；浏览器原生 `paste` 事件的 `clipboardData` 与异步剪贴板 API 是不同路径。

这两项增量 API 应先检查 `typeof context.setDocumentInfo === 'function'` 和 `context.clipboard`，缺失时提示升级宿主；清单兼容范围使用实际支持此能力的宿主版本。


## 正式挂载点

`placements` 中的 `view` 引用本插件的 `resource: "none"` 视图定义，省略 `location`（默认 `context`）。每种挂载均使用独立的隔离视图实例。

| kind | 必填字段 | 行为 |
| --- | --- | --- |
| `decoration` | `anchor` | 通过 `lexora_plugin_capabilities({kind:"decoration"})` 查询背景与装饰区域；每个锚点实例分别挂载，只在该区域内绘制，不接收指针和焦点；需要 `windowEffects` |
| `view` | `target` | 用 `lexora_plugin_capabilities({kind:"mount"})` 查询目标；`presentation` 描述区域内布局，宿主入口调用 `context.placements.show(id, instanceId?)` / `hide(id, instanceId?)` |
| `control` | `target` | 当前支持 `model.reasoning`；由插件自身配置启停，运行规则见 [内容插槽与替换控件](slots.md) |
| `slot` | `target` | 需要将 `apiVersion` 设为 3；由插件自身配置启停，目标、尺寸和默认内容回退见 [内容插槽](slots.md) |

挂载口只提供容器，不提供面板外壳或交互。声明示意：`{id,view,kind:"view",target:"workbench",presentation:{position:"absolute",width:420,height:180,right:16,bottom:16}}`。目标所属范围由能力目录返回。API 3 的分屏挂载以 `instanceId` 区分实例；从命令 `invocation.instanceId` 传入发起操作的分屏，不要在异步完成后重新选择焦点。省略时使用调用时的活动分屏，标识失效则拒绝打开。每个分屏分别保存状态，分屏移除时结束该实例。挂载口暂时不可用时保留实例，恢复后继续投影。插件自行渲染全部内容、样式与交互；插件之间保留独立实例，宿主不生成切换器、不自动避让或折叠。

`presentation` 是隔离视图外框的布局声明：`position` 为 `static`（默认，正常布局）或 `absolute`（相对挂载口）；`order` 为 -1000 至 1000（默认 1，与核心内容的 0 比较）；`zIndex` 为 0–20 的扩展层内顺序，不覆盖核心弹窗。`width/height/top/right/bottom/left` 使用 0–8192 的像素数或 0%–100% 字符串；`null` 清除该 CSS 值。未指定尺寸时宽度 100%、高度 56px，最大尺寸及可见内容受目标容器边界约束。内容内部自由使用 DOM/CSS、Canvas 等；不访问父页面 DOM。

`context.setPresentation({...})` 合并更新上述字段，传 `target` 可转移挂载口。进入分屏区域要求该视图在创建时已绑定分屏，不会把全局实例隐式移入当前焦点分屏。实例、会话与状态保留；插件的定时器、媒体等不会因为换位置而重建。布局值由宿主持久化，业务状态由插件自己保存。`context.mount` / `onMountChange` 提供目标容器宽高、可见性和当前视图的局部矩形，供插件响应尺寸变化或实现拖动等交互，不包含屏幕坐标、其他插件信息或父 DOM。

宿主不认识“折叠”“展开”“贴边”或“播放器”。需要这些效果时，插件自己渲染触发入口、控制布局并保存自己的状态。缩小视图外框不销毁内容；普通挂载调用宿主命令中的 `placements.hide` 才关闭实例。插件负责再次打开的入口，可以使用自己的可见 UI、已声明命令或导航。不要依赖宿主替插件提供关闭栏或恢复按钮。

旧版 `location: workbench.top/workbench.bottom` 与 `height` 在读取时转换为工作台的 static/-1 或 static/1，旧悬浮声明转换为 absolute。新源码使用 target/presentation，不增加业务专用 location。`control.height` 仍为 32–160，默认 64。

挂载点 `id` 是升级和恢复的稳定身份，更新时不要随意改名。同一 `id` 调整挂载位置或更换视图定义后，宿主保留实例及旧状态；需要转换状态时，比较 `stateVersion` 与 `expectedStateVersion` 并调用 `setState` 保存转换结果。移除贡献或禁用插件不会清空已保存的视图状态。

控件通过 `context.control.snapshot` 读取 `{revision,value,options,disabled}`，`onChange` 订阅变化。`options` 是宿主允许的值及标签；插件不获取模型或任务身份，也不直接写入业务状态。提交用户选择使用 `control.propose(value, renderedSnapshot.revision)`；宿主拒绝旧版本、不可用值、禁用或隐藏控件的请求，窗口隐藏时也不能提交。请求失败后读取最新快照重新呈现，不重试旧选择。加载失败、失去响应、禁用或缺失时恢复内置控件，保留用户样式选择。关闭再打开弹层不会重试失败控件；用户重新选择样式或重启插件后才恢复加载。

组合视图可用导航页管理设置、挂载面板展示持续内容、隐藏命令连接私有存储。设置更新后的刷新时机由插件明确处理，页面之间没有隐式共享 JS 状态。


## 页面上下文与生效条件

视图通过 `context.workbench` 读取只读快照：`values` 是公开语义上下文，`pages` 列出已登记页面的稳定 `id/title`。`onWorkbenchChange` 订阅变化。当前 `page.id` 使用 `lexora.tasks`、`lexora.automations`、`lexora.extensions`、`lexora.settings` 或 `extension:<插件ID>`；自动化和设置通过 `page.section` 提供子页标识，如 `plans`、`history`、`general`、`models`。其他页面不保留上一个页面的 section。未来页面通过登记扩展，不以名称、URL 或 DOM 选择器识别。这里不提供任务正文、输入内容、文件路径、路由参数或 Provider/模型身份。

`contributes.views`、`placements`、`commands`、`menus` 和 `navigation` 可声明可选的 `when`。例如 `"when": {"page.id": ["lexora.tasks", "lexora.automations"]}`；对象中的不同 key 为 AND，数组内为 OR，标量严格相等，缺失 key 不匹配。空对象或省略表示不限定，不执行表达式代码。最多 32 个 key，每个数组最多 32 项，值限字符串（256 字符）、布尔和有限数字。视图定义与挂载的条件同时满足才显示。只限定某个挂载实例时优先在 placement 声明；view 的条件影响该定义的所有实例，navigation 的条件只限定入口。

条件只控制 UI 的可用性，不授予权限、不启动插件，也不阻止插件自身调用命令或后台调度。命令菜单与导航入口随上下文更新。首次不满足条件的视图不激活；已打开视图离开范围时隐藏，挂载面板退出布局占位，实例、状态与会话保留，返回后恢复。控件不匹配时使用内置控件并拒绝旧提交。普通挂载的 `placements.hide` 仍表示关闭实例；slot/control 的运行期启停和视图 active 状态见 [内容插槽](slots.md)。

`context.visible/onVisibilityChange` 表达当前视图实际可见性（包含页面范围、区域隐藏和窗口隐藏）。插件自行决定隐藏时暂停动画、查询或媒体，宿主不推断业务行为。订阅随视图销毁自动释放；插件也可提前调用返回对象的 `dispose()`。受范围限制的功能应验收首次不匹配、进入、离开、返回、子页切换和重启后的条件恢复。
