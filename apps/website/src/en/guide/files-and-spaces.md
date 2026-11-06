---
title: "Files and spaces: folders, split views, and previews"
description: "Organize projects in Lexora spaces, choose working folders, manage files, and open tasks and previews side by side. Reference source material as you refine results."
---

# Files and spaces

Spaces organize related tasks. Working directories hold actual files. Knowing the difference helps you find the work, locate the result, and continue later. A task without a space also has its own managed working directory; creating a space is not required to write files.

## Create a space for related work

A “Travel plans” space could contain separate tasks for a route, packing, and a journal. Each task stays focused while remaining easy to find under one topic.

1. Create a space in the task sidebar and give it a recognizable name.
2. Select a local working directory if you need existing files.
3. Create a task inside the space, or select that space from a new task's composer.

Selecting a working directory also trusts its context files and Skills. Choose a directory relevant to the work. Granting additional directory access later does not automatically load everything there as context.

## Prepare a clear directory

For example:

```text
travel-plans/
├── materials/
│   └── city-walk-notes.md
└── drafts/
```

Then name relative paths in your request:

> Read materials/city-walk-notes.md and save the route as drafts/weekend-route.md. Keep the original notes unchanged.

This makes both finding inputs and checking outputs easier. The file tree represents disk files: renaming, copying, and moving affect the actual files.

## Open materials beside the conversation

Use the task header's pane menu to split left, right, above, or below, or drag a task to the target edge. Open files in the materials area beside your tasks. Each task keeps its own context and composer; splitting does not share materials automatically.

<GuideImage src="/landing/screenshots/workspace-en.webp" alt="Two task conversations beside a file preview" caption="Splitting changes the layout; it does not combine the contexts of separate tasks." :width="1504" :height="1018" />

Select text in a preview and quote it into the target task. With several panes open, check that the quote reached the correct composer before sending.

## Choose how a file opens

Use **Open with** at the file entry to choose an available provider. Built-in previews handle supported text, Markdown, images, and other content; installed plugins can add editors for specific formats. The file-opening settings page lets you choose a default by suffix, separately for inline previews and standalone opening.

Review requested file associations during plugin installation; you do not have to accept every default. If a plugin is disabled or unavailable, opening may fall back to the built-in provider. That does not mean the file is missing. For DOCX, XLSX, PPTX, and PDF editing and quoted-selection updates, see [Documents](./documents).

## Files, attachments, and task references

| Method | When to use it |
| --- | --- |
| File reference | Record the original path for on-demand reading, not automatic inclusion of the full text |
| Selection quote | Preserve selected content and its source for discussion or a targeted change |
| Attachment copy | Preserve the supplied bytes for this input; editing the copy does not edit the original |
| Task reference | Look up permitted content from another task as needed |

Selecting or dragging in a local file with a path usually keeps a reference to the original. Pasted images and other inputs without a source path become attachment copies. Supported media may also get a snapshot for model input; direct understanding depends on the model, format, and size. Attached does not mean fully read.

A reference does not grant unrestricted directory access. Verify requested locations. Historical quotes preserve content from that moment; if the original changes, its current content must be checked before editing.

## Find and resume earlier work

Use descriptive titles such as “Weekend walking route” and pin frequent tasks. Tasks match titles or space names; spaces can also be found by directory paths. This is not full-text message search; see [Task history](./ai-chat#find-earlier-tasks).

Reopen a task to inspect its conversation and execution records, then say which result to continue from. Preserving progress across launches does not mean every interrupted external command automatically runs again.

## Confirm changes reached the file

Say whether to change the original or make a copy: “Update drafts/weekend-route.md and leave the source notes untouched.” Unsaved editor content, text in a reply, and a disk file are different states.

Check the save location and open the actual file. If there is an external-change conflict, compare current content before overwriting it. Stopping a task or changing conversation branches does not undo disk writes. Follow each plugin editor's save and export behavior.

## Back up external files separately

Lexora backups can include managed workspace files, but do not include your entire external working directory. Keep using file backups or version control for external repositories, original artwork, and other materials.

See [Data and backups](./data-and-backup) for backup scope and restoration.
