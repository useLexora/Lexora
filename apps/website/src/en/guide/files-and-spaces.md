---
title: "Files and spaces: folders, split views, and previews"
description: "Organize projects in Lexora spaces, choose working folders, manage files, and open tasks and previews side by side. Reference source material as you refine results."
---

# Files and spaces

Spaces organize related tasks. Working directories hold actual files. Knowing the difference helps you find the work, locate the result, and continue later.

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

Use pane menus to split left, right, above, or below, keeping tasks, references, and previews together. Multiple tasks retain separate context and composers.

<GuideImage src="/landing/screenshots/workspace-en.webp" alt="Two task conversations beside a file preview" caption="Splitting changes the layout; it does not combine the contexts of separate tasks." :width="1504" :height="1018" />

Select text in a preview and quote it into the target task. With several panes open, check that the quote reached the correct composer before sending.

## Files, attachments, and task references

| Method | When to use it |
| --- | --- |
| File reference | Point to a local file and continue working with it |
| Selection quote | Discuss or change one passage |
| Attachment | Include a file or image in the input; direct reading depends on model and processing capabilities |
| Task reference | Reuse information discussed in another task |

A reference does not grant unrestricted directory access. When access is requested, verify that the location belongs to the current work.

## Find and resume earlier work

Use descriptive titles such as “Weekend walking route.” Pin frequent tasks. Task search can locate work by title, space name, or working directory.

Reopen a task to inspect its conversation and execution records, then say which result to continue from. Preserving progress across launches does not mean every interrupted external command automatically runs again.

## Back up external files separately

Lexora backups can include managed workspace files, but do not include your entire external working directory. Keep using file backups or version control for external repositories, original artwork, and other materials.

See [Data and backups](./data-and-backup) for backup scope and restoration.
