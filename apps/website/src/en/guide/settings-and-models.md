---
title: "Connect online model services"
description: "Connect providers and custom APIs to Lexora, authenticate, enable models, and select models for tasks and companions."
---

# Connect a model

Models interpret and generate content; Lexora organizes tasks, files, and tools. For an online model, connect a service and enable the models you need. For inference on your own computer, see [Local models](./local-models).

## Choose a connection type

Open **Settings → Model services → Add service**.

| What you have | Choose | Prepare |
| --- | --- | --- |
| A listed provider | Built-in service | An API key or supported OAuth account |
| A compatible API or company gateway | Custom API | API type, base URL, credentials, and model ID |
| A running local or LAN server | Custom API | A reachable compatible API; see [Local models](./local-models#external-compatible-apis) |

A chat website subscription does not necessarily include API credits. Check the provider's account access and billing terms.

## Add a built-in service

1. Find the provider and choose **Add**.
2. Under **Configure connection**, choose **Configure API key** or **Use OAuth** and authenticate.
3. Enable the models you need in the model configuration step.
4. Choose **Finish and enable**, select the model in a task, and send a short test message.

<GuideImage src="/guide/images/model-connection-en.webp" alt="The DeepSeek connection step with its API key configuration button" caption="Enter credentials through the dedicated setup dialog, not in a task conversation." :width="1024" :height="378" />

A saved-key status confirms storage, not valid credentials, model access, or available credits. You can resume incomplete service setup later.

## Add a custom API

Enter a display name, identifier, API type, and endpoint, then configure authentication.

- **API type** must match the actual protocol; compatibility with one interface does not imply all interfaces.
- **Endpoint** is the API base URL, not a chat website.
- **Model ID** is the name accepted by the server, not an arbitrary display label.
- **Identifier** distinguishes connections and follows the form's rules; the display name helps you recognize them.

Use **Sync models** when discovery is supported, or **Add model manually** otherwise. Newly discovered models start disabled; manually added models start enabled. Check the actual switches afterwards. Refreshing public model metadata does not grant account access.

::: details Advanced settings
Change extra headers or parameter overrides only when required. Context, output limits, native inputs, and tool-calling capabilities must match the model and protocol; changing a declaration does not add capabilities. Custom headers are stored as ordinary configuration, not encrypted credentials. Prefer the dedicated authentication field for secrets.
:::

## Choose models for tasks and companions

Set a companion's default model or select its model within a task. An avatar or name does not connect a provider. If no usable default exists, choose one explicitly.

Chat, transcription, speech synthesis, and image generation are different purposes. A chat model is not necessarily an image generator or speech model; select those capabilities in their own settings. Capability labels do not replace testing an actual request.

## Connect a local AI model

Use a plugin to manage models and engines, or connect a compatible server you run yourself. See [Local models](./local-models) for preparation and limitations.

## Tool calling mode

**Mixed**, **Code orchestration**, and **Off** change how the model calls tools, not its permissions. Configuration has moved to [App settings → Tool calling mode](./app-settings#tool-calling-mode).

## Inspect usage and resolve connection problems

**Settings → Usage** covers calls initiated by Lexora; the provider's bill remains authoritative. See [Troubleshooting](./troubleshooting) for missing models, authentication failures, and timeouts.

## Continue configuring

- [Images](./images): native vision, independent image reading, generation, and OCR.
- [Speech](./speech): transcription, read-aloud sources, and testing.
- [Search and web browsing](./web-browsing): search, direct reading, and browser interaction.
- [App settings](./app-settings): preferences, usage, proxies, and updates.

<a id="plugins-extend-the-workspace"></a>

## Plugins

For installation, permissions, and management, go to [Plugins: extend the workspace](./plugins). This entry preserves old links without duplicating the plugin guide.
