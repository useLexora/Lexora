---
title: "Views and interaction"
description: "Choose pages, resource tabs, mounted panels, menus and input commands."
---

# Views and interaction

Decide how users enter the feature, where they interact, and how they reopen it after closing.

## Choose a surface

| Need | Contribution |
| --- | --- |
| Independent navigation page | `navigation` referencing a `resource: "none"` view |
| File or general tool tab | `location: "context"`, opened by a command, handler or launcher |
| Workbench or pane panel | A `kind: "view"` placement with target and presentation |
| Host content area or control | `kind: "slot"` / `"control"`, with host-owned placement and fallback |
| Decoration without pointer input | `kind: "decoration"` on a public anchor |

Render with `render(context, container)`. The container fills its isolated viewport with no default padding. The plugin owns its layout and cannot access the parent DOM. Prebuild Vue or React into browser modules; see [Dependencies](./workers).

## Commands and menus

Declare commands and register matching handlers in the background. Use `hidden: true` for commands intended only for your views. A slash declaration uses `/plugin-call-name:command` and runs without automatically requesting a model.

Menus place declared commands in public targets. Selected text is supplied only after a click and with selectedContent permission; files use their own resource permission. An input menu may return `{insertText}`; the host inserts it only into the unchanged original draft and does not send it.

```ts
context.subscriptions.add(
  context.commands.register(`${context.extension.id}.open`, async () => {
    await context.views.open(`${context.extension.id}.panel`)
  }),
)
```

## Placement and visibility

Presentation describes the outer frame's position, dimensions and order. Background `placements.show/hide` opens or closes regular mounts; a view can update its frame with setPresentation. Keep the originating pane instanceId across asynchronous operations.

The `when` condition uses public page context. Visibility callbacks report whether the view is actually visible. A hidden view may retain its instance and subscriptions; the plugin decides whether to pause media or animation. Restoration should not replay user actions.

For slots and controls, show/hide changes availability in the current background lifecycle. Store persistent preferences separately. `setActive(false)` yields to the host's default content when the plugin has nothing to display.

## Read-only data and bound scope

Presentation, data sources and authorization are independent. Declare each source needed in the manifest:

```json
{ "permissions": { "data": ["task.metrics", "context.usage"] } }
```

`context.data.read({ source, scope: 'bound' })` reads a snapshot; `observe(query, listener)` observes changes. Both use only the scope bound by the host to this instance. They accept no arbitrary `taskId`, `branchId` or `actorId`, and never follow another pane's focus. An unbound page returns `no_target`; mounting in a footer, decoration or slot does not grant access. Backgrounds and Workers have no global data entry point.

| Source | Scope and values |
| --- | --- |
| `task.metrics` | Visible branch run tree of the bound task; `turns`, `steps`, input/output and cache tokens, and `throughput` |
| `context.usage` | Model context for the bound task, branch and actor; `tokens`, `window`, `percent`, not historical token totals |

Statistics share the built-in task panel's source, but that panel defaults to the whole task: compare only equivalent scopes. `throughput.tokensPerSecond` divides valid samples' total output tokens by their total output duration. With no valid samples it is `null` and `samples` is 0. Do not invent missing context or timing facts.

Snapshots are read-only `{ source, status, value }`. Only `ready` has a value. `denied` means missing source permission, `no_target` means no binding, and `unavailable` means temporarily unavailable; all three have null values. Do not show them as zero or retain another task's value. Protocol and transport failures still reject direct-read promises.

```ts
import type { ViewContext } from './lexora'

export function render(context: ViewContext, container: HTMLElement) {
  context.data.observe({ source: 'task.metrics', scope: 'bound' }, (snapshot) => {
    container.textContent = snapshot.status === 'ready'
      ? `Turns ${snapshot.value.turns} · Steps ${snapshot.value.steps}`
      : ''
  })
}
```

`observe` asynchronously delivers the initial state, including denied, and keeps observing after no_target. Do not read first and then observe. Its Disposable stops callbacks early; view closure or signal cancellation cleans up subscriptions. Recovery supplies the current snapshot, not every intermediate value. The underlying `data:changed` event does not establish an observation by itself; normally no extra event listener is needed.

## Editor interactions

`setDocumentInfo({title,dirty})` changes metadata, not file content. Use onBeforeClose to wait for saving, and maintain recovery drafts during editing; see [Files and documents](./files).

Clipboard read/write requires independent permissions and foreground visibility and focus. Text plus HTML is limited to 4 MiB. Operations fail after closing or losing focus; navigator.clipboard does not replace the SDK bridge.

## Verify the interface

Check independent instances, page switching, theme changes, reopen paths and disabling. For data views, also check pane binding, per-source denial, no-target state, recovery and revocation, not just rendered numbers. Replacement controls also need stale-proposal rejection and a working default fallback on failure.
