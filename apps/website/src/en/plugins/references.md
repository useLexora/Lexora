---
title: "References and source reveal"
description: "Send plugin material to a task draft and find the original location again."
---

# References and source reveal

A reference preserves a snapshot of selected material and connects it to its source. Adding one does not save the document, send a message or request a model.

## Add material

An interactive API 4 view with references permission can call:

```ts
const accepted = await context.references.add({
  kind: 'content',
  title: 'Selected paragraph',
  text: selectedText,
  locator: { version: 1, data: { documentId, paragraphId } },
})
```

The host offers existing drafts, a new task or copying the reference. Success returns true and cancellation returns false. Use `{kind:'resource',resource}` for a whole authorized file.

Text is the captured content; locator is bounded plugin-defined JSON, not a path grant. References normally bind to the current resource. A none/optional-file view managing its own content can explicitly use `source: 'view'`.

## Reveal the source

Register an onReveal handler, validate the locator version and content, then scroll or select the source. Return true only after it is revealed.

```ts
context.references.onReveal(async ({ locator, text }, signal) => {
  if (!locator || locator.version !== 1)
    return false
  return revealSelection(locator.data, text, signal)
})
```

Implement revealSelection in your plugin and respect signal. Return false when the source cannot be restored. The saved reference text remains readable if the original becomes unavailable.

## Use your own menu

Lexora 0.17.0 introduces capture → commit/release for editor menus. Capture fixes the material and eligible draft targets; commit the chosen target after a click and release on dismissal. Captures cannot move between views, survive restart or retarget a later-focused task.

## Resolve references in Agent tools

Invocation references list/resolve only exposes this plugin's committed user references within the original run's visible scope. Unsent drafts, other branches or plugins, and assistant material do not grant that access. Actions have no reference resolver.

Retain both referenceId and sourceMessageId. Read long content in pages; textLength and textDigest describe the complete snapshot, not the first page. Keep locators inside the plugin instead of turning them into model instructions.

Before editing, revalidate reference eligibility, document identity, session and revision. Bind to the original target rather than current focus; a reference does not itself grant editing permission.
