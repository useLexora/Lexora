---
title: "Files and documents"
description: "Build previews, original-file editing, exports and recovery with shared APIs."
---

# Files and documents

Plugins parse file formats. The host provides authorization, transfer, version checks and save lifecycles for text, tables, images and other binary content.

## Open a plugin from a file

API 4 fileHandlers register exact suffixes and separate preview/open behavior. Use a selected-file or optional-file view and request selectedResource read access.

```json
{
  "fileHandlers": [{
    "id": "example.reader.files",
    "title": "Reader",
    "extensions": [".md"],
    "preview": { "view": "example.reader.main" },
    "open": { "view": "example.reader.main" }
  }],
  "launchers": [{ "id": "example.reader.start", "title": "Reader", "view": "example.reader.main" }]
}
```

This is a contributes fragment: declare the referenced view and replace example IDs. Launchers open none/optional-file views with a null resource; file handlers receive a resource from the host.

## Read and create resources

| Operation | API |
| --- | --- |
| Pick additional files or a directory | `pickFiles` / `pickDirectory` |
| Read UTF-8 text | `readText`, up to 1 MiB |
| Read binary chunks | `readBytes`, up to 128 KiB per call |
| Images, media and Range requests | `getUrl`, scoped to the session |
| Create an immutable private file | `createFile` |
| Copy already authorized content | `importFile` |
| Export to a confirmed destination | `saveFile` |

Persist resource IDs and acquire fresh URLs per session. Handles do not reveal arbitrary disk paths. Create a new private version, commit its metadata pointer, then release the previous version; retain old content on failure.

## Edit originals and recover

Original editing uses API 4 fileEditing and the interactive view documents API. Plugins adopting this editing capability should require Lexora 0.17.0 or later and verify their target host.

A Document represents editable content, either bound to a disk file or still unsaved. Plugins own format parsing, editing buffers and UI.

| Stage | API | User-visible meaning |
| --- | --- | --- |
| Open | `pick()` / `open(context.resource)` | Opened, not modified yet |
| Create | `create({name,data})` | Unsaved content |
| Maintain recovery | `backup(document,{data})` | Modified; recovery content retained |
| Save original | `save(document,{data})` | Saved only after success |
| Save to a new location | `saveAs({name,data})` | New document identity after confirmation |
| Recover | `list()`, `resume({id})`, `read()` | User chooses recovery and subsequent saving |

Version describes the original-file baseline; revision describes editable content. Use the new handle returned by backup/save. Saving checks file identity and external changes; preserve recovery and surface conflicts instead of overwriting.

Exporting a copy should preserve the current original binding and dirty state. Recovery is not an original save; AI edits follow the same rule.

## Closing and failure

Register onBeforeClose to wait for the current save queue and explicitly allow closing. Cancellation, failure or timeout should retain the editor. It cannot intercept crashes or forced disabling, so maintain recovery during normal editing.

Retained recovery remains readable and can be saved elsewhere when the original is unavailable or its authorization is revoked. Reauthorize access to the original. If a save outcome is unknown, resume and inspect before issuing another operation.

Verify save read-back, external conflicts, cancellation, competing views, restart recovery and exporting a copy.
