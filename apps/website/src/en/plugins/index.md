---
title: "Plugin development"
description: "Build interfaces, file tools, Agent capabilities and themes for Lexora."
---

# Plugin development

Turn a useful workflow into an installable plugin. Combine interfaces, file handling, Agent tools, Skills and themes, or provide just one focused capability.

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
| Agent tools, task actions and packaged Skills | [Agent capabilities](./agent) |
| Settings, private data and state restoration | [Settings and state](./settings) |
| Colors, icons, styles and decorations | [Themes and appearance](./appearance) |
| Libraries, Workers and WASM | [Dependencies and computation](./workers) |

## Understand the boundary

Plugin backgrounds and views run in isolated browser environments. File, network and model access go through permissioned host APIs. Read [Core concepts](./concepts) and [Permissions and compatibility](./permissions) before adding capabilities.

Incremental APIs require the corresponding host version and available capability. Sharing an API major version does not guarantee the same set of methods.
