---
title: "Troubleshooting and common questions"
description: "Troubleshoot Lexora model connections, file access, tools, automations, plugins, and backups. Check likely causes and gather useful details before reporting an issue."
---

# Troubleshooting

Start with the actual error in the task or settings page. Most problems can be narrowed down through model connections, execution status, paths, and extension enablement.

## The composer says “No models found”

1. Open **Settings → Model services** and check that a service exists.
2. Complete authentication and enable at least one available model.
3. Enable the service and select the model in the task again.
4. If only one companion fails, check its model selection in this task.

See [Connect a model](./settings-and-models). Saving an API key or syncing the catalog does not automatically mean a model is enabled.

## Authentication, quota, or connection errors

- **Authentication:** check that the key belongs to this service and is valid, or reauthorize OAuth.
- **Balance or quota:** check API credits in the provider's console, not just a chat subscription.
- **Unavailable model:** verify the model ID, account access, and the actual supported API.
- **Timeout or unreachable service:** check the endpoint, network, and proxy. A local model server must remain running.

Try a short message without attachments or tools. Once it works, add the original task's conditions back one at a time.

## A task seems stuck

Check whether it is running, awaiting approval, or waiting to send a queued message. These need different responses.

Resolve approval cards, inspect the queue, or repair a failed model or tool connection. If you stop the task, inspect completed actions before continuing so that you do not repeat an external action unnecessarily.

## A file was not saved where expected

Check the task's space and working directory, then expand the file operation record to inspect its path. Verify the actual file even when the model says it saved one.

Name the destination clearly: “Save as drafts/weekend-route.md in the current working directory.” If the task is local read-only, adjust [Execution permissions](./permissions) as needed.

## An installed Skill or MCP tool is unavailable

For Skills, check scope, enablement, same-name overrides, and the companion's capability selection. Refresh after editing files. If content has changed, select the Skill again before sending.

For MCP, check that the connection is enabled and connected. Cached tools do not prove current connectivity. A successful test of a disabled connection does not make it available to tasks. Code-orchestration-only connections also require the corresponding Runtime capability.

See [Skills and MCP](./skills-and-mcp) for the full steps.

## A plugin is installed but does not open or change

Check its enabled state, active version, and errors under **Plugins → Installed**. A new version may be installed without being activated. Its entry point might be a command, tool, or theme rather than a separate page.

For your own plugin, return to the creation task with the exact error, reproduction steps, and current behavior. Specific feedback is more useful than “It does not work.”

## An automation did not run on time

1. Confirm it is enabled and not paused, then check its next execution time and active date range.
2. Check that the computer was awake and Lexora had not fully exited.
3. Read run history to distinguish no trigger, failure, waiting for approval, and completion.
4. Verify the linked space, fixed model, and required tools are still available.
5. Use **Run now** to verify the repair without changing the schedule.

See [Automations](./automations) for details.

## Backup, restoration, or migration did not complete

Keep the error message and check free space, permissions, and the backup password. Finish active tasks or pending directory operations before retrying. A successful cloud connection test is not a completed upload; inspect backup status.

Do not clear the data directory just to retry. Keep backups and the original data until the app is working. See [Data and backups](./data-and-backup).

## Still need help?

Report the issue on [GitHub Issues](https://github.com/useLexora/Lexora/issues). Include:

- Lexora version, operating system, and architecture.
- The starting page and steps you followed.
- Expected and actual results, plus the complete error message.
- A useful screenshot or relevant log excerpt.

View application logs under **Settings → Logs**. Before sharing, remove API keys, account information, private paths, and private task content. Do not upload your entire data directory.
