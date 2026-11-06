---
title: "Plugin development"
description: "Build interfaces, file tools, models, multimodal capabilities, Skills, MCP connections, NPCs and themes for Lexora."
---

# Plugin development

Turn a useful workflow into an installable plugin. Provide interfaces, file handling, Agent tools, model and multimodal backends, Skills, MCP connections, NPCs or themes. Combine them through explicit dependencies, or ship one focused capability.

## Choose a starting point

- **Create through conversation:** start with [Using and creating plugins](../guide/plugins). Describe the behavior and ask your companion to produce source and an installation package.
- **Write your own plugin:** follow [Your first plugin](./quick-start) to build a counter panel with a command and instance state.
- **Maintain an existing plugin:** use the [API reference](./api) and [Build and distribute](./distribution) to check types and compatibility.

## Choose a capability

| Goal | Guide |
| --- | --- |
| Pages, panels, menus and input commands | [Views and interaction](./views) |
| File previews, editing, saving and recovery | [Files and documents](./files) |
| Send selected material to a task and reveal its source | [References](./references) |
| Model-callable tools, task events and menu actions | [Agent tools and task actions](./agent) |
| Local or API chat, speech, image reading and generation backends | [Provide models and multimodal capabilities](./inference) |
| Reusable methods, remote tool connections and specialist NPCs | [Skills, MCP and NPCs](./capabilities) |
| Bound-task statistics and model context usage | [Read-only view data](./views#read-only-data-and-bound-scope) |
| Settings, private data and state restoration | [Settings and state](./settings) |
| Colors, icons, styles and decorations | [Themes and appearance](./appearance) |
| Libraries, Workers and WASM | [Dependencies and computation](./workers) |

## Understand the boundary

Plugin backgrounds, views and browser Workers run in isolated browser environments. Native inference is a separately declared, authorized and supervised execution channel; it does not grant Node.js to these browser contexts. File, network and model access go through permissioned host APIs. Read [Core concepts](./concepts) and [Permissions and compatibility](./permissions) before adding capabilities.

Incremental APIs require the corresponding host version and available capability. Sharing an API major version does not guarantee the same set of methods.
