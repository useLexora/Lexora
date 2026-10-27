---
title: "依赖与计算"
description: "在 compiled 包中使用第三方库，并在隔离环境中运行 Worker 与 WASM。"
---

# 依赖与计算

插件可以使用浏览器生态中的库。先选择包格式，再安排初始化与计算的生命周期。

## source 与 compiled

`source` 包适合自包含 TS/JS 和相对导入。宿主固定编译器不安装 npm 依赖、不执行用户构建脚本，也不直接处理 Vue 单文件组件。

使用 Vue、React、编辑器引擎或其他运行时依赖时，在作者工程中预先打包为浏览器模块，将 JS、CSS、Worker、WASM 和资源交付为 `compiled` 包。入口仍导出 `activate` 或 `render`，安装时不再执行第三方构建配置。

预编译包的构建和打包会保留文件路径；确保运行时所需模块和二进制都在包内。避免 Node 原生模块、远程 CDN 和运行时外网导入。

## 创建 Worker

后台与视图均可使用 `context.workers.create`，无需额外 Worker 权限：

```ts
const worker = await context.workers.create(
  new URL('./calculate.js', import.meta.url),
  { type: 'module', signal: operation.signal },
)
worker.postMessage({ bytes }, [bytes.buffer])
```

`operation` 是插件为本次操作创建的 AbortController；在 Agent 回调中可直接使用本次 invocation.signal。监听结果、错误和取消，及时结束等待结果的 Promise。创建成功不代表引擎初始化完成。

源码 Worker 编译为 `.js`，创建入口指向编译后的路径。module Worker 支持包内相对导入和顶层 await；经典 Worker 的依赖需要自包含打包。

## 加载 WASM

WASM 与脚本一起打包。在 Worker 中可使用：

```js
const { instance } = await WebAssembly.instantiateStreaming(
  fetch(new URL('./engine.wasm', import.meta.url)),
  imports,
)
```

`imports` 由具体引擎提供。也可读取字节后 instantiate；WASI shim 或 Emscripten 适配仍运行在浏览器环境，不能取得真实磁盘或 Node 能力。

## 取消与资源

视图关闭终止它创建的 Worker，后台 Worker 随插件生命周期终止；隐藏不等于关闭。操作 signal 进一步限制单次计算，取消能终止同步 WASM，插件仍须处理结果 Promise 的结束。

限制并发、输入规模与结果大小。当前不承诺共享内存、多线程 WASM、OPFS 或精确 CPU/内存配额。验收应在真实 Lexora 隔离视图和后台中进行，普通网页成功不足以证明插件环境可用。
