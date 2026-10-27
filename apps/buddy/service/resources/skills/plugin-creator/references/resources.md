# 文件关联、资源与导出

## 文件关联与独立入口

使用下列新增声明时，`apiVersion` 保持 `4`，`engines.lexora` 必须以首次提供这些能力的应用版本为下限；不能仅凭旧宿主也支持 API 4 就声明兼容。应用版本和 API 版本分别约束能力可用性与协议兼容性。

`contributes.fileHandlers` 声明文件处理器，每项具有稳定的 `id`、显示名称 `title` 和精确的小写带点后缀 `extensions`，例如 `[".md", ".markdown"]`。不接受通配符、MIME 推断或没有点的后缀；每项最多 64 个后缀、共 32 项。两种打开方式分别保存用户默认；多个已注册复合后缀匹配时采用最长者。

- `preview: { view, requestDefault? }`：在文件页内预览。
- `open: { view, requestDefault? }`：在独立工作台视图中打开文件。

至少声明一种方式；省略的方式不注册，也不借用另一种方式的视图。两者可引用同一个视图或不同视图；视图必须属于本插件、`location` 为 `context`，资源模式为 `selected-file` 或 `optional-file`，并声明 `selectedResource: "read"`。宿主传递文件资源与管理视图生命周期，插件自行决定界面内容。

文件关联与引用重开得到的资源可包含 `sourceId`：同一插件内，同一宿主来源的稳定、不透明标识，跨新资源句柄保持一致。它可用于复用文档库记录；不同产物、来源类型或重绑定的目录仍是不同来源。它不代表内容哈希、文件路径或授权，读取仍使用当前 `id`；缺少该字段时不能按文件名猜测同源。

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

关联不增加目录、路径或写入权限。句柄来自用户已授权的 Space 文件或任务产物，每次读取重新核对原授权；只能由分配到该资源的视图读取。视图可使用 `resources.readText/readBytes/getUrl(context.resource)`，受控 URL 支持 HEAD、Range，关闭后失效。内联预览可能获得未保存文本的只读内存快照（最多 2 MiB UTF-8），宿主不会写回或持久保存快照，原 Space 授权撤回后即不能继续读取；不可保存此临时句柄供重启后复用。文件原件编辑需声明 fileEditing 并通过 documents.open 建立编辑会话；只读快照的导出使用 resources.saveFile。


## 本地资源与导出

资源授权与文件格式无关。宿主不限制业务格式，不解析文档或工程文件；插件负责解析、显示和编辑。`mimeType` 是根据扩展名给出的提示，未知格式为 `application/octet-stream`，不是授权白名单。文件选择的 `filters: [{name,extensions}]` 与目录扫描的 `extensions` 由插件按需求提供；省略筛选即接受所有格式。

插件下载和私有文件资源不需要 `localResources` 或额外审批。`network.download(url,{name?,signal?})` 在已批准的网络 origin 范围内流式写盘，返回 `{id,name,mimeType,size}`；不设总大小和总时长配额，可用 AbortSignal 取消。重定向逐跳核对授权，关闭发起视图或停用插件会取消下载并清理未完成文件。资源属于插件私有数据，跨重启保存；普通卸载保留，清除数据时删除。用 `resources.release(file)` 回收不再需要的下载副本。

宿主和视图均可 `resources.listFiles/readBytes/readText` 读取已有资源。`resources.importFile(resource,{name?,signal?})` 将已有授权的本地文件、Space 文件或本插件私有文件复制到新的私有资源，默认保留文件名，不弹出选择窗口；不接受任意路径。声明式包内图片可直接作为主题资产的 `{packagePath}` 来源。

`resources.createFile({name,data,mimeType?,signal?})` 在宿主和视图中将 `Blob | ArrayBuffer | Uint8Array` 保存为新的私有资源，返回 `{id,name,mimeType,size}`。它不弹出文件窗口，不需要 `localResources` 或 `resourceExport`，不接受路径或覆写原文件。适合文档草稿、编辑结果和版本快照；保存新资源成功后，再更新插件元数据中的 ID，最后 `release` 已不需要的旧资源。失败时保留旧 ID，不能先释放旧版本。并发编辑应由插件以文档版本检查串行更新元数据。

创建资源时按块传输并原子发布，半成品不会出现在列表；关闭发起视图、停用或 signal 取消时回收未提交数据。每插件最多同时创建 2 个文件，单文件最多 256 MiB，生成资源及其私有副本合计最多 1 GiB、4096 项；外部导入和下载沿用原有规则。MIME 可包含参数，返回句柄使用规范化后的裸类型，例如 `text/plain;charset=utf-8` 保存为 `text/plain`。大数据优先传 Blob，避免字节数组转 Blob 的整份内存复制。此增量能力需先检查 `typeof context.resources.createFile === 'function'`；旧宿主提供清晰升级提示，不把文档二进制塞进有大小限制的 JSON storage。

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


编辑原件和恢复草稿见 [文档编辑](documents.md)。
