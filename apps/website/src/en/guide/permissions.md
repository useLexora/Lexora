---
title: "Execution permissions: read-only, sandbox, and full access"
description: "Understand Lexora execution modes, file and tool approvals, and access changes. Learn the boundaries of read-only, sandbox, and full access before running a task."
---

# Execution permissions

Some tasks only read materials. Others edit files, run commands, or contact external services. Permission modes let you choose which operations can proceed and which need approval.

## Choose a mode for the current task

Open the permission selector in the task composer. For an unfamiliar directory or tool, manual approval lets you inspect each operation.

| Mode | Main behavior | Useful for |
| --- | --- | --- |
| Local read-only | Read files and run permitted read-only diagnostics without changing local files | Reading, analysis, and review |
| Manual approval | Changes, commands, and external interactions require approval | Reviewing operations individually |
| Smart approval | Allow safe queries and authorized operations under policy; ask for others | Ongoing work in familiar directories |
| Full access | Commands execute with your local permissions; some tools may still ask | Tasks whose broader access you understand |

Command isolation differs by platform. Follow the sandbox status and approval explanations in the composer. Local read-only restricts local file changes; it is not a guarantee against write effects in an external account.

::: warning What full access means
Commands may access local files, credentials, and networking with your permissions. This changes the execution boundary, not just the number of confirmation dialogs. Arbitrary commands are not guaranteed to remain inside the working directory.
:::

## Review an approval

Check three things:

1. **Action:** reading, editing, executing a command, or contacting a service?
2. **Target:** is the path, parameter, or service address what you expected?
3. **Scope:** is this one operation, or does it involve additional directories or broader access?

If you asked for travel notes but the operation targets another project, reject it or stop and clarify the scope. After rejection, explain the narrower requirement so the companion can try a suitable approach.

## Directory access and context

Choose the task or space's working directory to work with those files. Approve other locations as needed through the interface.

Quoting text does not grant access to its entire source directory. A companion's tool selection or Skill instructions cannot bypass task permission limits.

## Changing permissions

Adjust permissions for the next step, such as reading first and then allowing a saved result. Lowering permissions or stopping a task does not undo file changes or external actions already performed.

To set a default for new tasks, open **Settings → Runtime**. Try the behavior on a few tasks before changing the default.

Continue with [Data and backups](./data-and-backup) to understand storage and recovery.
