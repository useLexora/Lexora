---
title: "Plugins: install, create, and iterate"
description: "Install and manage Lexora plugins, or create a focus timer through conversation. Learn how plugins extend the interface, tools, and task workflows, then update or remove them."
---

# Using and creating plugins

A plugin turns a temporary need into something you can use again. It might be a player, a work panel, a theme, or a specialized tool a companion can call repeatedly.

This chapter starts with installation, then walks through making a plugin from a request. You do not need to learn the plugin API first.

## Install an existing plugin

Open **Plugins**. Browse the **Marketplace**, or install a local package you already have.

1. Choose a marketplace plugin and start installation, or select **Install package** from the installation menu.
2. Wait for **Verifying plugin** to finish. Review the name, version, source, permissions, and default file openers.
3. Confirm installation and check its state under **Installed**. If it fails, inspect the error; a finished download is not a successful installation.
4. Use the page, panel, command, or tool the plugin provides.

If the marketplace cannot refresh, try later or install a local package. Installation adds the plugin to your workspace; some plugins still need you to choose files, connect services, or complete their settings.

### Verification and risk confirmation

Marketplace installation checks package size, digest, and manifest. If the contents differ from the catalog, do not treat it as a routine update. Verify the source and actual permissions; cancel and check with the publisher when uncertain. Select **Install anyway** only after explicitly acknowledging the risk.

Accepting the risk is not successful verification and does not bypass compatibility, identity, or package-structure checks. A matching digest confirms agreement with the recorded content, not that the plugin is risk-free. Install only needed plugins from sources you trust.

## Start with a small idea

Describe the core purpose and how you want to use it. A focused first version is easier to check:

```text
Make a reading timer plugin.
Show the remaining time in a workspace panel, with Start, Pause,
and Reset buttons. Default to 25 minutes and show a completion message.
Finish this one flow first. Deliver the source and an installable package.
```

This is a request you can try; the result depends on the model and execution. Begin with one complete flow before adding networking, complex data, or automation.

## From generation to something you can use

1. **Describe it:** explain the entry point, behavior, and expected result.
2. **Build and check:** the companion writes source in the task's working directory, builds a package, and checks problems.
3. **Confirm installation:** review the installation request and permissions.
4. **Use it:** open the plugin, try its controls, and bring issues back to the original task.

For a timer, test Start, Pause, Reset, and completion rather than only checking that buttons exist. Give specific feedback: “The digits keep changing while paused. Fix that and keep the current layout.”

<GuideImage src="/landing/screenshots/plugin-moonlight.webp" alt="Moonlight Record delivery and player panel in a Chinese task" caption="Moonlight Record: create a player, then refine its expanded and mini modes in the same task. Chinese interface." :width="1152" :height="680" />

## What plugins can extend

| Capability | How you might use it |
| --- | --- |
| Pages, split panels, and widgets | Put tools where they fit alongside your tasks |
| Themes and window effects | Adapt the workspace's appearance |
| Menus and input commands | Add entry points for frequent operations |
| Agent instructions and tools | Give companions specialized analysis or conversion tools |
| Configured models and approved local files | Process selected materials and return results to the task |
| File editors and selection quotes | For example, use an installable Office plugin for [documents and spreadsheets](./documents) |
| Task events, scheduled commands, and notifications | Run follow-up actions at useful moments |
| Settings and private storage | Remember a plugin's configuration and state |

The plugin must implement these capabilities and declare the corresponding permissions. Browser backgrounds, views, and Workers access files and commands through controlled interfaces; installation does not give those contexts arbitrary system access. Scheduled plugin actions also require Lexora to remain running.

::: warning Native inference has a different boundary
Local model plugins can include native inference entry points. On Windows and macOS, supervised native processes run with the current account's permissions, without a filesystem or network sandbox. Install only trusted sources and check their [platform and resource limits](./local-models#platform-and-resource-limits). Browser-view isolation does not apply to all plugin code.
:::

## Update, disable, or uninstall

Manage plugins under **Installed**. When a card shows **Update available**, open the new-version review directly. The marketplace also provides an update entry. Read incompatibility notices rather than bypassing version requirements.

The review defaults to switching after installation. You can defer switching and use **Update** later to apply the installed new version. Switching interrupts ongoing plugin operations, so save edits first. Restarting a plugin alone does not switch a pending version.

| Action | Effect |
| --- | --- |
| Disable | Stop using it while retaining the installation and data for later |
| Ordinary uninstall | Remove plugin code and revoke file access, but retain settings, private data, and view state; reinstallation still requires permission review |
| Uninstall and clear data | Also permanently remove the plugin's settings, private data, view state, and its MCP/NPC configuration and credentials; this cannot be undone |

Cleanup does not delete task content, exported outputs, or original user files referenced by the plugin. Export or back up needed plugin documents and data first; cleanup is not a routine reinstall step.

Keep the creation task and source for future improvements or sharing. An installed plugin should not be your only source backup.

## When something goes wrong

- **No installable package:** ask the companion to check the build and deliver the package and source location.
- **Cannot find an entry point:** confirm the plugin is enabled, then check whether it provides a page, command, tool, or theme.
- **Version incompatibility:** check the Lexora version and plugin requirements. Changing a version number does not resolve compatibility.
- **Missing permission or file:** inspect the plugin settings and grants, then take the specific error back to the creation task.

For reusable methods or existing external services, continue with [Skills and MCP](./skills-and-mcp).

## Continue developing

To write source yourself or understand a generated plugin, open [Plugin development](../plugins/). Start with an installable counter panel, then explore file editing, Agent tools, themes and distribution.
