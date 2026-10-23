# Lexora 插件协议

一个包包含根 `extension.json` 和包内文件。源码包支持自包含 `.ts`、`.mts`、`.js`、`.mjs`，以及静态 CSS、图片等资源；原始 HTML、Vue 单文件组件、npm 裸导入不属于当前编译协议。第三方库需作者预先打包。不要生成 `package.json`、锁文件、构建脚本、`node_modules` 或远程 CDN 依赖。

## 清单

清单结构如下；按需求补齐 `contributes`、入口和权限，空清单只是结构说明，不能作为成品交付。能力组合见 [能力选择](capabilities.md)。

```json
{
  "schemaVersion": 1,
  "format": "source",
  "id": "<plugin-id>",
  "name": "插件名称",
  "author": "作者署名",
  "description": "插件完成的用户行为。",
  "version": "1.0.0",
  "apiVersion": 3,
  "engines": { "lexora": ">=0.9.0 <1.0.0" },
  "permissions": {},
  "contributes": {}
}
```

`<plugin-id>` 是占位符，填写时必须替换为新插件身份工具返回的 ID，或正在维护的源码清单中的既有 ID；后续声明中的占位符同样替换。宿主代码通过 `context.extension.id` 引用当前插件，不复制示例身份。作者署名 `author` 可选，支持 Unicode，最多 80 个用户可见字符，不含换行或控制字符；留空表示未署名。不符合规则时说明原因，给出候选并通过对话确定，不静默截断或替换。作者与显示名可变，ID 和末尾的调用名保持稳定。使用作者字段的包要求 Lexora 0.9.0 或更新版本。

可选字段：`author`、`icon`（包内 SVG/PNG/JPEG/WebP，≤64 KiB）、`categories`、`tags`、宿主 `entry`、`dataVersion`。不要添加未定义的字段。命令、视图和挂载声明的 ID 以插件 ID 加 `.` 开头且不重复。文件路径相对包根，不能包含 `..` 或符号链接；最多 4096 个文件，其中非图片文件最多 512 个，单文件 4 MiB、合计 16 MiB 上限。

`contributes` 内的声明结构如下。省略不用的项；每项权限和运行方式见后文，无需查找应用实现或复制某个示例清单。

| 字段 | 结构 |
| --- | --- |
| `commands` | 数组，每项必填 `id`、`title`；`hidden` 可选，默认 false；API 3 可声明 `slash: {name, description?}`，规则见 [注册命令](commands.md)。存在命令时必须设置清单顶层的宿主 `entry` |
| `menus` | API 3；数组，每项必填 `id`、`command`、`target`，可选 `order`（-1000 至 1000，默认 0）、`when`；引用自己的已声明命令 |
| `views` | 数组，每项必填 `id`、`title`、`entry`；`resource` 为 `selected-file`（默认）、`none`，或 API 4 的 `optional-file`；`location` 默认 `context`；`stateVersion` 为正整数，默认 1 |
| `placements` | 数组，每项必填 `id`、`view`、`kind`，并按 kind 添加后文规定的 `anchor`、`target` 或 `presentation`；不要把它们写入视图定义 |
| `navigation` | 单个对象，必填 `title`、`view`，引用自己的无资源视图 |
| `fileHandlers` | API 4；数组，每项必填 `id`、`title`、`extensions`；`preview`、`open` 至少提供一个，各含 `view` 和可选 `requestDefault`（默认 `true`）；见下文 |
| `launchers` | API 4；数组，每项必填 `id`、`title`、`view`，提供无需文件的独立入口 |
| `agent` | API 3；指令、工具、任务动作和可选的 enabledWhen，见 [Agent 与设置](agent-settings.md) |
| `settings` | API 3；声明 modules/groups/items，由宿主渲染并保存，见 [Agent 与设置](agent-settings.md) |
| `shells` | API 4；固定本机解释器候选与原生设置映射；可选 settingsGroup 将插件自有组渲染为一行一个 Shell 的原生表格，文件选择仅限原生设置，需独立 shells 权限，见 [命令解释器](shells.md) |

插件 ID 使用小写字母开头的两段名称，中间以 `.` 分隔，每段可含小写字母、数字与 `-`；贡献 ID 在插件 ID 后追加由小写字母、数字、`.`、`-` 组成的后缀。声明文件路径使用包内相对路径，`.ts` 文件名直接指向源码，编译工具负责产出运行文件。

## 引用到对话

API 4 的交互资源视图可声明 `permissions.references: true`，通过 `context.references.add(input)` 打开宿主的对话选择器。导航页面、装饰、插槽与替换控件不支持此能力。选择并成功加入草稿返回 `true`，取消返回 `false`；授权或资源失效会抛错。等待用户选择没有固定的十秒期限；关闭视图或停用插件会取消请求。此操作不会发送消息或调用模型。

```ts
await context.references.add({
  kind: 'content',
  title: '汇总表',
  text: selectedText,
  locator: { version: 1, data: { sheet: 'Summary', cells: 'A1:B2' } },
})

context.references.onReveal(async ({ locator, text }, signal) => {
  if (!locator || locator.version !== 1)
    return false
  return revealCells(locator.data, { expectedText: text, signal })
})
```

`content` 保存当时的文字快照；`text` 必须非空，文字与序列化 locator 合计最多 32768 个字符，`title` 最多 512 字符。来源由宿主生成，插件不能自报来源或文件路径。`locator` 可省略，是插件定义的只读 JSON，含正整数 `version` 和 `data`；数据最多 16 KiB、12 层，不允许函数、循环或特殊对象。宿主只负责传回，插件负责版本兼容和验证定位结果，不能把 locator 当作文件授权。文字会进入模型上下文，locator 与内部目标不会。

每个视图用 `references.onReveal(handler)` 注册一个定位处理器，返回可 `dispose()` 的注册对象。处理器收到只读的 `referenceId`、原始 `text`、`locator`（未提供时为 `null`）和取消信号；确认内容已定位后返回 `true`。无法找到、版本不支持、未注册或抛错均视为定位失败。异步处理必须遵守 `signal`，避免用户取消后继续滚动或改动界面。

定位优先复用原视图并重新检查资源授权，不重载有效会话。内联预览保留当前未保存快照；原视图已关闭时，只能重新打开现有来源，插件应验证 locator 与当前内容是否匹配。插件停用或来源不可访问时，已保存的引用文字仍可查看。

整份文件使用 `references.add({ kind: 'resource', resource })`，传入 `context.resource` 或本插件已有的授权句柄。Space 来源沿用文件引用，临时快照、产物和其他已授权资源按内容复制为附件；不传路径，不扩大读取权限。读取所需的 `selectedResource` / `localResources` 权限仍需分别声明。使用这些新增 API 4 能力时，`engines.lexora` 的最低版本应覆盖实际支持该能力的宿主。

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

## 文件关联与独立入口

使用下列新增声明时，`apiVersion` 保持 `4`，`engines.lexora` 必须以首次提供这些能力的应用版本为下限；不能仅凭旧宿主也支持 API 4 就声明兼容。应用版本和 API 版本分别约束能力可用性与协议兼容性。

`contributes.fileHandlers` 声明文件处理器，每项具有稳定的 `id`、显示名称 `title` 和精确的小写带点后缀 `extensions`，例如 `[".md", ".markdown"]`。不接受通配符、MIME 推断或没有点的后缀；每项最多 64 个后缀、共 32 项。两种打开方式分别保存用户默认；多个已注册复合后缀匹配时采用最长者。

- `preview: { view, requestDefault? }`：在文件页内预览。
- `open: { view, requestDefault? }`：在独立工作台视图中打开文件。

至少声明一种方式；省略的方式不注册，也不借用另一种方式的视图。两者可引用同一个视图或不同视图；视图必须属于本插件、`location` 为 `context`，资源模式为 `selected-file` 或 `optional-file`，并声明 `selectedResource: "read"`。宿主传递文件资源与管理视图生命周期，插件自行决定界面内容。

每种方式的 `requestDefault` 缺省为 `true`，安装确认页预勾选对应关联；设置为 `false` 时不预选，用户仍可主动勾选。该字段不影响文件权限或撤销已有默认。确认安装应用最终选择，更新的关联在新版本生效时应用。相同后缀和方式有多个处理器时，优先保留本插件中已经作为默认的处理器，否则按声明顺序预选第一个申请者。停用、失败、卸载时保留偏好，只回退内置处理器，不自动选择其他第三方。

`contributes.launchers` 提供“+”启动入口（最多16项），引用本插件的 `context` 视图，资源模式为 `none` 或 `optional-file`。启动时 `context.resource` 为 `null`；文件打开则传入文件资源。两个入口独立引用视图，文件打开无需注册或调用 launcher。

共用同一视图时，让视图接受可选文件并处理有文件、无文件两种状态：

```json
{
  "apiVersion": 4,
  "permissions": { "selectedResource": "read" },
  "contributes": {
    "views": [{ "id": "<plugin-id>.reader", "title": "阅读器", "entry": "view.ts", "resource": "optional-file" }],
    "fileHandlers": [{ "id": "<plugin-id>.files", "title": "阅读器", "extensions": [".md"], "preview": { "view": "<plugin-id>.reader" }, "open": { "view": "<plugin-id>.reader" } }],
    "launchers": [{ "id": "<plugin-id>.start", "title": "阅读器", "view": "<plugin-id>.reader" }]
  }
}
```

分别呈现时，新增 `selected-file` 视图，并让 `preview` 引用它；原视图仍用于启动和独立打开：

```json
{
  "views": [
    { "id": "<plugin-id>.preview", "title": "文件预览", "entry": "preview.ts", "resource": "selected-file" },
    { "id": "<plugin-id>.reader", "title": "阅读器", "entry": "view.ts", "resource": "optional-file" }
  ],
  "fileHandlers": [{ "id": "<plugin-id>.files", "title": "阅读器", "extensions": [".md"], "preview": { "view": "<plugin-id>.preview", "requestDefault": false }, "open": { "view": "<plugin-id>.reader" } }],
  "launchers": [{ "id": "<plugin-id>.start", "title": "阅读器", "view": "<plugin-id>.reader" }]
}
```

只提供文件处理时，省略 `launchers` 即可；文件视图可使用 `selected-file`。只做预览则再省略处理器的 `open`。

旧 `fileOpeners` 声明仍受支持：其 `locations` 中的 `inline`、`standalone` 分别对应新结构的 `preview`、`open`，使用原 `view` 和 `requestDefault`。更新为新声明时保留处理器 ID，即可延续用户默认关联；同一 ID 不能同时声明在新旧数组中。

关联不增加目录、路径或写入权限。句柄来自用户已授权的 Space 文件或任务产物，每次读取重新核对原授权；只能由分配到该资源的视图读取。视图可使用 `resources.readText/readBytes/getUrl(context.resource)`，受控 URL 支持 HEAD、Range，关闭后失效。内联预览可能获得未保存文本的只读内存快照（最多 2 MiB UTF-8），宿主不会写回或持久保存快照，原 Space 授权撤回后即不能继续读取；不可保存此临时句柄供重启后复用。编辑或导出仍须沿显式另存为能力。

## 权限

| permissions 字段 | 能力 |
| --- | --- |
| `agent: true` | 追加 Agent 指令、可调用工具或任务动作 |
| `models: true` | 工具或动作调用期间请求已配置模型，凭据留在宿主 |
| `tasks: "read" / "title"` | 读取当前任务标题元数据；title 额外允许安全改名 |
| `taskMessages: true` | 工具或动作调用期间读取原任务可见分支的有限消息文本，详见 [任务权限](agent-settings.md#模型与任务权限) |
| `windowEffects: true` | 窗口 CSS、锚点装饰、窗口效果与无内容的对话输入活动 |
| `controls: ["model.reasoning"]` | 提供可由用户选用的思考等级控件 |
| `notifications: true` | 宿主 `context.notifications.show({title,body})` |
| `schedules: true` | 宿主持久间隔任务，需要宿主入口与已声明命令 |
| `selectedResource: "read"` | 读取用户选择并明确分配的文件资源 |
| `selectedContent: true` | API 3；用户点击插件操作时获取当前草稿或该条消息文本，不订阅输入或读取对话历史 |
| `localResources: true` | 用户通过系统窗口选择文件或目录，视图读取文本、二进制或受控 URL |
| `resourceExport: true` | 用户通过系统另存为窗口确认目标后，保存插件提供的字节 |
| `network: ["https://example.com"]` | 通过宿主向列出的 HTTPS origin 发 GET 请求、下载文件或打开外链 |

未声明权限默认为关闭，清单只需列出实际申请的权限，SDK 打包时会省略默认值。宿主忽略清单顶层、`permissions` 和 `contributes` 中不认识的声明，不因此提供对应能力；已知字段仍按类型和权限校验。需要新版能力时，通过 `engines.lexora` 和 API 版本声明兼容范围。视图无法访问 Node、宿主 DOM、全局键盘、网络 fetch 或任意本地文件。资源和网络调用通过 API；用户在安装确认中查看权限。没有一般性消息订阅、系统剪贴板或屏幕截图接口。

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

## 操作菜单

API 3 的 `contributes.menus` 将已有命令放进业务区域的「更多操作」。先用 `lexora_plugin_capabilities({kind:"menu"})` 查询目标与输入契约，再声明 `{id,command,target,order?,when?}`。`hidden` 隐藏命令面板入口，不隐藏显式声明的菜单。

命令参数中的 `invocation` 包含 `target`、`instanceId`，仅在声明 `selectedContent` 且用户点击对应操作后附带 `content`。文件菜单通过原有 `selectedResource` 权限提供 `resource` 句柄。视图调用自己的命令时 `invocation.target` 为 `view`，只附带该视图的实例标识；命令面板和定时调用的 `invocation` 为空。

输入操作可返回 `{insertText:string}`。宿主在原草稿仍可编辑且内容未改变时，将结果作为纯文本插入原选择位置；更换草稿、编辑内容或关闭视图后忽略迟到结果，不自动发送。其他菜单忽略命令返回值。`when` 支持宿主公开上下文，消息菜单额外提供 `message.role`，文件菜单提供当前 `resource.scheme`；不能用条件读取未公开的数据。

## 页面上下文与生效条件

视图通过 `context.workbench` 读取只读快照：`values` 是公开语义上下文，`pages` 列出已登记页面的稳定 `id/title`。`onWorkbenchChange` 订阅变化。当前 `page.id` 使用 `lexora.tasks`、`lexora.automations`、`lexora.extensions`、`lexora.settings` 或 `extension:<插件ID>`；自动化和设置通过 `page.section` 提供子页标识，如 `plans`、`history`、`general`、`models`。其他页面不保留上一个页面的 section。未来页面通过登记扩展，不以名称、URL 或 DOM 选择器识别。这里不提供任务正文、输入内容、文件路径、路由参数或 Provider/模型身份。

`contributes.views`、`placements`、`commands`、`menus` 和 `navigation` 可声明可选的 `when`。例如 `"when": {"page.id": ["lexora.tasks", "lexora.automations"]}`；对象中的不同 key 为 AND，数组内为 OR，标量严格相等，缺失 key 不匹配。空对象或省略表示不限定，不执行表达式代码。最多 32 个 key，每个数组最多 32 项，值限字符串（256 字符）、布尔和有限数字。视图定义与挂载的条件同时满足才显示。只限定某个挂载实例时优先在 placement 声明；view 的条件影响该定义的所有实例，navigation 的条件只限定入口。

条件只控制 UI 的可用性，不授予权限、不启动插件，也不阻止插件自身调用命令或后台调度。命令菜单与导航入口随上下文更新。首次不满足条件的视图不激活；已打开视图离开范围时隐藏，挂载面板退出布局占位，实例、状态与会话保留，返回后恢复。控件不匹配时使用内置控件并拒绝旧提交。普通挂载的 `placements.hide` 仍表示关闭实例；slot/control 的运行期启停和视图 active 状态见 [内容插槽](slots.md)。

`context.visible/onVisibilityChange` 表达当前视图实际可见性（包含页面范围、区域隐藏和窗口隐藏）。插件自行决定隐藏时暂停动画、查询或媒体，宿主不推断业务行为。订阅随视图销毁自动释放；插件也可提前调用返回对象的 `dispose()`。受范围限制的功能应验收首次不匹配、进入、离开、返回、子页切换和重启后的条件恢复。

## 本地资源与导出

资源授权与文件格式无关。宿主不限制业务格式，不解析文档或工程文件；插件负责解析、显示和编辑。`mimeType` 是根据扩展名给出的提示，未知格式为 `application/octet-stream`，不是授权白名单。文件选择的 `filters: [{name,extensions}]` 与目录扫描的 `extensions` 由插件按需求提供；省略筛选即接受所有格式。

插件下载和私有文件资源不需要 `localResources` 或额外审批。`network.download(url,{name?,signal?})` 在已批准的网络 origin 范围内流式写盘，返回 `{id,name,mimeType,size}`；不设总大小和总时长配额，可用 AbortSignal 取消。重定向逐跳核对授权，关闭发起视图或停用插件会取消下载并清理未完成文件。资源属于插件私有数据，跨重启保存；普通卸载保留，清除数据时删除。用 `resources.release(file)` 回收不再需要的下载副本。

宿主和视图均可 `resources.listFiles/readBytes/readText` 读取已有资源。`resources.importFile(resource,{name?,signal?})` 将已有授权的本地文件、Space 文件或本插件私有文件复制到新的私有资源，默认保留文件名，不弹出选择窗口；不接受任意路径。声明式包内图片可直接作为主题资产的 `{packagePath}` 来源。

视图 `openExternal(url)` 使用系统浏览器打开已批准 origin 的 HTTPS 链接，保留 fragment。无需逐次授权，不授予文件或自定义协议访问。

`network.get(url)` 适用于最多 1 MiB 的文本响应；媒体和大文件使用 `download` 后通过资源 URL 或分段接口读取。大文件不放进 JSON 或命令返回值。下载等待期间不计入宿主普通命令的响应期限；宿主失去响应、退出或用户取消仍会终止操作。

声明 `localResources: true` 后，在可见的交互视图中响应用户操作调用 `resources.pickFiles({filters?,multiple?})` 或 `resources.pickDirectory()`。取消分别返回 `[]` 和 `null`。宿主只接受系统窗口确认的路径，插件不能提交或取得绝对路径。文件句柄为 `{id,name,mimeType,size,relativePath?}`，目录句柄为 `{id,name}`；单次最多选择 100 个文件，文件大小不设产品配额，每插件最多 1000 个文件句柄和 32 个目录。

`resources.listFiles` 返回插件私有资源及已授权的本地文件，`listDirectories` 返回已有目录授权。`scanDirectory(directory,{extensions?,recursive?})` 返回授权根内的文件句柄及相对路径，默认递归，跳过符号链接，限制 10000 项与 16 层；超限明确报错，不静默截断。扫描负责刷新相同筛选范围，保留其他筛选范围的句柄；它不是自动监听。文件删除或变化后，刷新撤销旧句柄，变化的文件返回新 ID。独立选择和不同目录的授权分别管理。目录内引用可以根据返回的 `relativePath` 解析，但不能越过授权根。

按内容选择读取方式：

- `resources.readText(file)`：UTF-8 文本，最多 1 MiB；更大文本或其他编码使用分段读取与插件自己的解码器。
- `resources.readBytes(file,{offset?,length?})`：返回 `{data:Uint8Array,size,eof}`；默认 64 KiB，单次最多 128 KiB，适合二进制解析、增量加载和自定义格式。
- `resources.getUrl(file)`：当前视图专用 URL，可供图片、音视频等元素或视图内 fetch 读取；支持 HEAD、Range 和 seek。只保存资源 ID，每次视图创建后重新取得 URL。不可作为脚本、样式或新页面执行。

授权跨重启保留；文件被移动、替换或修改后旧句柄读取失败，可重新选择或刷新已授权目录。`revokeFile(file)` 撤销单个句柄，保留的目录授权仍允许下次扫描重新发现它；`revokeDirectory(directory)` 撤销该目录及其派生句柄，其他独立授权保留。用户可从插件管理撤销全部本地资源授权，卸载也撤销。撤销、禁用及视图关闭会使相关 URL 和未完成的读取失效，不删除用户原文件。

保存另行声明 `resourceExport: true`。`resources.saveFile({name,data})` 接收建议文件名和 `Blob | ArrayBuffer | Uint8Array`，弹出系统另存为窗口；取消返回 false，完整写入后返回 true，失败抛错。目标由用户决定，插件得不到路径。写入先暂存，提交时验证目标未被其他程序修改，再替换；关闭、禁用、取消或未完整提交不会覆盖原文件。读取授权不包含静默写回或目录批量写入。

包内静态资源使用 `new URL('./assets/file.ext', import.meta.url).href`，遵循包大小上限。音视频支持流式读取和 seek，具体解码能力取决于运行平台；复杂格式可使用包内自包含 JS 解析器。通用文件通道不等于内置任意格式解码器、原生模块或外部可执行程序支持。

验收实际读取、解析、保存结果和取消路径。涉及音视频时验证 metadata、实际进度与 seek；关闭时停止工作、清除 URL 和定时器。交互期间保存进度，销毁后不得再异步回写状态。

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

文件工具仍可通过可见命令提供打开入口；支持新关联声明的 API 4 宿主也可使用上述文件关联。命令方式中，用户先在文件面板打开文件，再从命令面板执行它；宿主将收到的资源句柄传入视图：

```ts
context.subscriptions.add(context.commands.register(`${context.extension.id}.open`, async ({ resource }) => {
  if (!resource)
    throw new Error('请先打开一个文件')
  await context.views.open(`${context.extension.id}.reader`, { resource, state: {} })
}))
```

该视图声明 `resource: "selected-file"`，插件声明 `selectedResource: "read"`；视图从 `context.resource` 取得同一资源，通过 `resources.readText` 读取。句柄不是文件路径。只声明视图不会自动增加文件菜单或命令入口。

后台提醒使用 `context.schedules.set({ id, command, enabled, intervalMinutes })`，间隔最少 1 分钟；不要用页面 setInterval 代替跨页面提醒。Lexora 退出后暂停，重启继续，错过的提醒不会补发。

## 主题与样式

完整主题包、欢迎内容与主题编辑器 API 见 [主题](themes.md)。修改用户主题需要 `themeManagement: true`；仅贡献主题无需权限。

API 3 的 `contributes.iconThemes` 可贡献独立的文件与目录图标主题，无需脚本入口或权限，详见 [文件图标主题](file-icon-themes.md)。

源码包可在清单声明 `"styles": { "uno": true }`，编译器提取包内 TS/JS 的完整类名并生成 `lexora-uno.css`，宿主在视图渲染前自动加载。该文件名保留给编译器，源码不要自行创建。不需要安装 UnoCSS，也不执行插件的 UnoCSS 配置或构建脚本。预编译包使用同一编译工具生成并携带该 CSS。使用此能力时，`engines.lexora` 的最低版本须覆盖提供该能力的宿主。

例如 `container.className = 'flex items-center gap-2 rounded-micro bg-accent-surface text-accent-text p-3'`。常用语义类包括 `bg-surface`、`bg-raised`、`text-fg`、`text-muted`、`border-border`、`bg-accent`、`text-on-accent`、`hover:bg-accent-hover`、`text-danger`、`font-sans` 和 `font-mono`。普通交互背景使用 `hover:bg-hover`、`active:bg-pressed`，选中及选中后悬浮使用 `bg-selected`、`hover:bg-selected-hover`；实色按钮使用 `bg-accent hover:bg-accent-hover active:bg-accent-pressed text-on-accent`，强调文字使用 `text-accent-text`。这些颜色会一起响应主题切换；警告、错误和中性底色保留各自语义。动态状态使用完整类名映射；无法静态提取的完整类名放在 `styles.safelist` 数组，不拼接 `bg-${color}`。

颜色来自 `context.environment`，跟随当前主题实时更新，无需重建视图。原有 `--lexora-background`、`--lexora-text`、`--lexora-muted`、`--lexora-border`、`--lexora-accent`、`--lexora-accent-solid` 保持可用；其中 `accent` 是强调文字色，`bg-accent` 使用 `accent-solid`。更多语义变量与工具类同名，如 `--lexora-accent-surface`、`--lexora-focus`。Canvas 等绘制逻辑可通过 `context.onEnvironmentChange` 响应变化。

复杂效果仍可创建元素、设置样式，或引入包内 CSS：`link.href = new URL('./style.css', import.meta.url).href`。效果应柔和短暂，不遮挡正文或确认操作。CSS 只作用于插件自己的隔离页面。


临时覆盖层、分屏布局订阅与局部点击区域见 [交互会话](interactions.md)。
