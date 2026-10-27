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

## Editor interactions

`setDocumentInfo({title,dirty})` changes metadata, not file content. Use onBeforeClose to wait for saving, and maintain recovery drafts during editing; see [Files and documents](./files).

Clipboard read/write requires independent permissions and foreground visibility and focus. Text plus HTML is limited to 4 MiB. Operations fail after closing or losing focus; navigator.clipboard does not replace the SDK bridge.

## Verify the interface

Check independent instances, page switching, theme changes, reopen paths and disabling. Replacement controls also need stale-proposal rejection and a working default fallback on failure.
