---
title: "Connect model providers, local AI, and custom APIs"
description: "Connect model providers to Lexora with API keys or OAuth. Configure custom and local APIs, enable models, set companion defaults, and troubleshoot connections."
---

# Connect a model

The model service interprets and generates content. Lexora brings conversations, files, tools, and execution into the same workspace. Before starting, authenticate a service and enable the models you want to use.

## Choose a connection type

Open **Settings → Model services → Add service**.

| What you have | Choose | Prepare |
| --- | --- | --- |
| A listed provider | Built-in services | An API key or an OAuth account supported by that service |
| A compatible API or company gateway | Custom API | API type, endpoint, credentials, and model ID |
| A local or LAN model server | Custom API | A running compatible endpoint, model ID, and any required credentials |

Lexora does not install or start local model servers. Start the service according to its own instructions, then add its connection.

## Add a built-in service

1. Find the provider under **Built-in** and choose **Add**.
2. In **Configure connection**, choose **Configure API key** or **Use OAuth**. Obtain keys from the provider's console; follow the browser instructions for OAuth.
3. In the model configuration step, enable the models you need.
4. Choose **Finish and enable**. Return to a task, select the model, and send a short message to check the connection.

<GuideImage src="/guide/images/model-connection-en.webp" alt="The DeepSeek connection step with its API key configuration button" caption="Enter credentials through the dedicated setup dialog, not in a task conversation." :width="1024" :height="378" />

A saved-key status confirms storage. Successful requests still depend on valid credentials, model access, balance, and networking. A short conversation is the most direct check.

## Add a custom API

Under **Custom API**, fill in the display name, identifier, API type, and endpoint, then configure authentication.

- **Display name** helps you recognize the connection, such as “Home model server.”
- **Identifier** distinguishes configurations. Follow the form's rules and avoid duplicates.
- **API type** must match the protocol the server actually provides. Supporting one interface does not imply support for all interfaces.
- **Endpoint** is the API base URL from the service documentation, not its chat website.
- **Model ID** is the name the server accepts, not just a display label you invented.

After authentication, use **Sync models** if discovery is supported. Otherwise, choose **Add model manually**. In either case, explicitly enable the models you want to use.

::: details When should I change advanced settings?
Only when the service needs extra request headers or you deliberately need to override model parameters. Context window, output limits, and input capabilities should match the service. Raising a number does not raise its server-side limit. Get a minimal request working with defaults first, then change one setting at a time.
:::

## Connect a local AI model

If you run a model service on your computer or local network, connect its compatible API to Lexora:

1. Start the service and check that it has loaded a model and exposed its API.
2. Add a **Custom API** with the protocol, base URL, and credentials it requires. `localhost` means the computer running Lexora; a service on another machine needs an address that Lexora can reach.
3. Discover or manually add a model, enable it, and send a short message to check the connection.

The local model handles inference; Lexora organizes tasks and tool execution. A local model does not make every action offline: web tools, remote MCP servers, and backups can still use the network.

## Choose models for tasks and companions

Model selection is associated with companions. Set a default model in a companion's configuration, or select one for that companion in a task. Choosing a DeepSeek, Claude, or ChatGPT avatar does not connect the corresponding provider automatically.

A fast model may suit simple organization. Images, complex material, and tool use need appropriate model capabilities. Check the actual configuration and service documentation rather than relying on the name.

## Inspect usage and resolve connection problems

**Settings → Usage** shows the usage Lexora records, including task and model breakdowns. Your provider's console remains authoritative for billing and quotas.

| Symptom | Check first |
| --- | --- |
| No models in the task | Service setup is complete and at least one available model is enabled |
| Authentication required | Key validity or whether OAuth needs authorization again |
| Model not found | Exact model ID and your account's access |
| Connection times out | Server status, endpoint, network, and proxy settings |
| Text works but images do not | Image support in this model and API protocol |

Once connected, return to [your first task](./quick-start), or read [Companions and collaboration](./companions) to assign different models to different roles.
