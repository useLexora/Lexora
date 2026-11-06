---
title: "Documents: the Office plugin, quoted edits, and export"
description: "Use the installable Lexora Office plugin with DOCX, XLSX, PPTX, and PDF. Distinguish local originals, the document library, selection quotes, saving, exporting, and format-fidelity limits."
---

# Documents

Before asking a companion to draft a report, organize a spreadsheet, or revise slides, prepare tools for that format. This page uses the **installable Lexora Office plugin** as an example. Office editing is not built into Lexora, and this does not promise lossless editing of arbitrary documents.

## Prepare the plugin and file

1. Follow the [plugin guide](./plugins) to install and enable Lexora Office. Review its source, permissions, and file associations.
2. Create new documents in the Office library. For an existing local file, use the plugin's local-file opener or select Office through the file entry's **Open with** action.
3. Open a copy first and check that the content displays correctly. Back up important originals separately, especially complex files.
4. In the task, state the goal, target content, and delivery format. If the companion cannot find Office tools, check the plugin's enabled state and the companion's capabilities.

Local files can be edited directly without importing them. Only files created in Office or explicitly imported are managed by the library. Matching names do not make two files the same document.

## What each format is useful for

| Format | Tasks to try | What to check |
| --- | --- | --- |
| DOCX | Draft text; adjust headings, lists, tables, and passages | Structure, tables, tracked changes, and actual layout in the editor |
| XLSX | Write data and explicit formulas; format cells, sheets, rows, and columns | Data types, sheet and range, formula text, and calculated results |
| PPTX | Create or revise slide text, element positions, and styles | Overflow, overlap, alignment, and readability on each slide |
| PDF | Work with supported text, annotations, forms, and page operations | Original page location, fonts, fixed layout, and edited page appearance |

Available operations depend on the installed version and current file. Opening a file does not make every object editable. Reading an excerpt is not the same as seeing the full layout.

## Turn a selection quote into a targeted edit

For a specific change, provide a selection rather than only saying “change this.”

1. Select text, a cell range, or a supported object in the Office editor and quote it into the intended task. References offered by a standalone page can also be copied and pasted into the task.
2. Check the reference card and document source. State what to change, what to preserve, and whether to save the original.
3. Let the companion verify and edit the current content, then inspect the same location in the editor.
4. Confirm saving or exporting, then open the delivered file to check it.

For example:

> Turn the quoted passage into three action points. Preserve the facts and leave other paragraphs unchanged. Check the result, save the original, and export a DOCX copy to this task for download.

A quote preserves the selection at that moment; **quoting does not save the document**. Historical excerpts remain readable, but writing back requires checking the current text and location. If the text changed, the location is ambiguous, or an unsaved editing session was closed, an old quote is not enough to overwrite content. Reopen the exact file and quote again when needed.

For explanation or summarization only, specify “Analyze only; do not modify.”

## Saving originals, the library, and export

| Action | What it means |
| --- | --- |
| Edit a local file | Changes may still be in the editing buffer; saving explicitly writes them to the bound original |
| Create or edit in the library | The library saves automatically; this does not itself publish a task deliverable |
| Export to a task | Publish a copy of the current content in its original format; this neither saves the local original nor clears its unsaved state |
| Save as | Switch to a new bound file, unlike saving a copy or exporting |

Specify the location, whether to overwrite the original, and the required format. A companion saying “done” is not proof of a successful disk write. If saving conflicts or the outcome is unknown, inspect the current file before applying the same edit again.

The library offers naming, favorites, trash, and available historical versions, but does not replace long-term backups. Export needed documents before uninstalling; uninstalling with cleanup removes the plugin's private data.

## Format and fidelity limits

- **XLSX formulas:** the current plugin does not recalculate formulas. Cached values may be empty or stale. Check formula text, then recalculate and verify results in a spreadsheet application that supports calculation. A displayed value alone is not a verified result.
- **Complex objects and layout:** do not assume charts, pivot tables, embedded objects, or every advanced layout feature are editable. Rebuilding the whole file is not a safe workaround for unsupported operations. Test important files on a copy.
- **PDF:** fixed pages are not freely reflowing text documents. Scanned pages have no automatic OCR; no extracted text does not mean a blank page. Arrange recognition separately when needed, and check fonts, overlap, and overflow after edits.
- **Visual checks:** supported PPTX and PDF page rendering can be inspected. Current DOCX and XLSX tools do not supply native page images; structural reads are not visual layout verification. Check in the editor or target application.
- **Other formats:** export preserves the original format without implicit conversion. Renaming an extension is not conversion. Request a content rebuild and fresh checks for another format; do not expect a lossless conversion.

For material folders, see [Files and spaces](./files-and-spaces). For images and scanned material, see [Images](./images).
