---
title: "Execution permissions: approvals, directories, and sandbox"
description: "Understand four permission modes, one-time and turn-scoped approvals, persistent directory access, full access, and Windows sandbox limitations."
---

# Execution permissions

Permission modes determine how tools are allowed to run, not the scope of your task. Even with automatic approval, companions should only do what you asked. Text in websites, files, or plugins cannot authorize actions for you.

## Choose a mode for the current task

Open the permission selector in the task composer. Start with manual approval for unfamiliar tools or directories.

| Mode | Main behavior | Useful for |
| --- | --- | --- |
| Local read-only | Read ordinary files; reject file writes and deletion; run commands with a read-only policy | Reading, analysis, review |
| Manual approval | Allowed changes, deletion, commands, networking, and interactions still need approval | Reviewing operations individually |
| Smart approval | Allow ordinary reads and authorized operations under policy; ask or deny others | Working in familiar directories |
| Full access | Automatically approve tool operations; commands run as your host user without the command sandbox | Work requiring broader access that you understand |

Local read-only does not make everything read-only. Managed network and web interactions can still proceed with approval; actions in external accounts differ from local file writes. Windows commands also have the limitations below.

::: warning Full access is more than fewer dialogs
Tools can access local files, credentials, and networking. Commands are not confined to the working directory and have no command-sandbox filesystem or network isolation. Managed network routes still honor explicit domain denials, and role limits and target checks remain. These do not intercept all traffic from arbitrary host commands, override OS permissions, or expand your task instructions.
:::

## Review an approval

Check the **action, target, and scope**. Read or modify? Which directory, website, or service? This call only, or reusable approval within this turn?

Depending on the card, you can:

- **Allow once:** approve the current call only.
- **Same operation, current source, or this turn:** reuse approval within the selected scope for the current execution turn; it expires on completion or cancellation.
- **Allow and add to additional directories:** explicitly save directory access for its owning space or task.
- **Save a domain rule:** persist a global rule as described by the interface, affecting other spaces and tasks.

Not every request offers every option. Turn-scoped approval does not create persistent directory access or bypass read-only denials, explicit domain denials, or target checks. Background automations cannot wait for approval: an operation requiring it fails rather than waiting for your answer.

## Directory access and context

Ordinary file reads do not need approval for each directory and are not limited to the working directory. Known credential locations and private application data have additional protection. In controlled modes, sensitive reads require confirmation and sensitive writes are denied.

The working directory sets the default location and base writable scope. Writing elsewhere may need approval; write access includes creating, modifying, and deleting files. Temporary command-directory access applies only to the current turn and relevant execution route, not permanent access for other tools.

Saved additional directories belong to their space or standalone task. Removing access removes the binding, not the files. Quoting text, selecting a Skill, or enabling a tool does not grant access to its entire source directory.

## Sandbox status and deletion risks

Controlled modes use platform-specific isolation for commands and their children. Ordinary file tools, plugins, MCP, and browsers have separate boundaries; the command sandbox does not isolate the entire Agent.

Check the sandbox status in the composer. If components are unavailable, isolated commands are blocked rather than silently run on the host. Windows setup or repair is initiated through the interface and may require OS elevation. Cancelling does not switch to full access.

Smart approval does not confirm every deletion. Ordinary files in authorized directories may be deleted directly. Deletion is not guaranteed to use the recycle bin, and change previews are not backups.

## Changing permissions

You can switch modes during a run. Later operations are reassessed; requests and commands already started retain their starting boundaries. Switching invalidates old pending and reusable approvals but does not undo file changes or external actions.

Change the default for new tasks in [App settings](./app-settings#new-tasks-and-runtime). Existing tasks and drafts retain their settings. Stopping a task does not prove every external service has stopped. Check unknown outcomes before repeating an action.

## Windows native sandbox limitations

The Windows native sandbox prioritizes compatibility with local tools. It does not provide strong isolation between tasks or guarantee strict read-only behavior or complete credential isolation under arbitrary file permissions:

- Files writable by everyone may be modified outside authorized directories, including in read-only mode.
- Files with separately granted public read permissions inside sensitive directories may bypass the directory's read restriction.
- Files previously created by commands, or whose permissions commands changed, may remain writable after switching to read-only or revoking directory access.
- Local loopback connections can reach host services or services used by other tasks; this is not task-to-task network isolation.

System reachability is not authorization from you. Use an independent execution environment for untrusted programs or strict isolation needs. Validation on one platform does not establish behavior on another system or configuration.

Continue with [Data and backups](./data-and-backup) and [Search and web browsing](./web-browsing).
