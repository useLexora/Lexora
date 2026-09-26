# Lexora 插件协议

一个包包含根 `extension.json` 和包内文件。源码包支持自包含 `.ts`、`.mts`、`.js`、`.mjs`，以及静态 CSS、图片等资源；原始 HTML、Vue 单文件组件、npm 裸导入不属于当前编译协议。第三方库需作者预先打包。不要生成 `package.json`、锁文件、构建脚本、`node_modules` 或远程 CDN 依赖。

## 清单

清单结构如下；按需求补齐 `contributes`、入口和权限，空清单只是结构说明，不能作为成品交付。能力组合见 [能力选择](capabilities.md)。

```json
{
  "schemaVersion": 1,
  "format": "source",
  "id": "local.my-plugin",
  "name": "插件名称",
  "description": "插件完成的用户行为。",
  "version": "1.0.0",
  "apiVersion": 2,
  "engines": { "lexora": ">=0.8.7 <1.0.0" },
  "permissions": {},
  "contributes": {}
}
```

可选字段：`icon`（包内 SVG/PNG/JPEG/WebP，≤64 KiB）、`categories`、`tags`、宿主 `entry`、`dataVersion`。不要添加未定义的字段。命令、视图和挂载声明的 ID 以插件 ID 加 `.` 开头且不重复。文件路径相对包根，不能包含 `..` 或符号链接；512 文件、单文件 4 MiB、合计 16 MiB 上限。

`contributes` 内的声明结构如下。省略不用的项；每项权限和运行方式见后文，无需查找应用实现或复制某个示例清单。

| 字段 | 结构 |
| --- | --- |
| `commands` | 数组，每项必填 `id`、`title`；`hidden` 可选，默认 false；API 3 可声明 `slash: {name, description?}`，规则见 [注册命令](commands.md)。存在命令时必须设置清单顶层的宿主 `entry` |
| `menus` | API 3；数组，每项必填 `id`、`command`、`target`，可选 `order`（-1000 至 1000，默认 0）、`when`；引用自己的已声明命令 |
| `views` | 数组，每项必填 `id`、`title`、`entry`；`resource` 为 `selected-file`（默认）或 `none`；`location` 默认 `context`；`stateVersion` 为正整数，默认 1 |
| `placements` | 数组，每项必填 `id`、`view`、`kind`，并按 kind 添加后文规定的 `anchor`、`target` 或 `presentation`；不要把它们写入视图定义 |
| `navigation` | 单个对象，必填 `title`、`view`，引用自己的无资源视图 |

插件 ID 使用小写字母开头的两段名称，中间以 `.` 分隔，每段可含小写字母、数字与 `-`；贡献 ID 在插件 ID 后追加由小写字母、数字、`.`、`-` 组成的后缀。声明文件路径使用包内相对路径，`.ts` 文件名直接指向源码，编译工具负责产出运行文件。

## 视图类型

| location | resource | 行为 |
| --- | --- | --- |
| `page` | `none` | 独立页面，可作为导航入口 |
| `context` | `selected-file` 或 `none` | 工作区资源页签，由用户打开 |
| `window-overlay` | `none` | 启用后自动挂载的透明窗口效果，每插件最多一个；无法点击或聚焦 |

页面与小视图由插件绘制，均使用 `render(context, container)`，共用隔离和通信 API。API 2 起将视图内容与挂载位置分开，通过 `contributes.placements` 选择正式扩展点；`page` 和 `window-overlay` 继续可用。插件不能查询或修改宿主 DOM。

装饰、替换控件和普通挂载面板的 `container` 默认填满隔离视图，无内边距，支持子元素使用百分比高度。装饰的绘制范围仍受锚点及祖先裁剪约束；页面保持普通文档流，可按内容滚动。

导航入口位于自动化下方，声明 `contributes.navigation: { "title": "插件名称", "view": "local.plugin.settings" }`，引用一个 `resource: "none"` 的视图（API 1 仍需 `location: "page"`）。不需要设置页的效果插件可以没有导航。

导航页面、装饰、内容插槽和替换控件不能使用 `context.setState()`；需要持久设置时声明宿主入口和隐藏命令，以 `context.storage.get/set` 保存。多个视图使用同一设置时明确刷新时机，插件局部开关必须能在不重载视图的情况下关闭并重新启用。资源页签的 `setState` 用于保存该页签的 JSON 状态。

## 权限

| permissions 字段 | 能力 |
| --- | --- |
| `windowEffects: true` | 锚点装饰、窗口效果与无内容的对话输入活动 |
| `controls: ["model.reasoning"]` | 提供可由用户选用的思考等级控件 |
| `notifications: true` | 宿主 `context.notifications.show({title,body})` |
| `schedules: true` | 宿主持久间隔任务，需要宿主入口与已声明命令 |
| `selectedResource: "read"` | 读取用户选择并明确分配的文件资源 |
| `selectedContent: true` | API 3；用户点击插件操作时获取当前草稿或该条消息文本，不订阅输入或读取对话历史 |
| `localResources: true` | 用户通过系统窗口选择文件或目录，视图读取文本、二进制或受控 URL |
| `resourceExport: true` | 用户通过系统另存为窗口确认目标后，保存插件提供的字节 |
| `network: ["https://example.com"]` | 通过宿主向列出的 HTTPS origin 发 GET 请求 |

未声明权限默认为关闭。视图无法访问 Node、宿主 DOM、全局键盘、网络 fetch 或任意本地文件。资源和网络调用通过 API；用户在安装确认中查看权限。没有一般性消息订阅、系统剪贴板或屏幕截图接口。

## 窗口效果

视图入口形式为 `export function render(context: ViewContext, container: HTMLElement)`，类型使用 `import type { ViewContext } from './lexora'`。在 `render` 内调用 `context.onActivity(listener)`，在自己的 `container` 内绘制实际效果。输入锚点事件为 `{type:"composer-input", caret:{x,y,width,height}|null}`，坐标相对当前锚点。

`context.anchor` 和 `onAnchorChange` 提供 `{kind,visible,width,height}`，不包含屏幕坐标。呈现范围与事件来源按下表选择，不能因输入触发就默认选输入框装饰：

| 呈现范围 | 声明 | 活动与坐标 |
| --- | --- | --- |
| 输入框内部 | `kind: "decoration"`、`anchor: "composer.input"` | 只接收该输入框活动，caret 相对输入框，绘制裁剪在输入框内 |
| 整个输入所在分屏 | `kind: "decoration"`、`anchor: "workbench.pane"` | 每个分屏独立实例，只接收自己内部的对话输入活动，caret 相对该分屏；可以覆盖对话区域，不能越过分屏边界 |
| 整个 Lexora 窗口 | 视图 `location: "window-overlay"` | API 1、API 2 均只收到 `{type:"composer-input"}`，不含来源分屏与坐标；插件自行选择窗口内的位置 |

分屏装饰随分屏创建、改变尺寸和关闭；页面隐藏时保留实例并更新可见性。事件绑定输入发生的分屏，不随之后的焦点切换转交其他分屏；插件无需读取任务或分屏 ID。多个分屏及多个插件的实例各自隔离。此锚点提供透明装饰区域，不提供交互面板外壳。

事件没有字符、按键、文本长度或任务 ID，最多约每秒 20 次，只来自前台 Lexora 对话输入框，包括输入法输入。宿主过滤程序性修改、其他输入框和减少动态效果模式。不要注册父窗口键盘事件。

宿主保持 iframe 透明且不拦截鼠标或焦点。插件使用 DOM、Canvas、Web Animations 或 requestAnimationFrame 绘制。保持 `html/body` 透明，不铺不透明全屏背景；无操作时不持续刷新。禁用、卸载和窗口销毁会关闭视图。通过 `context.signal` 清理事件、计时器与动画；粒子和同时运行的动画必须有上限。

## 正式挂载点

`placements` 中的 `view` 引用本插件的 `resource: "none"` 视图定义，省略 `location`（默认 `context`）。每种挂载均使用独立的隔离视图实例。

| kind | 必填字段 | 行为 |
| --- | --- | --- |
| `decoration` | `anchor` | 自动挂载至 `app.sidebar`、`workbench.sidebar`、`workbench.pane` 或 `composer.input`；每个锚点实例分别挂载，只在该区域内绘制，不接收指针和焦点 |
| `view` | `target` | 用 `lexora_plugin_capabilities({kind:"mount"})` 查询目标；`presentation` 描述区域内布局，宿主入口调用 `context.placements.show(id, instanceId?)` / `hide(id, instanceId?)` |
| `control` | `target` | 当前支持 `model.reasoning`；用户在插件管理页选择后才替换内置控件 |
| `slot` | `target` | 需要将 `apiVersion` 设为 3；用户在插件管理页选择后替换目标内容，具体目标和尺寸按需查 [内容插槽目录](slots.md) |

挂载口只提供容器，不提供面板外壳或交互。声明示意：`{id,view,kind:"view",target:"workbench",presentation:{position:"absolute",width:420,height:180,right:16,bottom:16}}`。目标所属范围由能力目录返回。API 3 的分屏挂载以 `instanceId` 区分实例；从命令 `invocation.instanceId` 传入发起操作的分屏，不要在异步完成后重新选择焦点。省略时使用调用时的活动分屏，标识失效则拒绝打开。每个分屏分别保存状态，分屏移除时结束该实例。挂载口暂时不可用时保留实例，恢复后继续投影。插件自行渲染全部内容、样式与交互；插件之间保留独立实例，宿主不生成切换器、不自动避让或折叠。

`presentation` 是隔离视图外框的布局声明：`position` 为 `static`（默认，正常布局）或 `absolute`（相对挂载口）；`order` 为 -1000 至 1000（默认 1，与核心内容的 0 比较）；`zIndex` 为 0–20 的扩展层内顺序，不覆盖核心弹窗。`width/height/top/right/bottom/left` 使用 0–8192 的像素数或 0%–100% 字符串；`null` 清除该 CSS 值。未指定尺寸时宽度 100%、高度 56px，最大尺寸及可见内容受目标容器边界约束。内容内部自由使用 DOM/CSS、Canvas 等；不访问父页面 DOM。

`context.setPresentation({...})` 合并更新上述字段，传 `target` 可转移挂载口。进入分屏区域要求该视图在创建时已绑定分屏，不会把全局实例隐式移入当前焦点分屏。实例、会话与状态保留；插件的定时器、媒体等不会因为换位置而重建。布局值由宿主持久化，业务状态由插件自己保存。`context.mount` / `onMountChange` 提供目标容器宽高、可见性和当前视图的局部矩形，供插件响应尺寸变化或实现拖动等交互，不包含屏幕坐标、其他插件信息或父 DOM。

宿主不认识“折叠”“展开”“贴边”或“播放器”。需要这些效果时，插件自己渲染触发入口、控制布局并保存自己的状态。缩小视图外框不销毁内容；调用宿主命令中的 `placements.hide` 才关闭实例。插件负责再次打开的入口，可以使用自己的可见 UI、已声明命令或导航。不要依赖宿主替插件提供关闭栏或恢复按钮。

旧版 `location: workbench.top/workbench.bottom` 与 `height` 在读取时转换为工作台的 static/-1 或 static/1，旧悬浮声明转换为 absolute。新源码使用 target/presentation，不增加业务专用 location。`control.height` 仍为 32–160，默认 64。

挂载点 `id` 是升级和恢复的稳定身份，更新时不要随意改名。同一 `id` 调整挂载位置或更换视图定义后，宿主保留实例及旧状态；需要转换状态时，比较 `stateVersion` 与 `expectedStateVersion` 并调用 `setState` 保存转换结果。移除贡献或禁用插件不会清空已保存的视图状态。

控件通过 `context.control.snapshot` 读取 `{revision,value,options,disabled}`，`onChange` 订阅变化。`options` 是宿主允许的值及标签；插件不获取模型或任务身份，也不直接写入业务状态。提交用户选择使用 `control.propose(value, renderedSnapshot.revision)`；宿主拒绝旧版本、不可用值、禁用或隐藏控件的请求，窗口隐藏时也不能提交。请求失败后读取最新快照重新呈现，不重试旧选择。加载失败、失去响应、禁用或缺失时恢复内置控件，保留用户样式选择。关闭再打开弹层不会重试失败控件；用户重新选择样式或重启插件后才恢复加载。

组合视图可用导航页管理设置、挂载面板展示持续内容、隐藏命令连接私有存储。设置更新后的刷新时机由插件明确处理，页面之间没有隐式共享 JS 状态。

## 操作菜单

API 3 的 `contributes.menus` 将已有命令放进业务区域的「更多操作」。先用 `lexora_plugin_capabilities({kind:"menu"})` 查询目标与输入契约，再声明 `{id,command,target,order?,when?}`。`hidden` 仅隐藏命令面板与管理卡片入口，不隐藏显式声明的菜单。

命令参数中的 `invocation` 包含 `target`、`instanceId`，仅在声明 `selectedContent` 且用户点击对应操作后附带 `content`。文件菜单通过原有 `selectedResource` 权限提供 `resource` 句柄。视图调用自己的命令时 `invocation.target` 为 `view`，只附带该视图的实例标识；命令面板和定时调用的 `invocation` 为空。

输入操作可返回 `{insertText:string}`。宿主在原草稿仍可编辑且内容未改变时，将结果作为纯文本插入原选择位置；更换草稿、编辑内容或关闭视图后忽略迟到结果，不自动发送。其他菜单忽略命令返回值。`when` 支持宿主公开上下文，消息菜单额外提供 `message.role`，文件菜单提供当前 `resource.scheme`；不能用条件读取未公开的数据。

## 页面上下文与生效条件

视图通过 `context.workbench` 读取只读快照：`values` 是公开语义上下文，`pages` 列出已登记页面的稳定 `id/title`。`onWorkbenchChange` 订阅变化。当前 `page.id` 使用 `lexora.tasks`、`lexora.automations`、`lexora.extensions`、`lexora.settings` 或 `extension:<插件ID>`；自动化和设置通过 `page.section` 提供子页标识，如 `plans`、`history`、`general`、`models`。其他页面不保留上一个页面的 section。未来页面通过登记扩展，不以名称、URL 或 DOM 选择器识别。这里不提供任务正文、输入内容、文件路径、路由参数或 Provider/模型身份。

`contributes.views`、`placements`、`commands`、`menus` 和 `navigation` 可声明可选的 `when`。例如 `"when": {"page.id": ["lexora.tasks", "lexora.automations"]}`；对象中的不同 key 为 AND，数组内为 OR，标量严格相等，缺失 key 不匹配。空对象或省略表示不限定，不执行表达式代码。最多 32 个 key，每个数组最多 32 项，值限字符串（256 字符）、布尔和有限数字。视图定义与挂载的条件同时满足才显示。只限定某个挂载实例时优先在 placement 声明；view 的条件影响该定义的所有实例，navigation 的条件只限定入口。

条件只控制 UI 的可用性，不授予权限、不启动插件，也不阻止插件自身调用命令或后台调度。命令菜单与导航入口随上下文更新。首次不满足条件的视图不激活；已打开视图离开范围时隐藏，挂载面板退出布局占位，实例、状态与会话保留，返回后恢复。控件不匹配时使用内置控件并拒绝旧提交。`placements.hide` 仍表示关闭实例，与条件隐藏不同。

`context.visible/onVisibilityChange` 表达当前视图实际可见性（包含页面范围、区域隐藏和窗口隐藏）。插件自行决定隐藏时暂停动画、查询或媒体，宿主不推断业务行为。订阅随视图销毁自动释放；插件也可提前调用返回对象的 `dispose()`。受范围限制的功能应验收首次不匹配、进入、离开、返回、子页切换和重启后的条件恢复。

## 本地资源与导出

资源授权与文件格式无关。宿主不限制业务格式，不解析文档或工程文件；插件负责解析、显示和编辑。`mimeType` 是根据扩展名给出的提示，未知格式为 `application/octet-stream`，不是授权白名单。文件选择的 `filters: [{name,extensions}]` 与目录扫描的 `extensions` 由插件按需求提供；省略筛选即接受所有格式。

声明 `localResources: true` 后，在可见的交互视图中响应用户操作调用 `resources.pickFiles({filters?,multiple?})` 或 `resources.pickDirectory()`。取消分别返回 `[]` 和 `null`。宿主只接受系统窗口确认的路径，插件不能提交或取得绝对路径。文件句柄为 `{id,name,mimeType,size,relativePath?}`，目录句柄为 `{id,name}`；单次最多选择 100 个文件，单文件不超过 2 GiB，每插件最多 1000 个文件句柄和 32 个目录。

`resources.listFiles/listDirectories` 返回已有授权。`scanDirectory(directory,{extensions?,recursive?})` 返回授权根内的文件句柄及相对路径，默认递归，跳过符号链接，限制 10000 项与 16 层；超限明确报错，不静默截断。扫描负责刷新相同筛选范围，保留其他筛选范围的句柄；它不是自动监听。文件删除或变化后，刷新撤销旧句柄，变化的文件返回新 ID。独立选择和不同目录的授权分别管理。目录内引用可以根据返回的 `relativePath` 解析，但不能越过授权根。

按内容选择读取方式：

- `resources.readText(file)`：UTF-8 文本，最多 1 MiB；更大文本或其他编码使用分段读取与插件自己的解码器。
- `resources.readBytes(file,{offset?,length?})`：返回 `{data:Uint8Array,size,eof}`；默认 64 KiB，单次最多 128 KiB，适合二进制解析、增量加载和自定义格式。
- `resources.getUrl(file)`：当前视图专用 URL，可供图片、音视频等元素或视图内 fetch 读取；支持 HEAD、Range 和 seek。只保存资源 ID，每次视图创建后重新取得 URL。不可作为脚本、样式或新页面执行。

授权跨重启保留；文件被移动、替换或修改后旧句柄读取失败，可重新选择或刷新已授权目录。`revokeFile(file)` 撤销单个句柄，保留的目录授权仍允许下次扫描重新发现它；`revokeDirectory(directory)` 撤销该目录及其派生句柄，其他独立授权保留。用户可从插件管理撤销全部本地资源授权，卸载也撤销。撤销、禁用及视图关闭会使相关 URL 和未完成的读取失效，不删除用户原文件。

保存另行声明 `resourceExport: true`。`resources.saveFile({name,data})` 接收建议文件名和 `Blob | ArrayBuffer | Uint8Array`，弹出系统另存为窗口；取消返回 false，完整写入后返回 true，失败抛错。目标由用户决定，插件得不到路径。写入先暂存，提交时验证目标未被其他程序修改，再替换；关闭、禁用、取消或未完整提交不会覆盖原文件。读取授权不包含静默写回或目录批量写入。

包内静态资源使用 `new URL('./assets/file.ext', import.meta.url).href`，遵循包大小上限。音视频支持流式读取和 seek，具体解码能力取决于运行平台；复杂格式可使用包内自包含 JS 解析器。通用文件通道不等于内置任意格式解码器、原生模块或外部可执行程序支持。

验收实际读取、解析、保存结果和取消路径。涉及音视频时验证 metadata、实际进度与 seek；关闭时停止工作、清除 URL 和定时器。交互期间保存进度，销毁后不得再异步回写状态。

## 页面、宿主与设置

完整类型见同目录 `api.d.ts`。每个视图是独立沙箱。`render` 可异步，前台加载须在 10 秒内完成；耗时内容先绘制加载状态，再异步填充。加载失败会结束该视图并提供重启入口，其他视图与宿主继续运行。没有 `mount`、全局 `lexora` 或 Vue 运行时。

宿主入口示意：

```ts
import type { ExtensionContext } from './lexora'

export function activate(context: ExtensionContext) {
  context.subscriptions.add(context.commands.register('local.example.read-settings', async () => context.storage.get()))
}
```

该命令须出现在 `contributes.commands` 中，例如 `{ "id":"local.example.read-settings", "title":"读取设置", "hidden":true }`。视图通过 `context.commands.execute(command, arguments)` 调用自身命令，返回 JSON。私有数据使用 JSON；更改结构时递增 `dataVersion` 并导出 `migrate(previous, from, to)`。

文件工具需要一个可见命令作为打开入口。用户先在文件面板打开文件，再从命令面板执行它；宿主将收到的资源句柄传入视图：

```ts
context.subscriptions.add(context.commands.register('local.example.open', async ({ resource }) => {
  if (!resource)
    throw new Error('请先打开一个文件')
  await context.views.open('local.example.reader', { resource, state: {} })
}))
```

该视图声明 `resource: "selected-file"`，插件声明 `selectedResource: "read"`；视图从 `context.resource` 取得同一资源，通过 `resources.readText` 读取。句柄不是文件路径。只声明视图不会自动增加文件菜单或命令入口。

后台提醒使用 `context.schedules.set({ id, command, enabled, intervalMinutes })`，间隔最少 1 分钟；不要用页面 setInterval 代替跨页面提醒。Lexora 退出后暂停，重启继续，错过的提醒不会补发。

## 主题与样式

直接创建元素、设置样式，或引入包内 CSS：`link.href = new URL('./style.css', import.meta.url).href`。使用 `--lexora-background`、`--lexora-text`、`--lexora-muted`、`--lexora-border`、`--lexora-accent`、`--lexora-accent-solid`。`context.environment` 提供语言、配色与颜色；`context.onEnvironmentChange` 订阅切换。效果应柔和短暂，不遮挡正文或确认操作。

临时覆盖层、分屏布局订阅与局部点击区域见 [交互会话](interactions.md)。
