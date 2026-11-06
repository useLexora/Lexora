---
title: "Provide models and multimodal capabilities"
description: "Declare inference backends, prepare engines and models, bind chat, speech and image capabilities, and manage permissions and lifecycle."
---

# Provide models and multimodal capabilities

`contributes.inference` provides model backends to the host. This differs from [tools or actions](./agent) consuming configured models through `models.generateText`. The plugin owns engines, weights, service adaptation and management pages; the host owns purpose selection, task calls, authorization, usage and cancellation. Docker deployment is not required.

## Choose a capability

| kind | Purpose and binding |
| --- | --- |
| `chat.completion` | `models` supplies stable model IDs to the host model picker |
| `speech.transcribe` | Speech input: receive PCM and emit transcript segments |
| `speech.synthesize` | Read text aloud: emit PCM audio |
| `image.read` | `imageReaders` declares `understand`, `extract`, `document` |
| `image.generate` | `imageModels` declares generation, editing and supported parameters |

Image input is a chat model's `input` capability, not a separate model purpose. Plain OCR must not claim scene understanding. Use [views](./views) and [settings](./settings) for management: background commands prepare resources, save parameters and query state, without relaying every audio or model chunk through the UI.

## Declare and bind

Merge this fragment into a manifest with plugin identity, version and a verified `engines.lexora` range. Inference requires API 3 or later, a background `entry` and `inference` permission; this does not mean every API 3/4 host supports every incremental method.

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
        "title": "Local chat",
        "kind": "chat.completion",
        "runtime": "chat"
      }]
    }
  }
}
```

The native file must be packaged and implement a backend; this declaration is not a runnable model. Runtime and capability IDs are stable and unique within their respective plugin-local lists. Capabilities reference declared runtimes. Optional `providerName` changes the model-service display name, not model or plugin identity.

Check `context.inference.capabilities?.nativeRuntime === true` in the background, then call `environment()` for the actual platform and execution mode. Bind prepared resources by the revision returned from preparation. Here, `engine` and `weights` are successful `resources.prepare` results:

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
    title: 'Local chat model',
    capability: 'completion',
    contextWindow: 32768,
    maxTokens: 2048,
    tools: false,
  }],
})
```

Parameters and resource layout depend on the actual engine; copying this binding does not make it runnable. Loading is on demand, identical bindings reuse instances, and the background rebinds after restarting. Invalid bindings preserve the previous configuration; successful binding does not prove the engine can load. Model IDs must not repeat across runtimes. Keep unavailable user selections visible rather than silently choosing another model.

## Prepare resources

`context.inference.resources.prepare({ id, kind, files }, options)` prepares an `engine` or `model` set. Each file declares a relative `path`, real SHA-256, optional byte `size` and source: an approved HTTPS URL, existing `resourceId`, or `{ directoryId, path, reference: true }`. Copying into plugin-owned storage is the default. External references depend on continuing user file authorization, not arbitrary disk access.

Downloads use ordinary `permissions.network`, including approval at every redirect. Local selection uses [file resource](./files) permissions. A new revision is committed only after every file verifies; failure or cancellation preserves the previous revision. `list()` reporting `authorized: false` means external authorization has expired, not that the set is ready. Loading rechecks files even when this flag is true.

For extraction or conversion, declare a separate `preparation: { entry: "native/prepare.mjs", platforms: [...] }`. Pass empty `files` plus preparation inputs, options, `maxBytes` and `maxFiles` to prepare. The host does not interpret archive formats; ship the decoder dependencies. The preparation entry receives the `resources.prepare` capability and emits `file → chunk → end`, awaiting `emitAsync` backpressure. Paths, hashes, budgets and process completion must all pass before commit. Linux preparation enables neither GPU nor network; supervised platforms still provide no OS isolation.

Progress `bytes/totalBytes` applies to the current path and phase. An unknown total is null, not an estimated percentage. `ready` means the whole set completed; partial progress does not replace a successful prepare result. Only promise a later, manually requested resume for identical content when `resumableDownloads` is true. Do not automatically retry.

Large engines and weights stay outside the [installation package budget](./distribution#package-contents); resource sets retain their own manifest and preparation budgets. Stop instances using a revision before removal. `remove({id,revision})` never deletes user originals. Engines, weights and local file grants are not restored by default through selective backups.

## Permissions and platform boundaries

| Platform | `environment()` execution mode | Boundary |
| --- | --- | --- |
| `linux-x64` | `isolated` | Read-only resource mounts and network isolation; unavailable sandbox prerequisites prevent startup |
| `windows-x64` | `supervised` | Current-account native process with process-tree supervision, not OS file or network isolation |
| `macos-arm64` | `supervised` | Experimental current-account process-group supervision; no OS file/network isolation or guaranteed cleanup of programs that deliberately detach |
| Other platforms/architectures | `unsupported`, null platform | Native entry does not start |

These describe execution channels, not tested compatibility for a particular engine, driver or model. Declare and ship only platform resources you have verified. Windows/macOS native code can access files, credentials, devices and networks available to the current account: install only trusted plugins. A minimal environment is not permission isolation. Adding a supervised platform requires renewed review.

GPU use requires both `permissions.inferenceGpu: true` and runtime `gpu: true`. Linux maps compute devices without exposing user directories or direct networking. On Windows/macOS, the declaration is not an OS device-denial boundary. Platform libraries, CPU/GPU/Metal selection and memory budgets belong to the plugin.

Browser backgrounds, views and [Workers](./workers) still cannot directly use Node.js or system paths. The native entry is not a general file, command or IPC bridge around those restrictions.

## Native entry and protocol

`native/*.mjs` contains precompiled ESM, using the host's Electron Node mode by default. Source packaging does not install dependencies or compile Node native modules. Prepare engines and dynamic libraries as resources; `libraryPaths` references bound mounts. If a separate runtime is needed, the plugin prepares it rather than requiring users to install one.

Export `initialize({ configuration, resources, resourceFiles })`, returning an `InferenceBackend`. `resources` maps mount directories; prefer `resourceFiles[mount][rolePath]` when present, and do not persist that mapping as new path authorization. Backend `start(capability, input, call)` returns optional `write(bytes)` and required `finish()`. Emit through `call.emit` or `emitAsync`. Do not write logs to standard output.

Binary chunks are limited to 256 KiB, control messages to 64 KiB and buffered output to 4 MiB. Stop producing when `emit` returns false and keep responding to `call.signal`. Drain owned work on cancellation; clean up normal shutdown in `dispose`. See [API reference](./api) for exact messages:

- **Chat:** receive a complete request as UTF-8 JSON chunks, up to 32 MiB, preserving roles, tool IDs and error states. Emit text, optional thinking/tool events and exactly one final done. Return only tools present in the request; the host executes them. Check `chatImageInput`, `chatToolMatching` and `chatReasoning` separately. Do not infer capabilities from model names or discard unsupported input.
- **Transcription and synthesis:** transcription receives 16 kHz mono Float32 PCM and emits transcript segments with increasing revisions, finalizing them at finish. Synthesis emits consecutive mono Float32 PCM blocks at a fixed sample rate. Text returned after a complete upload is not live transcription; declare only genuine streamingInput/streamingOutput support.
- **Image reading:** the current native protocol receives one validated image, not joint multi-image comparisons. understand/document may include the current user request; extract only transcribes text. Emit sequential text events followed by one done. Partial output is not a complete result.
- **Generation and editing:** preserve reference-image order and requestId, emit sequential PNG chunks and exactly one done. Accepted size, quality and background parameters do not guarantee that the image meets those requirements; inspect actual output.

## Connect an existing inference service

Declare exact origins in `permissions.inferenceNetwork`. Bound `endpoints` provide names, full URLs, content types and optional credential IDs. HTTPS and explicit `http://127.0.0.1:<port>` / `http://[::1]:<port>` endpoints are supported, not arbitrary local addresses.

The native module calls `call.network.post(name, bytes, options?)`. Requests are limited to 32 MiB, responses to 48 MiB and duration to 10 minutes. Redirects are rejected, browser login state is not inherited, and requests are not retried automatically. POST begins after the full request is uploaded; this is not a continuous audio stream. A directly callable engine does not need an extra HTTP service just for adaptation.

The background saves Bearer credentials through `inference.credentials.set({id,origin,token})`; endpoints reference only their IDs. The host encrypts storage and injects authorization at the request boundary without returning tokens to native modules. Unavailable encryption does not fall back to plaintext. Never place secrets in URLs, configuration, packages or logs. MCP uses [separate declarations and authentication](./capabilities#mcp), not this inference channel.

## Stop, update and verify

`status()` distinguishes configuration, loading, active, pending and cancelling instances. `stop()` stops all instances but keeps bindings and resources; `stop({runtime})` stops one runtime, allowing later calls to reload it. `unbind({runtime})` revokes its binding before stopping calls; bind again before using it. Check `runtimeIsolation` before per-runtime operations: it describes lifecycle separation between runtimes, not an OS sandbox.

Credential changes stop only runtimes referencing that credential. Disabling, updating, revocation and exit cancel affected calls. Cancelling one call does not kill a shared process with healthy calls, but the backend must still respond promptly. `capacity` is 1–4; keep it at 1 unless tested. `idleTimeoutMs` is 0–3600000, defaulting to 60000; 0 reclaims the instance immediately after calls drain.

Distinguish definite failure, unknown outcomes and partial publication. A disconnected network does not prove a remote job stopped; a nonzero process exit does not prove no image was generated. Keep request identity and existing artifacts, without automatically resubmitting unknown requests. Ordinary uninstall retains configuration and credentials; explicit cleanup deletes them. User originals and published task artifacts are not deleted with the plugin.

Verify real engine loading, model calls, declared multimodal inputs/outputs, cancellation, resource revocation, updates, disabling and restart on each target platform. Manifest validation, successful binding or a ready indicator cannot replace runtime acceptance. Return to the [development index](./index) for other capabilities.
