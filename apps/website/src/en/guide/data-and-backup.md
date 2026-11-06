---
title: "Data and backups: storage, scope, and restoration"
description: "Understand data destinations, local and cloud backup scope, and the limits for plugins, local model resources, external files, and restoration."
---

# Data and backups

Lexora open-sources its own code, not yours. Tasks and settings stay on your computer. Online models and external tools receive the content their calls require.

## What stays on your computer

| Content | Storage or destination |
| --- | --- |
| Tasks, conversations, companions, and settings | The active Lexora data directory |
| Managed workspace files | Inside the Lexora data directory |
| External working directories | Their original locations; adding a space does not upload the whole folder |
| API keys and login credentials | Saved locally through dedicated credential fields using OS encryption facilities |
| Plugin packages, configuration, and private files | App-managed plugin storage; authorized external references remain at their original locations |
| Plugin-managed models and engines | A separate local inference-resource area, not ordinary plugin-file backup |
| External model servers | Files and data managed by those services |
| Online models, independent image reading, speech, and OCR | Required text, images, or audio goes to the selected service |
| MCP, web, and external plugin calls | Required data goes to the corresponding service; see [Web browsing](./web-browsing) for remote extraction |
| Cloud backups | Your configured WebDAV or S3 storage, after you enable it |

Model context can include conversations, quotes, and passages read from files. Local-first does not mean everything stays offline or that only the current chat model receives content.

::: info Not all configuration is encrypted credentials
Dedicated API-key storage differs from ordinary configuration. Custom headers, task content, or plugin files may contain secrets you entered. A backup without the credentials option is not automatically safe to publish.
:::

## Inspect the data directory and usage

Open **Settings → Data storage** to inspect the active directory, open its folder, and review usage by category.

<GuideImage src="/guide/images/storage-en.webp" alt="Data storage settings with directory, category usage, local backups, and cloud backup controls" caption="The overview covers the current data directory. Manage external working directories separately." :width="1016" :height="1228" />

Totals do not include every external directory. Distinguish work files, inference resources, caches, logs, and backups before cleanup. Do not manually delete active databases, plugin resources, or model files.

## Create a local backup

1. Choose **Create backup** and select tasks and spaces, managed workspaces, companions, model services, connections, Skills, plugins, automations, or settings.
2. To include credentials, enable the option and set a password of at least eight characters.
3. Wait for completion, then open **View backups** to confirm the new entry and selected scope.

### What is included

| Selection or resource | Scope |
| --- | --- |
| Tasks and spaces | Related records and task-managed materials; managed workspace files have a separate selection |
| Managed workspace files | App-managed working directories, not entire external projects |
| Plugins | Packages, configuration, state, and supported plugin-owned files |
| Local model weights and engines | **Managed inference resources are not part of the plugin backup above**; preserve or prepare them separately |
| Plugin-referenced external files, external model servers, and external working directories | Not included merely because they are referenced |

A backup saves selected content, not a disk image or complete runtime environment. For local model migration, record sources, versions, quantization, engines, and loading settings, and preserve needed files separately. Restored plugin settings do not prove that inference resources were restored.

::: info Credentials and passwords
A backup without credentials can preserve service configuration; enter credentials again after restoring. Passwords cannot be recovered, so keep them separately. OAuth requires signing in again after restoration.
:::

Adjust the local backup retention limit in settings. Excess copies are cleaned up under that rule; cloud backups and exported copies are not automatically deleted with them.

## Restore a backup

1. Save current work and back up the current state if needed.
2. Choose a backup under **View backups**, or select a file with **Import backup**.
3. Select the restoration scope and enter the password when restoring credentials.
4. Confirm **Restart and restore**, then inspect tasks, files, and settings.

Restoration replaces matching records or same-name files, keeps other content, and preserves a pre-restore recovery copy. Restored automations, plugins, and Skills need re-enabling; OAuth needs authorization again. Plugin external-resource grants may need selecting again. Check local models and engines separately: an available plugin page does not prove restoration is complete.

## Use your own cloud backup storage

Enable cloud backup in Data storage. Choose WebDAV or S3-compatible storage and enter its endpoint, backup directory, and credentials. **Test connection**, select content and frequency, choose **Save and back up**, then inspect the actual backup status.

Cloud backups follow the selected scope; they do not additionally include model weights or external directories. They are copies, not real-time collaboration or two-way file synchronization. Automatic backups require Lexora to keep running.

## Move the data directory

Use **Data directory → Change location**, select a destination, and confirm the restart and move. Choose an empty directory or a previous location of this data, with enough space.

Moving app data differs from creating a selective backup. External references do not become managed files. Do not move folders manually during migration. On failure, preserve the original location and backups, inspect permissions, space, and the error, and keep old data until the app works normally.

See [Troubleshooting](./troubleshooting#backup-restoration-or-migration-did-not-complete).
