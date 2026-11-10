# 后台推理

此接口让插件向宿主提供后台推理能力。提供 Linux x64 隔离运行时、Windows x64 及 macOS ARM64 受监督运行时，以及语音、文本对话、图像读取与生成/编辑能力。macOS 接入为实验性。Windows/macOS 原生程序以当前账户权限运行，不提供操作系统级文件和网络隔离；只安装可信的原生推理插件。GPU 计算需要单独声明权限。语音有独立的输入和朗读用途选择；对话模型进入现有模型选择器和任务流程。模型、引擎和管理页面由插件准备，主程序不附带模型。

## 声明与绑定

在 API 3 或更新清单中声明 `permissions.inference: true`、后台 `entry` 和 `contributes.inference`：

```json
{
  "providerName": "Example Local",
  "runtimes": [
    { "id": "speech", "entry": "native/speech.mjs", "platforms": ["linux-x64"], "capacity": 1, "idleTimeoutMs": 60000 }
  ],
  "capabilities": [
    { "id": "transcribe", "title": "语音转写", "kind": "speech.transcribe", "runtime": "speech", "streamingInput": true, "streamingOutput": true }
  ]
}
```

`providerName` 可选，用于对话、语音与图像生成共用的模型服务显示名；去除首尾空白后须为 1–100 字符，不能仅含空白，省略时沿用 `manifest.name`。插件名称仍由 `manifest.name` 决定，导航与管理页标题各自配置；独立图像读取的归属仍可显示插件名称。改名不会改变插件、Provider 或模型 ID，也不重置用户的模型开关和默认选择。旧宿主可能拒绝未识别的清单字段，分发前须验证 `engines.lexora` 指定的支持版本。

能力类型为 `speech.transcribe`、`speech.synthesize` 、`chat.completion`、`image.read` 或 `image.generate`。只声明后端实际支持的流式输入、输出；整段上传后返回结果不能标成流式转写。运行时容量默认为 1，最多 4；未经验证的原生后端保持串行。

后台通过 `context.inference` 准备资源和调用 `bind`。绑定包含运行时 ID、资源集合的 ID/修订/挂载名称，以及加载配置。绑定后按需加载，同一绑定复用实例；重启插件后重新绑定。管理页通过已有后台命令设置、查询和停止，不转发每块音频。

`context.inference.capabilities.nativeRuntime === true` 时，可调用 `environment()` 获取 `{ platform, executionMode }`：平台为 `linux-x64`、`windows-x64`、`macos-arm64` 或 `null`，执行方式为 `isolated`、`supervised` 或 `unsupported`。按真实目标选择引擎和清单中的运行时，不从浏览器信息推测；平台支持不保证驱动、引擎或具体模型可用。

`context.inference.capabilities.runtimeIsolation === true` 表示宿主同时支持按运行时停止、撤销绑定和按凭据引用范围停止，不表示操作系统沙箱。依赖多个独立运行时的管理插件，应在绑定或修改配置前检查该标记；旧宿主没有 `capabilities` 时保持只读并提示升级，不能将带参数的 `stop` 当作能力探测。

`unbind({ runtime })` 先撤销指定运行时的绑定，再停止其活动与等待调用；其他运行时继续，资源保留。撤销期间拒绝该运行时的新调用和并发绑定，完成后必须重新 `bind` 才能调用。保存服务配置或更换凭据前可先撤销绑定，确保保存失败时不会继续调用旧服务；插件应同步清理自己的绑定缓存。

`environment().hardware` 是可选的只读采样：`sampledAt` 为毫秒时间戳，`logicalCores` 为逻辑核心数，`totalMemoryBytes` / `availableMemoryBytes` 为总量 / 可用 RAM 字节数，`gpus` 包含限长名称、厂商及可选的总量 / 可用显存字节数。没有 `inferenceGpu` 权限时 GPU 列表为空。采样约缓存 15 秒；可用内存不是空闲内存，可用显存不是预算保证，不能按 GPU 名称推算容量。设备查询失败、没有可靠测量或旧宿主未提供时，相应字段缺失，应显示未知而不是零。Apple 统一内存不能当成独立显存与 RAM 相加。

`status()` 返回的各运行时中，`instances[].observation` 是可选的当前实例诊断快照，`observedAt` 为最后更新的毫秒时间戳，只包含经过校验的引擎、请求 / 实测后端、设备序号、卸载层数、降级、加载耗时、吞吐和错误码。`context` 的 `requested` / `actual` / `train` 分别表示请求、实际运行和训练上下文，均可缺失；缺失的实际值不能由请求值代填。`timings` 保存引擎汇总，`prompt` / `decode` 为最近收到的请求测量，不是完整请求历史。字段增量合并，新一轮加载清空旧观测，停止或替换实例后失效；查询本身不加载模型。按当前绑定的运行时和实例展示，不得将其他模型或已退役实例的数据复用。旧宿主及未输出诊断的引擎可以不提供此字段，现有插件无需新增调用。

`status()` 返回绑定、加载、活动、等待及取消中的实例状态。`stop()` 停止本插件所有推理实例，保留资源和绑定；`stop({ runtime })` 只停止指定运行时及其等待调用，其他运行时继续。运行时必须已在清单中声明，后续调用可以重新加载。`bind()` 在验证声明与已登记资源后只停止对应运行时的实例，再应用绑定；其他运行时的活动与等待调用继续，相同绑定不会重载。无效绑定保留原配置。绑定成功不保证引擎一定能加载，插件应保留可恢复的配置并呈现加载错误。绑定配置只包含该运行时实际使用的参数，例如转写的线程数、朗读的音色和语速。设置或删除凭据只停止引用该凭据的运行时，变更期间拒绝使用该凭据的新调用与绑定。禁用、更新、无参停止和存储维护仍作用于整个插件。

## 语音消费者

管理页面复用 `contributes.views` 的 `location: "page"`，通过 `contributes.navigation` 或 `contributes.settings.modules[].view` 提供入口。模型服务中的管理操作优先打开插件导航页，没有导航页时打开所属设置页；两者都没有时转到插件管理。页面通过后台命令准备模型、保存参数及查询状态，不接收录音数据。用途选择会检查插件当前修订及运行时绑定，失败保留原选择；插件缺失时保留引用，不自动选择其他后端。

转写输入为 `{ sampleRate: 16000, channels: 1, sampleFormat: "f32le" }`，随后 `write(bytes)` 接收单声道、小端 Float32 PCM，采样范围为 `[-1, 1]`。麦克风在后端就绪后开始采集。输出不携带二进制：

```js
call.emit({ type: 'transcript', segmentId: 'main', revision: 0, text: '正在识别', final: false })
call.emit({ type: 'transcript', segmentId: 'main', revision: 1, text: '识别结果。', final: true })
```

同一片段修订递增；最终片段不能再修改。多个片段按首次出现顺序拼接。`finish()` 应排空输入并将所有片段收束为最终结果；未识别到文字也应返回空文本的 `final: true`，没有最终结果视为失败。取消无需补造最终结果。整段服务可缓冲后一次返回 `final: true`，但不得声明在线流式输入/输出；宿主会提示用户结束录音后等待结果。会话最长 10 分钟、转写累计最多 16000 字符；宿主不会自动判断结束或发送消息。

朗读输入为 `{ text }`（最多 16000 字符）。输出采用单声道 Float32 PCM，采样率为 8000–96000 Hz，同一调用不变。每块最多 2 秒且不超过 256 KiB，序号从 0 连续递增：

```js
call.emit({ type: 'audio', sequence: 0, sampleFormat: 'f32le', channels: 1, sampleRate: 24000 }, pcmBytes)
```

宿主按消费确认控制传输与播放队列，完成合成后继续播放剩余块；用户停止时清空队列并取消当前调用。错误中断当前会话，不重播或自动更换提供方。录音与播放音频仅存于内存，临时转写在用户插入草稿后才进入既有草稿保存流程。

已有语音服务复用下文的受控网络与凭据通道。文件转写插件可在 `finish()` 中封装 WAV 并提交 multipart；服务返回的音频格式须由插件转换为上述 PCM 契约，网络分块不保证落在采样边界。实时转写需要服务支持持续输入；文件上传后的流式文本响应不能声明为录音中的实时转写。停止插件只取消请求，不关闭外部服务。

语音服务适配器遇到鉴权失败或限流，可分别抛出 `EXTENSION_INFERENCE_SERVICE_UNAUTHORIZED`、`EXTENSION_INFERENCE_SERVICE_BUSY`，宿主会提示检查插件凭据或稍后手动重试。网络中断使用受控通道给出的错误，不自动重新提交。

对话、语音和生图模型完成绑定后，宿主将其呈现在「模型服务」中。模型资源与运行参数在插件中管理；用户在「语音」或「图像」设置选择用途。图片输入是对话模型能力，不是新的模型用途。仅提供 `image.read` 的 OCR 等后端在图像用途设置中选择，不注册为对话模型；图像能力仍遵守宿主对模型及服务的启用状态。

## 对话消费者

声明 `chat.completion` 能力后，在对应运行时绑定中提供 `models`：

```js
models: [{
  id: 'local-chat',
  title: '本地对话模型',
  capability: 'chat',
  contextWindow: 32768,
  maxTokens: 2048,
  tools: true,
}]
```

`id` 是插件内稳定模型身份，不能在多个运行时重复。用户通过普通模型选择器选择它；加载参数和资源仍由插件页面管理。禁用、卸载或撤销文件授权后，原有选择保留并显示不可用；恢复相同身份后可以继续使用，不会自动改用其他模型。默认只接受文本。支持图片输入的对话模型在同一 `models` 绑定中声明 `input: ['text', 'image']`，仍使用对话用途，不创建额外的识图类别。只有 `context.inference.capabilities.chatImageInput === true` 时才能使用图片输入协议；旧宿主应提示升级。不能仅因模型名称或已有 `image.read` 绑定就宣称对话支持图片，也不能丢弃图片后当作成功。

对话会话的 `input` 为 `{ model, contentType: "application/json" }`。随后 `write(bytes)` 接收 UTF-8 JSON 分块，累计最多 32 MiB；`finish()` 时才解析完整的 `InferenceChatRequest`，类型见 [api.d.ts](api.d.ts)。请求包含完整消息、当前工具、最大输出、可选温度和可选 `reasoning`（`off / minimal / low / medium / high / xhigh / max`）。省略 `reasoning` 时保持后端默认；本地模板后端应把显式 `off` 映射到关闭思考的原生参数，不用提示词模拟。消息保留 system/user/assistant/tool 角色、工具调用 ID 与工具错误标志；适配后端时保留这些语义，包括 JSON Schema 的可选参数含义。纯文本 user/tool 消息继续使用 `text`；图文消息改用有序 `content`，与 `text` 二选一，包含 `{ type: 'text', text }` 和 `{ type: 'image', mimeType, data }`。图片只接受 PNG/JPEG/WebP/GIF 的 Base64 字节，不接受路径或远端 URL。工具结果图片同样保留其原始顺序、工具身份和错误状态。图片计入整个请求的 32 MiB 上限；文本模型收到图片必须明确拒绝，不隐式转录或换模型。

`reasoning: true` 声明后端支持思考开关，`false` 或省略保持不支持；也可声明 `reasoning: 'auto'`，复用 `catalogModels` 精确匹配，只有全部来源明确支持时开启。使用前检查 `context.inference.capabilities.chatReasoning === true`，旧宿主不发送新增字段。当前声明是开关，宿主默认提供 `off / medium`，不把目录的云端思考强度直接套给本地后端。用户的能力覆盖和本次请求的思考选项分别保留；标题等短文本请求的 `off` 不改变模型的能力声明。开启思考时通过独立的 `{ type: 'thinking', text }` 事件输出，不能拼进正文；关闭或未请求思考时不发送该事件。

输出不携带二进制，按顺序发送：

```js
call.emit({ type: 'text', text: '回复片段' })
call.emit({ type: 'tool', call: { id: 'call-1', name: 'requested_tool', arguments: {} } })
call.emit({ type: 'done', reason: 'toolUse', usage: { input: 120, output: 18 } })
```

普通结束使用 `stop`，输出上限使用 `length`，产生工具调用使用 `toolUse`。每次必须且只能发送一个 `done`，随后结束会话；缺少终态不会认作成功。`usage` 使用后端实际 token 数，缓存读取/写入可用 `cacheRead`/`cacheWrite` 单列，`input` 不重复计入缓存。累计输出最多 16 MiB、最多 64 个工具调用；只能返回本次请求提供的工具名，ID 不得重复。

`tools: false` 声明来源默认关闭工具调用，不影响已声明的图片输入；`tools: true` 声明来源默认开启，必须由后端结构化工具输出和实际任务往返验证。布尔声明保持原义，不被目录覆盖。后端能传递工具协议时，也可使用 `tools: 'auto'`，同时提供 `catalogModels: [{ providerId: 'huggingface', modelId: 'Qwen/Qwen3.5-9B' }]`。来源最多 8 条、不得重复，必须是可核对的显式来源 ID，不从显示名称或 GGUF 文件名推断。宿主使用已有模型目录精确查询，只有所有来源均明确支持工具时才启用；来源缺失、未知、未声明能力或相互冲突均关闭，不任选第一个。目录更新会重算来源默认能力，不改变插件模型 ID、绑定修订、资源、参数或用户启用状态。用户可在宿主「模型服务」中覆盖图片输入和工具能力，覆盖值独立保存并优先于插件声明与自动匹配；刷新、重启或插件更新不清空覆盖，恢复默认后重新跟随来源。插件不另存同一能力开关，也不把原始 `tools`/`input` 声明当作拒绝宿主请求的终态。后端实际不支持所请求协议时应明确报错，不丢弃图片或伪造工具调用。

使用自动模式前检查 `context.inference.capabilities.chatToolMatching === true`；旧宿主应提示升级，不把字符串当作布尔启用。`tools: 'auto'` 只解析工具能力，不因目录声明自动开启图片、PDF、音频或视频输入；图片来源默认来自绑定 `input`，用户可显式覆盖，后端仍须实际支持；其他媒体不能超出宿主传输协议。能力覆盖不增加工具执行权限。工具交由宿主执行；插件不能自己执行任务工具或另建一份对话历史。宿主继续管理审批、用量、任务模型选择和取消。来自插件动作的模型调用复用外层调用的准入，不再次占用相同的插件队列名额。

## 资源

`resources.prepare({ id, kind, files, preparation? }, { signal, onProgress? })` 接受固定文件集合；`kind` 为 `engine` 或 `model`，每个文件包含相对 `path`、SHA-256 和来源，可选 `size` 为非负安全整数（字节，含 0）。已知 size 用于无 Content-Length 下载的总量及实际大小校验；省略保持原行为，不推测大小。来源可为获准公共 HTTPS URL，或已有 `resourceId`。固定文件清单还可使用 `{ directoryId, path, reference: true }` 引用已授权目录下的相对路径，无需先扫描全部文件；每个集合最多 4096 个文件，准备请求最多 2 MiB。拒绝符号链接、越界路径和已撤销目录授权。URL 使用普通下载权限 `permissions.network`，重定向目的地同样需要声明；本地选择使用既有文件/目录授权。

`{ resourceId, reference: true }` 仅引用用户授权的外部文件；默认复制为插件持有的文件。下载采用暂存和校验，全部成功才发布资源修订。失败保留旧修订，调用时重新检查内容与授权。一个 ID 可以保留多个修订；使用 prepare 返回的修订进行绑定，不只按 ID 取任意一项。资源不受普通包文件大小限制；清单、索引和控制请求仍有大小限制。资源路径允许模型实际需要的字符，但拒绝绝对路径、路径穿越和不可移植文件名。

需要解压或转换时，插件声明 `contributes.inference.preparation: { entry: "native/prepare.mjs", platforms: ["linux-x64"] }`，并传入空 `files` 与 `preparation`。后者包含 `inputs: [{ id, sha256, size, source }]`、插件自定义 JSON `options`、输出总字节上限 `maxBytes` 和文件数上限 `maxFiles`。最多 16 个输入，每个输入最多 16 GiB；输出最多 64 GiB、4096 个文件，options 最多 1 MiB。宿主不解析压缩格式或模型目录结构；解码器及依赖必须随插件编译交付。

宿主下载并校验输入后，交给独立准备进程。Linux 将输入只读挂载到 `resources.inputs/<id>`，禁用 GPU 与网络；Windows/macOS 使用经授权的文件映射，不提供 OS 文件、设备或网络隔离，仍按下述原生模块边界执行。准备模块沿用 `initialize` / `start` 接口，能力名为 `resources.prepare`；`start` 的 input 为空对象，options 的 JSON UTF-8 字节通过 `write` 分块传入，在 `finish` 中处理。它不依赖已经安装好的推理引擎。

输出使用 `await call.emitAsync(data, bytes?)`，逐文件发送 `{ type: "file", path, size, executable? }`、若干 `{ type: "chunk" }` 二进制块（每块最多 256 KiB），最后发送 `{ type: "end", sha256 }`。相同内容的文件别名可发送 `{ type: "alias", path, target }`，target 必须为本次已经完成的文件；宿主共享内容，不创建符号链接。输出逐块背压，宿主独立校验路径、数量、字节数和摘要，全部结束且准备进程退出后才提交修订。`kind: "model"` 的准备输出不可声明可执行文件。失败或取消保留已有修订。

可执行文件在清单中标记 `executable: true`；Linux/macOS 上复制或解压得到的自有文件设置为仅当前用户可执行，外部引用不修改权限，加载时检查原文件已经可执行。Windows 不套用 POSIX 可执行位，也不修改原文件 ACL。`onProgress` 返回 `{resource,path,phase,completedFiles,totalFiles,bytes,totalBytes,resumedBytes?}`：URL 请求前进入 `connect`，bytes 是当前文件已保留的字节（首次为 0），总量为已知 size 或 null；响应到达后进入 `download`，bytes 包含复用部分和实际新增字节，EOF 保留最终字节事件，总量未知时始终为 null。可选 `resumedBytes` 表示本次文件请求复用的本地字节，在 connect/download 事件中持续返回；计算网络速度时应从 bytes 扣除该值。服务器忽略 Range 时安全从零重下，bytes/resumedBytes 会回到 0，不应强行维持旧百分比。`download` 也用于复制所选文件；`verify` 表示校验，`extract` 表示准备模块输出。direct files 的 path 是 file.path，准备输入的 path 是 input.id；字节数只针对当前路径/阶段，不可跨阶段相加。completedFiles 是已校验输出文件数；direct files 的 totalFiles 为清单长度，准备模块输出总数未知时为 0。每个文件完成后更新计数；仅整个集合提交后发送一次 `ready`，path 为空，文件计数与 bytes/totalBytes 为最终输出集合总量，不代表下载量。进度不替代 prepare 的成功返回；未知总量不应显示百分比。传入的取消信号会停止读取；已有修订保留。`context.inference.capabilities.resumableDownloads === true` 时，URL 下载的未完成文件和已校验输入按资源与固定准备身份保留；用户再次 prepare 相同内容时优先续传，仍须通过大小与完整 SHA-256 校验才发布。校验失败或非法区间不会复用污染内容，remove 同时清理该资源的下载暂存。不后台自动重试、不自动恢复传输；旧宿主缺少此能力时不得承诺续传。插件负责管理页状态、取消入口和已完成集合的复用。

URL 连接或响应流失败返回 `EXTENSION_INFERENCE_DOWNLOAD_FAILED`，插件可提示重试下载或导入文件；权限拒绝保留对应错误，用户取消沿原取消信号结束。本地文件读取、写入或校验失败不归类为网络失败。

`resources.list()` 返回全部已登记集合及 `authorized`：外部文件或目录授权仍有效时为 `true`，插件持有的集合无需外部授权。`false` 的集合需重新选择文件或准备资源，不能当作已准备；记录仍可用于 `remove` 清理。此标记不保证文件仍存在或内容未变，加载时仍会重新校验。`remove({ id, revision })` 拒绝删除正在使用的集合；先停止实例再移除。移除、卸载或清理不会删除用户原文件。引擎和权重与普通缓存分开，默认不进入选择性备份；迁移存储目录会携带插件持有的资源。恢复后根据当前文件和授权重新准备。

## 原生模块

`native/*.mjs` 必须是已编译的 ESM。源码打包保留该目录，不替它安装依赖或编译 Node 原生模块。较大的引擎依赖作为资源准备，通过挂载路径加载。模块默认使用宿主的 Electron Node 模式；必须验证原生模块兼容性。需要独立 Node 等引擎时，由插件按平台准备并在同一受监督进程树内启动和回收，不依赖用户另行安装系统运行时。必要的动态库搜索目录使用绑定的 `libraryPaths: [{ mount, path }]`。

入口导出 `initialize({ configuration, resources, resourceFiles })`，返回 `InferenceBackend`，类型见 [api.d.ts](api.d.ts)。`resources` 将挂载名称映射为运行时目录；可选 `resourceFiles[mount][rolePath]` 提供该角色的实际文件路径，访问文件时优先使用它，否则拼接目录与角色路径。Windows/macOS 外部引用通过此映射直接使用原件，跨卷不复制大文件；映射属于本次运行，不持久化为新的授权。

Linux 模块在只读挂载与网络隔离中运行。Windows/macOS 模块由当前账户启动，宿主校验入口、资源和协议；Windows 通过 Job 管理进程树，macOS 通过进程组与生命周期监测回收普通后代，不保证回收主动脱离进程组的程序。它们都不限制原生代码对账户可访问文件、凭据、设备和网络的访问；最小环境不等于权限隔离。网页插件上下文仍不获得 Node 权限。插件更新每新增一种受监督平台，都会重新显示推理权限审阅；已批准 Windows 不等于批准新增 macOS 执行。

`start(capability, input, call)` 返回会话：可选 `write(bytes)` 接收输入，`finish()` 排空并结束。`call.emit(data, bytes)` 输出控制数据和可选二进制；返回 `false` 时立即停止生产，并持续检查 `call.signal`。不要向标准输出写日志。二进制块最多 256 KiB，单条控制消息最多 64 KiB，输出缓冲最多 4 MiB；超额失败，不能静默丢块。输入按消费确认施加背压。

取消不等于后端已经释放。会话应响应信号、结束工作并释放资源；一个调用取消不会强杀还有其他活动调用的共享进程。整体停止会排空并在超时后终止插件自有进程。`dispose()` 负责正常退出时清理模型。失败不会自动重试。可预期失败使用短错误码 `EXTENSION_INFERENCE_*`；其他异常统一隐藏细节，不能把路径、输入或密钥嵌入错误码。

## 连接已有服务

推理网络单独声明 `permissions.inferenceNetwork` 的准确 origin，并在绑定的 `endpoints` 中指定名称、完整 URL 和内容类型。支持 HTTPS，或明确的 `http://127.0.0.1:<port>` / `http://[::1]:<port>`；不开放任意本机地址。

模块通过 `call.network.post(name, bytes, options?)` 获得标准 `Response`。请求体最多 32 MiB，通过有确认的 256 KiB 分块传送；接收完整请求后才发起一次 POST。响应支持流式读取、总计最多 48 MiB，单次网络调用最长 10 分钟，超时后不重试；拒绝重定向，不继承浏览器登录态。支持 JSON、octet-stream、WAV 和 multipart/form-data；后者在端点中声明，并通过 `options.contentType` 传入实际序列化的 boundary，例如 `multipart/form-data; boundary=----formdata-example`。这是有限大小的完整请求上传，不是持续音频流。响应保留状态、Content-Type 和有界的 `x-request-id`，不透传其他头。

需要 Bearer 认证时，管理页通过后台 `context.inference.credentials.set({ id, origin, token })` 保存密钥，端点只配置 `credential: id`。`has({ id, origin })` 检查是否配置，`remove(id)` 删除；每个插件最多 32 项。origin 必须精确匹配已声明的推理网络来源。凭据只属于当前插件及保存时的 origin，不能引用其他插件或 Provider 的密钥。宿主加密保存并在请求边界注入 Authorization，不向原生模块返回 token；不支持从插件读取明文、任意认证头或 OAuth。密钥不能写入普通配置、状态、包文件、URL 或日志。系统加密不可用时拒绝保存，没有明文降级。

更换或删除密钥先停止本插件中引用该凭据的运行时，其他运行时继续。普通卸载保留凭据，卸载并清除数据会删除；删除密文不依赖密钥库能否解密。迁移跟随数据根；选择性备份只有同时选择插件、包含凭据并使用密码保护时才携带密钥，恢复时重新加密。

调用结束或取消会关闭对应网络请求，停止插件不会关闭用户已经部署的服务。关闭连接不能证明远端任务停止；结果未知时必须保留请求身份，不能自动再提交。网络适配与本地直接推理使用相同生命周期，宿主与原生入口之间仍使用二进制通道。插件内部若使用本机 HTTP 引擎，应仅监听回环地址、固定本次实例身份，并独立处理就绪、取消和退出；不将它注册成额外的远端服务。


## 图像生成与编辑

声明 `image.generate` 后，在绑定的 `imageModels` 中提供稳定模型 ID、标题、能力 ID 和 `support`。`operations` 分别声明 `generate` / `edit`；同时声明最大参考图数、实际支持的尺寸、质量和背景值。`auto` 表示该模型已配置的默认值。不能将只能提取文字或接收图片的模型声明成生图模型。

宿主在模型服务设置中提供生成、编辑的独立用途选择：按需、指定、只看模型自身，以及显式的顺序备用。插件管理页面继续负责模型准备和加载参数。每次调用固定包、绑定修订与所选模型；旧选择失效时保留用户配置。

输入通过二进制块传入 UTF-8 JSON（`InferenceImageRequest`，最多 32 MiB），在 `finish()` 取得完整请求。`images` 是有序原始参考图，不能遗漏或重排；编辑请求必须至少有一张参考图。请求有稳定 `requestId`，可以传给外部服务用作其支持的请求身份；不要由插件再套一层自动备用。

后端可先发送 `{ type: 'submitted', requestId }` 记录实际后端请求身份。PNG 输出使用 `call.emit({ type: 'image', index, sequence, final, mimeType: 'image/png' }, bytes)`，每块最多 256 KiB、输出总计最多 32 MiB。每张图按连续序号发送，结束后再发送下一张，最多四张。所有图片结束后发送唯一的 `{ type: 'done', responseId }`，再结束调用。输出先经过宿主验证，再写入任务产物；插件卸载不会删除已经发布的图片。

只有确定未产生结果时才发送 `failed`；`code` 可为 `UNAVAILABLE`、`BUSY`、`RESOURCE_EXHAUSTED`、`UNSUPPORTED` 或 `FAILED`。`retryable` 单独表示是否允许切到用户配置的备用，设为 `false` 仍是明确失败，不是结果未知。只有可安全换提供方时才设为 `true`。加载前资源不足可以抛出 `EXTENSION_INFERENCE_RESOURCE_EXHAUSTED`，宿主只在调用尚未开始时认定为明确失败；已开始的异常退出仍保留未知。

非零退出码本身不能证明没有生成结果；尤其是已经写出临时图片后崩溃时，不能发送可安全重试的 failed。异常断线、输出不完整、取消和未知终态不能通过失败事件变成普通失败。宿主持久保存请求身份与实际提供方；未知请求和部分发布阻止同一执行自动重新生成。外部服务的任务查询/恢复 API 尚未开放，不能承诺自动恢复远端长任务。

## GPU 计算

在 `permissions` 中增加 `inferenceGpu: true`，并在需要 GPU 的 runtime 中声明 `gpu: true`。更新到更高权限需要重新审阅。Linux 未声明的运行时不映射 GPU；Windows 原生程序的实际设备访问由账户和驱动决定，该声明不是 OS 拒绝边界。管理页不会因此获得设备或文件系统权限。

当前 Linux 接口开放计算设备节点，不映射 DRM card、nvidia-modeset、麦克风或用户目录，也不开放直接网络。系统驱动由宿主系统提供，引擎及其依赖继续作为插件资源准备。插件负责显存预算、内部卸载和请求取消，不得结束其他应用或已有外部服务。Windows 引擎、DLL、CPU/GPU 选择与本机通信由插件处理，不由宿主识别模型或引擎。具体驱动组合仍需验证；当前不开放 macOS 原生推理。

## 图像读取与 OCR

声明 `kind: "image.read"`，通过 `context.inference.bind({ runtime, resources, imageReaders })` 提供模型。每个 reader 包含 `id`、`title`、`capability` 和 `support.operations`：`understand` 表示视觉理解，`extract` 只提取文字，`document` 解析文档图片的阅读顺序及结构。只声明真正支持的用途，普通 OCR 不能声明为场景理解或完整文档解析。

宿主沿普通 `read` 工具和既有文件授权调用，`imagePurpose` 选择用途，`imageQuestion` 提供问题。按用途设置选择当前对话模型、插件或已配置的视觉 Provider。插件仍拥有管理页面和可选的本地模型；已经配置的视觉 API 使用原有 Provider 凭据和用量路径。

输入为 `InferenceImageReadingRequest` 的 UTF-8 JSON，累计最多 32 MiB。`question` 是聚焦问题；`understand` 和 `document` 可同时收到 `currentUserRequest`，用于理解当前用户任务，`extract` 不传且不接受该字段。图片与其中的文字都是待分析材料，不是执行指令。宿主完整验证图片后，以 Base64 传输单张原图，不能由插件重新打开请求方路径；多张输入整体拒绝，不丢弃额外图片。以序号从 0 连续递增的 `text` 事件返回，每段最多 16,384 字符，累计最多 128 KiB UTF-8。全部完成后发送唯一 `done`；没有文字的 OCR 可返回空文本后 done，不等于失败。不允许额外二进制输出、重复终态或截断后伪装完整。

`failed.retryable` 仅在明确失败且尚无文字输出时允许已配置的顺序备用；取消、未知终态和部分输出不自动拼接其他结果。取消必须排空自有子进程。结果进入正常工具历史并保留实际提供方，插件停用或卸载不会清除任务历史。

运行时通过 `capacity` 声明并发数量（1–4），通过 `idleTimeoutMs` 声明空闲后的进程回收时间（0–3600000 毫秒，省略为 60000）。0 表示最后一个调用结束后立即回收。引擎选择、加载参数和资源布局由插件决定；宿主负责在调用排空后执行回收、释放资源租约，并在禁用或撤权时终止进程。
