---
title: "Data and backups: local storage, restore, and remote backups"
description: "Find out where Lexora stores data, create and restore backups, connect WebDAV or S3, and move the storage directory. Back up external working folders separately."
---

# Data and backups

Lexora open-sources its own code, not yours. Project files are handled locally, and tasks and settings are stored locally. Online models and external tools receive the content their calls need.

## What stays on your computer

| Content | Storage or destination |
| --- | --- |
| Tasks, conversations, companions, and settings | The current Lexora data directory |
| Managed workspace files | Inside the Lexora data directory |
| External working directories you choose | Their original disk location; adding a space does not upload the entire directory |
| API keys and login credentials | Encrypted locally using operating-system facilities |
| Online model requests | Context goes directly to the configured endpoint, without a Lexora cloud relay |
| External MCP and plugin calls | Required data goes to the connected or approved service |
| Cloud backups | Your WebDAV or S3 storage, only after you configure and enable it |

Context may contain conversation text, quotes, and code or file passages read by tools. Local-first does not mean no data leaves the computer when you use a remote model.

## Inspect the data directory and usage

Open **Settings → Data storage** to see the active directory, open its folder, and inspect usage by category.

<GuideImage src="/guide/images/storage-en.webp" alt="Data storage settings with directory, category usage, local backups, and cloud backup controls" caption="The overview covers the current data directory. Manage external working directories separately." :width="1016" :height="1228" />

The totals do not include every external working directory. Before cleaning up, distinguish task files, caches, logs, and backups. Do not manually delete an active database or configuration file.

## Create a local backup

1. Choose **Create backup** in Data storage.
2. Select the content to save: tasks and spaces, companions, models, Skills, plugins, settings, and other available categories.
3. If including credentials, enable that option and set a password of at least eight characters.
4. After completion, open **View backups** and confirm the new entry appears.

Managed workspace files include files inside the Lexora data directory, not entire external project folders. Back up external originals, repositories, and other materials separately.

::: info Credentials and passwords
A backup without credentials can still preserve service configuration; enter keys again after restoring. The backup password cannot be recovered, so keep it separately. OAuth requires signing in again after restoration.
:::

You can adjust the local backup limit. Older copies are removed according to the settings shown in the app. This limit does not automatically remove cloud backups or exported copies.

## Restore a backup

1. Save important current work and create a backup of the current state if needed.
2. Select a backup under **View backups**, or use **Import backup** to choose a file.
3. Choose what to restore and enter the password if restoring credentials.
4. Confirm **Restart and restore**. After restart, inspect tasks, settings, and files before re-enabling extensions or schedules.

Restoration replaces matching records or files while keeping other content. The app preserves a recovery copy of the previous data. Restored automations, plugins, and Skills need re-enabling; OAuth needs authorization again.

## Use your own cloud backup storage

Enable cloud backup in Data storage, select WebDAV or S3-compatible storage, and configure the endpoint, backup directory, and credentials.

Use **Test connection** to verify read and write access. Then choose content and frequency, and select **Save and back up**. Check the actual backup status afterwards, not only the connection test.

Cloud backups are saved copies, not real-time collaboration or live two-way synchronization of external folders. Automatic backups require Lexora to keep running.

## Move the data directory

Use **Data directory → Change location**, choose the destination, and confirm the restart and move. Choose an empty directory or a previous location of this data, with enough free space.

Do not move folders manually during migration. If it fails, check permissions, free space, and the error. Keep the original location intact until the app is working correctly.

For recovery or migration problems, see [Troubleshooting](./troubleshooting).
