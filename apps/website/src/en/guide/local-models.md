---
title: "Local models: plugins and compatible APIs"
description: "Prepare local models and inference engines through plugins, or connect a server you run yourself. Understand resource, data, and platform limits."
---

# Local models

Local models perform inference on your computer. Lexora supports two connection paths with different setup responsibilities.

| Path | Who manages models and engines | Where to configure |
| --- | --- | --- |
| Local models plugin | The plugin provides discovery, downloads, preparation, and runtime management | The plugin page; available models appear in their relevant selectors |
| External compatible API | Your external model service | Settings → Model services → Custom API |

## Prepare models through a plugin

1. Follow the [plugin guide](./plugins) to install a trusted local models plugin. Review its version, permissions, and platform requirements.
2. Find models for chat, image understanding, speech, or image generation. Check sources, licenses, file sizes, and hardware requirements.
3. Prepare both model files and the required inference engine. Installing the plugin does not download a model; preparing an engine does not mean a model is loaded.
4. Confirm availability and enable the model, then select it in a task, [Images](./images), or [Speech](./speech). Start with a small test request.

<GuideImage src="/landing/screenshots/readme-local-models-en.webp" alt="The local models discovery page in an English Lexora app with Chinese plugin UI" caption="Discover models by purpose. The plugin interface shown here is in Chinese; check engine and device requirements before downloading." :width="1760" :height="1000" />

The plugin manages files, loading parameters, and engines. Disabling, uninstalling, or losing access to the plugin can make its models unavailable; Lexora does not silently replace them with online models.

## A chat-to-image example

For example, **Qwen3.5-9B + Z-Image** can work together on a local image task: the former understands the request and calls a tool; the latter generates an image locally, previewed beside the task.

<GuideImage src="/landing/screenshots/readme-local-image-en.webp" alt="An English Qwen3.5-9B task beside the kitten illustration generated locally by Z-Image" caption="A recorded local chat and image-generation task, with the resulting file open beside the conversation." :width="1760" :height="1000" />

This is an example, not a recommended configuration for every device. Qwen3.5-9B is not itself generating the image. Other combinations depend on tool-calling ability, plugin bindings, and actual engine support.

## Platform and resource limits

- Check the installed plugin's operating systems, architectures, and backends, then the model's RAM, VRAM, and disk requirements. File size is not runtime memory usage.
- Engines, formats, quantization variants, drivers, and acceleration backends must be compatible. A listed model is not necessarily loadable on your device.
- Native plugin execution differs by platform. Supervised native inference on Windows and macOS runs with the current user's permissions. **Process supervision is not a filesystem or network sandbox.** Review the plugin's experimental labels and supported scope. Enable only trusted plugins.
- An implementation or visible entry point does not establish testing across all hardware, models, or accelerators. Follow current plugin documentation and test on your device.

## External compatible APIs

For an independent model server, install it, start it, and load a model according to its own documentation:

1. Check that its compatible API is available.
2. Add a **Custom API** with the actual protocol, base URL, and required authentication.
3. Discover or manually add models, check enablement, and send a short test message.

`localhost` means the computer running Lexora. A server on another computer needs a reachable address. Do not expose an unauthenticated service publicly just to connect it. See [Connect a model](./settings-and-models#add-a-custom-api).

## Data and backups

Downloading engines and models usually needs networking. Their local inference runs on your computer, but search, remote MCP, online models, and cloud backups may still contact external services.

Plugin-managed inference resources are separate from ordinary plugin settings. **Selecting Plugins for backup does not include model weights and engines in managed inference storage.** External model-server data is also outside Lexora backups. Before moving devices, preserve model sources, versions, settings, and required files separately. See [Data and backups](./data-and-backup).

For loading failures, inspect the error rather than clearing the model library. See [Local engine troubleshooting](./troubleshooting#a-local-model-or-engine-will-not-start).
