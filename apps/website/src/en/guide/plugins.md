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
2. Review the name, version, source, and requested permissions.
3. Confirm installation and check its state under **Installed**.
4. Use the page, panel, command, or tool the plugin provides.

If the marketplace cannot refresh, try later or install a local package. Installation adds the plugin to your workspace; some plugins still need you to choose files, connect services, or complete their settings.

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
| Task events, scheduled commands, and notifications | Run follow-up actions at useful moments |
| Settings and private storage | Remember a plugin's configuration and state |

The plugin must implement these capabilities and declare the corresponding permissions. Installing one does not grant arbitrary file or system-command access. Scheduled plugin actions also require Lexora to remain running.

## Update, disable, or uninstall

Manage plugins under **Installed**. Disable one when you only want to stop using it temporarily. When installing an update, check the version-switching option and which version is active.

Ordinary uninstall retains settings, private data, and view positions for reinstallation. **Uninstall and clear data** removes that content, so confirm that you no longer need it.

Keep the creation task and source for future improvements or sharing. An installed plugin should not be your only source backup.

## When something goes wrong

- **No installable package:** ask the companion to check the build and deliver the package and source location.
- **Cannot find an entry point:** confirm the plugin is enabled, then check whether it provides a page, command, tool, or theme.
- **Version incompatibility:** check the Lexora version and plugin requirements. Changing a version number does not resolve compatibility.
- **Missing permission or file:** inspect the plugin settings and grants, then take the specific error back to the creation task.

For reusable methods or existing external services, continue with [Skills and MCP](./skills-and-mcp).
