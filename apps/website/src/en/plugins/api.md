---
title: "API reference"
description: "Find manifest fields and public types for backgrounds, views, Agent calls and events."
---

# API reference

Choose interfaces by execution context. The declaration below is included directly from the current public SDK; match required permissions and the target host version.

## Find an object

| Object | Purpose | Guide |
| --- | --- | --- |
| ExtensionContext | Background commands, registrations, data, notifications and schedules | [Concepts](./concepts) |
| ViewContext | UI, resources, clipboard, references, state and closing | [Views](./views) |
| ResourceApi / LocalResourceApi | Read, create and export private or authorized files | [Files](./files) |
| DocumentApi / EditableDocument | Content revisions, original saves and recovery | [Documents](./files#edit-originals-and-recover) |
| AgentToolContext / AgentActionContext | Original-task tools and independent actions | [Agent](./agent) |
| ReferenceInput / ReferenceReveal | Material snapshots and source reveal | [References](./references) |
| WorkerApi | Packaged Worker lifecycle | [Computation](./workers) |
| EventSubscriber / TaskActionEvents | Scoped events and action causes | [State](./settings) |

## Manifest fields

Extension.json requires schemaVersion 1, a stable id, name, version, apiVersion and engines.lexora. Format selects source/compiled. Provide entry when background code is needed. Declare permissions and contributions for actual capabilities; see [Your first plugin](./quick-start#declare-the-plugin).

Optional author attribution is independent of identity; icon points to a packaged image. DataVersion and a view's stateVersion govern separate migrations. Do not infer Lexora fields from another product's manifest.

## Complete type declaration

Copy this declaration as lexora.d.ts and use import type. Independent SDK export uses the same source. A declared interface may require a newer host than the installed version.

::: details Expand the public SDK types
<<< @/../../buddy/service/resources/skills/plugin-creator/references/api.d.ts
:::

## Errors and compatibility

Asynchronous APIs return promises. Cancellation may return a value or reject depending on the method. Save conflicts, revoked authorization and expired views are not success. Model truncation rejects with EXTENSION_MODEL_TRUNCATED rather than presenting incomplete text as a completed answer.

Check [Permissions and compatibility](./permissions) and verify critical flows on your target host before upgrading.
