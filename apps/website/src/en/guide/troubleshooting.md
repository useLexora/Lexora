---
title: "Troubleshooting and common questions"
description: "Diagnose model connections, pending questions, images, speech, local engines, tools, permissions, backups, and updates without blindly repeating actions."
---

# Troubleshooting

Keep the actual error from the task or settings page, identify the failure stage, and start with a small check. Do not begin by clearing app data, disabling every protection, or repeating external actions.

## The composer says “No models found”

1. Under **Settings → Model services**, confirm authentication and service enablement.
2. Enable at least one available **chat model**. Speech and image-generation models alone do not appear in the task's chat selector.
3. Select the model again in the task. If only one companion fails, check its selection.
4. For plugin models, check plugin enablement and prepared resources and engines.

Saving a key or syncing the catalog does not enable a model automatically. See [Connect a model](./settings-and-models).

## Authentication, quota, or connection errors

- **Authentication:** check the key's service, validity, and permissions, or reauthorize OAuth.
- **Quota:** check API credits and limits, not just a chat subscription.
- **Missing model:** check the model ID, purpose, protocol, and account access.
- **Timeout:** check the endpoint, proxy, and server state. External local servers must remain running.

Test a short message without attachments or tools, then restore conditions one at a time. See [Proxy settings](./app-settings#application-and-download-proxies).

## A task seems stuck

Distinguish these states:

| State | Next step |
| --- | --- |
| Running or waiting for resources | Inspect progress and tool records rather than repeatedly sending the same request |
| Awaiting approval | Review the approval card's target and scope |
| Waiting for your answer | Open the question card and submit choices or a custom answer; dismissing it is not an answer |
| Queued or paused message | Inspect the queue and send or add input as needed; stopping may leave messages paused |
| Failed or unknown outcome | Inspect the error and completed actions, then verify the actual result |

An answer supplies information, not tool authorization. Stopping or cancelling does not prove external actions were rolled back. Verify purchases, publishing, image generation, and similar outcomes before retrying.

## A file was not saved where expected

Check the task's space and working directory, inspect the full path in the tool record, and open the actual file. A model saying “saved” does not prove it exists.

Name the destination clearly, such as “Save as drafts/weekend-route.md in the current working directory.” See [Execution permissions](./permissions) for read-only, additional-directory, and sandbox issues. A missing path alone is not proof of a permission failure.

## Images cannot be read or generated

- Reading failure: check model vision support, image-reading settings, and whether the image is actually accessible.
- OCR returns text but not colors or states: use visual understanding, not transcription alone.
- Generation failure: check the generator, credentials, credits, reference support, and output path.
- Unknown outcome or incomplete saving: inspect existing outputs and service records; **do not blindly resubmit**.

A saved file still needs visual checking. See [Images](./images).

## Speech input or read-aloud is unavailable

Use microphone testing, a short transcription test, and a voice preview separately under **Settings → Voice** to distinguish capture, transcription, and playback.

Check microphone permission, input and output devices, the selected model, voice ID, credits, and networking. Check the engine for local sources. If no system voice exists, inspect OS speech components or choose a model source. Review recognized text after interruptions. See [Speech](./speech).

## A local model or engine will not start

1. Distinguish a local models plugin from an external compatible API. Inspect the plugin for the former and the external server for the latter.
2. Verify OS, architecture, engine version, model format, and backend support.
3. Check completed downloads, remaining files, valid resource permissions, RAM, VRAM, and disk space.
4. Test a smaller known-supported model or request and preserve the loading error.

An installed plugin does not mean engines and models are ready. Avoid repeatedly downloading large files or clearing resources to guess the cause. Success on another device does not establish support on yours. See [Local models](./local-models).

## Search or page reading fails

Check enabled sources, networking, rate limits, and the error. Distinguish script-rendered pages, login requirements, and missing remote-extraction configuration. Background rendering does not inherit login state; use interactive browsing when login is required. Do not treat an excerpt as a complete page. See [Search and web browsing](./web-browsing).

## An installed Skill or MCP tool is unavailable

For Skills, check scope, enablement, same-name overrides, and the companion's capability selection. Refresh after changes and reselect changed content.

For MCP, check enablement and an actual connection. Cached tool lists and an earlier successful test do not establish current task availability. Code-orchestration-only connections also need the corresponding Runtime capability. See [Skills and MCP](./skills-and-mcp).

## A plugin is installed but does not open or change

Under **Plugins → Installed**, check enablement, active version, and errors. A newer version may be installed without activation. The entry point may be a command, tool, or theme, not a separate page.

For a plugin you created, return to its original task with the exact error and reproduction steps. See [Plugins](./plugins) for installation and permissions.

## An automation did not run on time

1. Check enablement, pause state, next run time, and active dates.
2. Confirm the computer was awake and Lexora had not fully exited.
3. Inspect records to distinguish no trigger, failure, and completion.
4. Check the space, fixed model, tools, and prior grants. Background runs cannot wait for approval and fail when it is required.
5. After fixing the cause, use **Run now** without changing the schedule.

See [Automations](./automations).

## Backup, restoration, or migration did not complete

Keep the error and check space, directory permissions, and the password. Finish active tasks or pending directory operations. A successful cloud connection test is not a completed upload.

Do not clear the data directory. Keep backups and original data, and check the restoration scope. Restoring a plugin does not restore large model weights or engines. See [Data and backups](./data-and-backup).

## Update checks or installation fail

- Check the version, update channel, network, and proxies. A cached previous result is not a successful current check.
- Your platform or installation method may not support in-app downloads; follow the link to the official release page.
- If package details are missing or verification fails, repair the download rather than bypass verification.
- Automatic downloading does not install updates. Disabling automatic checks also pauses background downloads.
- Switching from Beta to Stable does not downgrade automatically. Keep backups and do not open newer data in an arbitrary older version.

See [App updates](./app-settings#stable-and-beta-updates).

## Still need help?

Report the issue on [GitHub Issues](https://github.com/useLexora/Lexora/issues) with the app version, OS and architecture, steps, expected and actual results, and the complete error. For model issues, include the service type and model ID, not credentials.

Inspect application logs under **Settings → Logs**. Remove accounts, credentials, private paths, and task or document content before sharing. Do not upload the entire data directory.
