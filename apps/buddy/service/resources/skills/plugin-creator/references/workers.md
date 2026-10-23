# WebAssembly 与 Worker

插件后台和视图都支持浏览器原生 WebAssembly，以及 `context.workers.create()`。无需新增权限；文件、网络、导出等能力仍受原有授权控制。后台也是浏览器沙箱，不是 Node.js。使用新增运行时能力时，`engines.lexora` 的最低版本必须覆盖实际提供该能力的宿主；不能只沿用旧插件的宽泛版本范围。

## 创建与加载

```ts
const worker = await context.workers.create(
  new URL('./calculate.js', import.meta.url),
  { type: 'module', signal: operation.signal },
)
worker.addEventListener('message', ({ data }) => {
  if (!operation.signal.aborted)
    showResult(data)
})
worker.addEventListener('error', () => showError())
worker.postMessage({ bytes }, [bytes.buffer])
```

`entry` 可以是包根相对路径（例如 `workers/calculate.js`），也可以是当前插件会话内的包资源 URL。只接受 `.js` / `.mjs`；拒绝网络地址、其他会话、资源句柄端点、宿主脚本、查询参数和 fragment。包内文件继续经过完整性校验。

- `type` 默认 `classic`；经典 Worker 使用自包含脚本。不要根据 Worker 的 blob URL 推导其他资源地址；由调用方提供包内绝对 URL 或字节。
- `module` 表示 ES module 入口：通过独立经典 Worker 引导器动态导入原包 URL，保留 `import.meta.url`、包内相对模块导入与 top-level await。隔离视图不依赖浏览器对不透明来源原生 module Worker 根脚本的支持，也不回退主线程。
- `name` 用于调试识别。
- 返回的是标准 `Worker`；消息使用 structured clone，支持 `ArrayBuffer`、typed array 和 transfer list，不经过插件 JSON RPC。首个 `message` 监听器注册前的入站消息会缓存，注册后逐条按独立任务派发，保留消息之间的微任务执行机会；可在顶层 `await` 中等待初始化消息。模块没有注册监听器时，导入结束后释放缓冲。缓存事件会重新派发，因此不要把其 `isTrusted` 用作授权依据。
- `create()` 成功表示 Worker 已创建，不代表引擎初始化完成。插件或引擎库负责自己的就绪、进度、结果及错误协议；Worker 加载失败不会回退到页面执行。

源码包的 Worker `.ts` / `.mts` 与其他脚本一样编译为 `.js`；创建入口应指向编译后的 `.js` 路径。经典 Worker 的第三方依赖需要预先打包为自包含脚本；模块入口可使用包内相对 import，不能运行时从 CDN 加载。

WASM 文件与 JS 一起打包，响应类型为 `application/wasm`。模块 Worker 中可使用：

```js
const { instance } = await WebAssembly.instantiateStreaming(
  fetch(new URL('./engine.wasm', import.meta.url)),
  imports,
)
```

也可先取得字节再调用 `WebAssembly.instantiate(bytes, imports)`，或使用第三方库的浏览器加载器。允许插件携带 WASI shim、Emscripten glue 等纯浏览器适配；它们不获得真实文件系统或 Node 能力。只在构建插件时编译 Rust/C/C++，安装阶段不执行这些工具链或第三方安装脚本。

## 生命周期与取消

- 视图 Worker 随该视图销毁终止；隐藏视图不等于销毁，是否暂停由插件决定。
- 后台 Worker 随插件停用、重启或宿主退出终止，不依赖是否有页面打开。`ExtensionContext.signal` 表示当前后台宿主生命周期。
- `options.signal` 在以上生命周期之内进一步限定一次操作。Agent 工具或动作中传入本次调用的 `signal`，调用结束或取消后不保留该操作的 Worker。
- 手动 `worker.terminate()` 可提前释放 Worker 及其入口 URL；Worker 执行错误也会释放托管实例。
- 切换输入或开始新查询时，用独立 `AbortController` 取消旧操作；需要期限时组合 `AbortSignal.timeout()`。取消会终止 Worker，可以中断同步 WASM，而不是只发送一条等待引擎处理的消息。
- 业务层等待结果的 Promise 仍需监听取消和错误并及时拒绝。终止 Worker 不会替插件完成自定义消息协议；不得把超时后仍在计算视为已取消。
- Worker 内的会话和内存数据不会自动保存或恢复。重建需要重新授权读取输入，不自动重放有副作用的操作。

浏览器的资源隔离不等于精确 CPU 或内存配额。限制输入规模、输出数量和同时运行的作业，及时释放引擎。单线程 WASM 不要求 `SharedArrayBuffer`；当前不承诺共享内存、多线程 WASM 或 OPFS。JS `eval` / `Function` 仍被 CSP 禁止。
