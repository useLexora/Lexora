---
title: "Core concepts"
description: "Understand manifests, backgrounds, views, Agent invocations and state ownership."
---

# Core concepts

A plugin contains a manifest, optional background and view entry points, and packaged assets. Decide which part owns each behavior before choosing APIs.

## The manifest declares capabilities

`extension.json` declares a stable plugin ID, version, compatibility range, permissions and contributions. Users review this information during installation. Display names and author attribution may change; upgrades preserve plugin and contribution IDs.

Contributions include commands, views, navigation, file handlers, launchers, Agent tools and actions, inference, settings, Skills, MCP connections, NPCs, themes and icon themes. Declarative theme, Skills, MCP or NPC packages need no script entry point; sharing a package does not automatically connect their behavior.

## Three execution contexts

These three contexts cover browser plugin logic. Model providers may additionally use a separate native inference entry.

| Context | Entry | Responsibilities |
| --- | --- | --- |
| Background | `activate(context: ExtensionContext)` | Register commands, tools and actions; manage shared data and schedules |
| View | `render(context: ViewContext, container)` | Render its own UI; handle resources, interaction and instance state |
| Agent invocation | Registered tool or action callback | Use capabilities bound to the original task and model; handle cancellation |

The background is also a browser sandbox. It cannot use Node.js, shell commands or arbitrary disk paths. Views cannot access the host DOM. An Agent callback uses the task captured by the host, not whichever task is focused later.

[Native inference](./inference) uses a separate `native/*.mjs` entry and resource binding; it does not turn the background into Node. Use invocation `models` to consume configured models, and `contributes.inference` to provide models to the host. See [Skills, MCP and NPCs](./capabilities) for declarative contributions and their lifecycles.

## Declare, register and invoke

Declare commands, tools and actions in the manifest, then register matching handlers during activate. Views call their own commands to communicate with the background; the background uses `views.broadcast` for JSON messages to its current views.

A view definition describes content; a placement describes where it appears. [Read-only data](./views#read-only-data-and-bound-scope) separately requires `permissions.data` and a host-bound scope; display position does not grant data access. Multiple instances have independent JavaScript environments and state. Hiding may retain an instance; closing or disabling ends the relevant lifecycle.

## State ownership

| Content | API |
| --- | --- |
| Native settings rendered by the host | `configuration` |
| Private plugin JSON business data | Background `storage` |
| Reading position and filters for a resource tab or regular mount | View `state` / `setState` |
| Downloaded or generated binary copies | `resources` |
| Editable content, original file binding and recovery drafts | Interactive view `documents` |

A dirty marker, title or layout does not save content. See [Settings and state](./settings) and [Files and documents](./files).

## Cleanup and upgrades

Add background registrations to `context.subscriptions`. Bind view listeners, timers and asynchronous work to `context.signal`; use the current `invocation.signal` for Agent operations.

`dataVersion` controls private JSON migration, while view `stateVersion` controls instance state migration. Preserve existing content when conversion fails. Ordinary uninstall and clearing data have different effects, described in the [user guide](../guide/plugins).
