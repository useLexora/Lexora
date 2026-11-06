---
title: "提供模型与多模态能力"
description: "声明推理后端，准备引擎与模型资源，绑定对话、语音和图像能力，并管理权限与生命周期。"
---

# 提供模型与多模态能力

`contributes.inference` 让插件向宿主提供模型后端，区别于[工具或动作](./agent)通过 `models.generateText` 消费已配置模型。插件负责引擎、权重、服务适配和管理页面；宿主负责用途选择、任务调用、授权、用量和取消，不要求用户部署 Docker。

## 选择能力

| kind | 用途与绑定 |
| --- | --- |
| `chat.completion` | `models` 提供稳定模型 ID，进入宿主模型选择器 |
| `speech.transcribe` | 语音输入，接收 PCM 并输出转写片段 |
| `speech.synthesize` | 文本朗读，输出 PCM 音频 |
| `image.read` | `imageReaders` 声明 `understand`、`extract`、`document` |
| `image.generate` | `imageModels` 声明生成、编辑与实际支持的参数 |

图片输入属于对话模型的 `input` 能力，不是另一种模型用途；普通 OCR 不能宣称支持场景理解。管理页面用[视图](./views)和[设置](./settings)，通过后台命令准备资源、保存参数和查询状态，不转发每块音频或模型字节。

## 声明与绑定

以下是合并到清单的片段，仍需插件身份、版本和经过验证的 `engines.lexora`。推理要求 API 3 或更新协议、后台 `entry` 和 `inference` 权限；不要据此推断所有 API 3/4 宿主支持每项增量接口。

```json
{
  "apiVersion": 4,
  "entry": "main.ts",
  "permissions": { "inference": true },
  "contributes": {
    "inference": {
      "runtimes": [{
        "id": "chat",
        "entry": "native/chat.mjs",
        "platforms": ["linux-x64"],
        "capacity": 1,
        "idleTimeoutMs": 60000
      }],
      "capabilities": [{
        "id": "completion",
        "title": "本地对话",
        "kind": "chat.completion",
        "runtime": "chat"
      }]
    }
  }
}
```

原生文件必须随包交付并实现后端，以上不是一个可运行模型。运行时 ID 与能力 ID 在插件内稳定且各自唯一，能力引用已声明的运行时。可选 `providerName` 只改变模型服务显示名，不改变模型或插件身份。

后台检查 `context.inference.capabilities?.nativeRuntime === true` 后，用 `environment()` 获取实际平台与执行方式。准备资源后按返回的修订绑定；下面的 `engine` 和 `weights` 是成功 `resources.prepare` 返回的集合：

```ts
await context.inference.bind({
  runtime: 'chat',
  resources: [
    { mount: 'engine', id: engine.id, revision: engine.revision },
    { mount: 'model', id: weights.id, revision: weights.revision },
  ],
  configuration: { threads: 4 },
  models: [{
    id: 'local-chat',
    title: '本地对话模型',
    capability: 'completion',
    contextWindow: 32768,
    maxTokens: 2048,
    tools: false,
  }],
})
```

参数和资源布局由真实引擎决定，不能照搬后假定可运行。绑定后按需加载；相同绑定复用实例，后台重启后重新绑定。无效绑定保留旧配置，绑定成功也不证明引擎能加载。模型 ID 不得跨运行时重复。用户选择失效时保留原选择并提示不可用，不静默切换模型。

## 准备资源

`context.inference.resources.prepare({ id, kind, files }, options)` 准备 `engine` 或 `model` 集合。每个文件声明相对 `path`、真实 SHA-256、可选字节 `size` 和来源；来源为获批 HTTPS URL、已有 `resourceId`，或 `{ directoryId, path, reference: true }`。默认复制为插件持有的内容；外部引用依赖用户持续有效的文件授权，不是任意磁盘读取。

下载使用普通 `permissions.network`，每次重定向仍需授权。本地选择沿用[文件资源](./files)权限。所有文件校验成功才提交新修订；失败或取消保留旧修订。`list()` 的 `authorized: false` 表示外部授权失效，不能当作已就绪；即使为 true，加载时也会重验文件。

需要解压或转换时，声明独立的 `preparation: { entry: "native/prepare.mjs", platforms: [...] }`，调用 prepare 时使用空 `files` 和 `preparation` 的输入清单、options、`maxBytes`、`maxFiles`。宿主不识别压缩格式，解码依赖由插件交付。准备入口通过 `resources.prepare` 能力接收输入，按 `file → chunk → end` 输出并等待 `emitAsync` 背压；摘要、路径、预算和进程结束均通过后才提交。Linux 准备进程不配置 GPU 或网络；受监督平台仍不是 OS 隔离。

进度中的 `bytes/totalBytes` 属于当前路径与阶段，未知总量为 null，不能显示猜测百分比。`ready` 是整个集合完成，不用局部进度替代 prepare 成功返回。只有 `resumableDownloads` 能力为 true 才可承诺同一内容的后续手动续传，不自动重试。

大型引擎和权重不放入[安装包预算](./distribution#包内容与依赖)中；资源集合仍有自己的清单与准备预算。移除前停止使用它的实例，`remove({id,revision})` 不删除用户原文件。引擎、权重和本机文件授权默认不随选择性备份恢复。

## 权限与平台边界

| 平台 | `environment()` 的执行方式 | 边界 |
| --- | --- | --- |
| `linux-x64` | `isolated` | 只读资源挂载、网络隔离；缺少沙箱条件时拒绝启动 |
| `windows-x64` | `supervised` | 当前账户原生进程，监督进程树，不提供 OS 文件或网络隔离 |
| `macos-arm64` | `supervised` | 实验性；当前账户进程组监督，不提供 OS 文件或网络隔离，也不保证回收主动脱离进程组的程序 |
| 其他平台/架构 | `unsupported`，platform 为 null | 不启动原生入口 |

这些是执行通道边界，不是某个引擎、驱动或模型的兼容性验收。仅声明并分发实际验证的平台资源。Windows/macOS 原生代码可以访问当前账户可访问的文件、凭据、设备和网络，只安装可信插件；最小环境不等于权限隔离。新增受监督平台需重新审阅。

GPU 同时要求 `permissions.inferenceGpu: true` 与运行时 `gpu: true`。Linux 只映射计算设备，不开放用户目录或直接网络；Windows/macOS 的声明不构成 OS 设备拒绝边界。平台库、CPU/GPU/Metal 选择与显存预算由插件负责。

浏览器后台、视图与 [Worker](./workers)仍不能直接使用 Node.js 或系统路径；原生入口不是绕过这些限制的通用文件、命令或 IPC 桥。

## 原生入口与协议

`native/*.mjs` 是预编译 ESM，默认使用宿主的 Electron Node 模式；source 打包也不会代装依赖或编译 Node 原生模块。引擎与动态库可作为资源准备，`libraryPaths` 引用已绑定挂载。需要独立运行时时也由插件准备，不依赖用户自行安装。

导出 `initialize({ configuration, resources, resourceFiles })`，返回 `InferenceBackend`。`resources` 给出挂载目录；存在 `resourceFiles[mount][rolePath]` 时优先使用该文件映射，不持久化为新的路径授权。后端 `start(capability, input, call)` 返回可选 `write(bytes)` 与必需 `finish()`，用 `call.emit` 或 `emitAsync` 输出。不要向标准输出写日志。

每块二进制最多 256 KiB，控制消息最多 64 KiB，输出缓冲最多 4 MiB；`emit` 返回 false 时停止生产，持续响应 `call.signal`。取消后排空自有工作，正常退出在 `dispose` 清理。具体消息类型以 [API 参考](./api)为准：

- **对话**：输入为完整请求的 UTF-8 JSON 分块，最多 32 MiB；保留消息角色、工具 ID 和错误状态。输出 text、可选 thinking/tool，最后唯一 done。只返回请求中已有的工具，工具执行仍由宿主负责。图片输入、自动工具匹配和思考分别检查 `chatImageInput`、`chatToolMatching`、`chatReasoning`，不因名称猜测能力或丢弃不支持的输入。
- **转写与朗读**：转写接收 16 kHz 单声道 Float32 PCM，输出修订递增的 transcript，finish 时形成最终片段；朗读输出固定采样率的单声道 Float32 PCM 连续音频块。整段上传后返回文字不等于实时转写；只声明真正支持的 streamingInput/streamingOutput。
- **读图**：当前原生协议接收单张验证后的图片，不支持联合多图比较。understand/document 可带当前用户任务，extract 只提取文字。按连续序号输出 text 后唯一 done；部分输出不冒充完整结果。
- **生图与编辑**：保留参考图顺序和 requestId，按连续序号输出 PNG 块后唯一 done。声明可接受的尺寸、质量、背景不保证产物实际满足要求，仍需检查图片。

## 连接已有推理服务

在 `permissions.inferenceNetwork` 声明精确 origin，在绑定 `endpoints` 配置名称、完整 URL、内容类型与可选凭据 ID。支持 HTTPS，或显式 `http://127.0.0.1:<port>` / `http://[::1]:<port>`；不开放任意本机地址。

原生模块使用 `call.network.post(name, bytes, options?)`。请求最多 32 MiB，响应最多 48 MiB，最长 10 分钟；拒绝重定向，不继承浏览器登录态，不自动重试。完整请求上传后才发起 POST，不是持续音频流。已有引擎可直接调用时，不必为了适配额外启动 HTTP 服务。

后台通过 `inference.credentials.set({id,origin,token})` 保存 Bearer 凭据，端点仅引用 ID。宿主加密存储并在请求边界注入，不把 token 返回给原生模块；加密不可用时不降级为明文。不要把密钥放入 URL、配置、包或日志。MCP 连接使用[独立声明与认证](./capabilities#mcp)，不是此推理通道。

## 停止、更新与验收

`status()` 区分绑定、加载、活动、等待和取消状态。`stop()` 停止全部实例但保留绑定与资源；`stop({runtime})` 只停止指定运行时，后续调用可重新加载。`unbind({runtime})` 先撤销绑定再停止调用，必须重新 bind 才能继续。使用按运行时操作前检查 `runtimeIsolation`；它表示运行时之间的生命周期隔离，不表示 OS 沙箱。

更换凭据只停止引用该凭据的运行时。插件停用、更新、撤权与退出会撤销相关调用。一个调用取消不强杀仍有健康调用的共享进程；后端仍须及时响应取消。`capacity` 为 1–4，未经验证保持 1；`idleTimeoutMs` 为 0–3600000，省略为 60000，0 表示排空后立即回收。

明确失败、结果未知和部分发布必须区分。网络断开不能证明远端任务停止，进程非零退出也不能证明未生成图片；保留请求身份与已有产物，不自动重发未知请求。普通卸载保留配置与凭据，显式清理才删除；用户原文件与已发布任务产物不随插件删除。

验证目标平台的真实引擎加载、模型调用、所声明的多模态输入输出、取消、资源撤权、更新、停用及重启。清单校验、成功绑定或显示 ready 都不能代替这些运行验收。返回[开发入口](./index)选择其他能力。
