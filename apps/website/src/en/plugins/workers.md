---
title: "Dependencies and computation"
description: "Package browser libraries and run Workers and WASM within plugin isolation."
---

# Dependencies and computation

Use browser-compatible libraries, choose the package format, then bind initialization and computation to the right lifecycle.

## Source and compiled packages

Source packages support self-contained TS/JS and relative imports. The fixed host compiler does not install npm dependencies, execute build scripts or directly compile Vue single-file components.

Prebuild Vue, React, editor engines and other runtime dependencies in your authoring project. Deliver browser JS, CSS, Workers, WASM and assets as a compiled package. Entry points still export activate or render; installation does not run third-party build configuration.

Compiled-package build and pack operations preserve files and paths. Include all required modules and binaries. Avoid native Node modules, CDNs and external runtime imports.

## Create a Worker

Both background and view contexts provide workers.create without an extra Worker permission:

```ts
const worker = await context.workers.create(
  new URL('./calculate.js', import.meta.url),
  { type: 'module', signal: operation.signal },
)
worker.postMessage({ bytes }, [bytes.buffer])
```

Operation is an AbortController for this operation; Agent callbacks can use invocation.signal. Handle results, errors and cancellation so the waiting Promise settles. Worker creation does not guarantee engine readiness.

Source Workers compile to .js; point creation at the compiled path. Module Workers support packaged relative imports and top-level await. Classic Worker dependencies must be bundled into a self-contained script.

## Load WASM

Package WASM with its JavaScript and load it in the Worker:

```js
const { instance } = await WebAssembly.instantiateStreaming(
  fetch(new URL('./engine.wasm', import.meta.url)),
  imports,
)
```

The engine defines imports. Alternatively instantiate from bytes. Browser WASI shims and Emscripten glue do not acquire a real filesystem or Node access.

## Cancellation and resources

Closing a view terminates its Workers; background Workers follow the plugin lifecycle. Hiding is not closing. An operation signal further bounds one calculation; cancellation terminates synchronous WASM, while the plugin must still settle its message-protocol Promise.

Limit concurrency, input size and output size. Shared memory, multithreaded WASM, OPFS and exact CPU/memory quotas are not promised. Verify in actual Lexora views and backgrounds; success in an ordinary webpage is insufficient.
