---
title: "App settings: preferences, runtime, usage, and updates"
description: "Adjust everyday Lexora preferences, tool calling, usage, proxies, and stable or Beta updates without changing task authorization boundaries."
---

# App settings

Open **Settings** to adjust everyday preferences. See [Connect a model](./settings-and-models) for model setup and [Execution permissions](./permissions) for authorization boundaries.

## Everyday preferences

- **General and appearance:** choose the interface language, theme, fonts, and navigation layout.
- **Notifications:** configure task and subtask notifications and sounds. Send a test notification, then check system permissions and Do Not Disturb.
- **Shortcuts:** find commands, change bindings, or restore defaults. Resolve conflicts shown by the interface.
- **Desktop pet:** adjust visibility, always-on-top behavior, and docking. Hiding the pet is not the same as exiting the whole app.

System notifications, fonts, and window behavior also depend on your operating environment.

## New tasks and runtime

**Settings → Runtime** lets you choose default permissions for new tasks. **Existing tasks and unsent drafts retain their permissions** rather than changing with the default.

You can also choose whether messages sent during work are queued or added to the current work. Answers to pending questions are not affected by this default.

Automatic model retries handle temporary request errors; they do not mean every failed tool or external action can safely be replayed. Cache warming runs only when supported and expected to help, and may add usage. Turn it off if you do not need it.

## Tool calling mode

**Settings → Runtime → Tool calling mode** provides:

| Mode | Behavior |
| --- | --- |
| Mixed | Call tools directly for simple actions; use scripts for batching and filtering |
| Code orchestration | Ordinary tools must run through scripts, requiring reliable code generation |
| Off | Disable code orchestration and call available tools directly |

Changes apply from the next run. All modes retain task permissions. Older enabled configurations use Mixed, while disabled configurations stay off. Select Code orchestration explicitly if you need script-only calls.

Script concurrency affects waiting and resource use. Unlimited concurrency is not always faster: it may slow your computer. Lowering the limit does not interrupt scripts already running.

## Inspect usage

**Settings → Usage** shows calls initiated by Lexora, including task and model breakdowns. It does not scan other applications' history and is not a provider invoice.

Complete metering for independent image, speech, and other calls depends on what their sources report. No usage record does not mean free service. Provider balances, final charges, and quotas remain authoritative.

## Application and download proxies

**Settings → Network proxy** distinguishes:

- **Application connection:** system proxy, direct connection, or a custom proxy. Use supported HTTP, HTTPS, or SOCKS5 addresses without embedded credentials. Local addresses connect directly by default.
- **Download proxy:** GitHub app-update and plugin packages only, not other requests. Enabled proxies are tried in order, then the original URL.

Application connection changes take effect immediately; in-flight requests may need retrying. Download proxies do not automatically fix model APIs, model-weight sources, or networking in every external tool.

## Stable and Beta updates

Choose a channel in the app-update section of **Settings → About**:

- **Stable:** official releases only, suitable for everyday use.
- **Beta:** official releases plus Beta builds; these may be unstable or temporarily unavailable.

Automatic checking and downloading are separate. **Downloading does not install an update; you decide when to install.** Turning off automatic checks also pauses background automatic downloads. Manual checks and downloads remain available where supported by your platform and installation method.

[Back up important data](./data-and-backup) before joining Beta. Switching back to Stable does not downgrade automatically. Do not assume an older binary can read newer data. See [Troubleshooting](./troubleshooting#update-checks-or-installation-fail) for failed checks, missing packages, and blocked updates.
