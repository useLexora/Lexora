---
title: "Skills and MCP: reusable methods and external tools"
description: "Install and preview Skills in Lexora, choose global or space scope, and connect MCP servers. Test connections, enable tools, and understand discovery and permissions."
---

# Skills and MCP

Skills bring working methods. MCP connects external tools. Use them together when useful: a research Skill can define the output format while an MCP tool queries your information service.

## Choose the right extension

| What you need | Use |
| --- | --- |
| Repeatable steps, writing rules, or supporting resources | A Skill |
| Queries or operations provided by an existing service | MCP |
| A workspace page, panel, theme, or specialized interaction | A [plugin](./plugins) |

## Install a Skill

Open **Settings → Skills**:

1. Choose the global scope, or choose a space.
2. Select **Install Skill**, then a local folder or public GitHub repository.
3. For GitHub, optionally specify a branch or tag and subdirectory.
4. Preview the discovered Skills. Read their names, descriptions, sources, and files.
5. Select the entries you need and confirm installation.

Installation copies resource files; it does not execute their scripts at installation time. Installed Skills become available in subsequent runs.

### Global or space-specific?

Put broadly useful methods in the global scope. Install project-specific methods in a space. A working directory can also supply Skills. For duplicate names, inspect source and override hints to see which version is effective.

## Use a Skill in a task

Type `/skills` and select from the current task's available Skills, then add a goal and materials. You can also configure a companion's available Skills to match its responsibilities.

For example, after selecting a research-organizing method:

> Organize the travel notes in this working directory. Preserve sources, write a route and a list of details to confirm, and save them under drafts.

A Skill provides a method, not additional file or tool permissions. If updating or removing a Skill is blocked because it is in use, wait for the relevant run to finish.

### Save your own method

Choose **Create Skill**, or describe a recurring process in a task and ask Lexora to make it reusable. Explain inputs, steps, output format, and common mistakes, then verify it on a small set of materials.

## Add an MCP connection

Get connection instructions from the tool provider, then open **Settings → MCP**.

| Connection | Configuration | Where it runs |
| --- | --- | --- |
| Local command (Stdio) | Command, arguments, and required environment variables | On your computer; required programs must be installed |
| Remote service (HTTP) | URL and any required headers or Bearer token | Requests go to that service |

1. Choose **Add connection**, select the type, and enter the configuration.
2. Saved connections are disabled by default. Use **Test connection** first. Testing or enabling a local command may ask you to confirm execution.
3. Inspect the tool list for the capabilities you need.
4. Enable the connection, return to a task, and try a small, specific request.

::: tip A successful test does not enable a connection
A disabled connection can be tested and its tool list cached. Tasks can use it only after it is enabled and connected. A cached list does not prove the service is currently reachable.
:::

### Import existing JSON

Choose **Import JSON** and paste a configuration containing `mcpServers`. Each connection must specify `command` or `url`. Review the preview before saving. Importing does not automatically start connections.

### How tools are exposed

Start with the default on-demand discovery. Expand this explanation when you need the advanced options.

::: details Discovery, direct tools, and code orchestration
- **On-demand discovery:** load tool definitions through search when needed.
- **Direct exposure:** include definitions in each turn, increasing context use when many tools are present.
- **Code orchestration only:** discover and call tools through Codemode; enable that capability in Runtime settings first.
- **Hidden:** keep the configuration without exposing tools to the model or scripts.
:::

## Connected, but a companion still cannot use the tool?

Check connection enablement, exposure mode, the companion's tool selection, and task permissions. Use `/mcp` to inspect the connection and reconnect.

Disabling MCP applies to all tasks, prevents new calls, and retains configuration, credentials, and cached tools. Check whether another task still needs it before disabling.

For work that should recur on a schedule, continue with [Automations](./automations).
