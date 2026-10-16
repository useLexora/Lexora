---
title: "Meet Lexora: a personal desktop AI agent"
description: "Meet Lexora, an open-source desktop AI agent. Bring your own models, continue tasks across sessions, and extend your workflow with companions, plugins, Skills, and MCP."
---

# Meet Lexora

Lexora is a personal AI agent that evolves through hands-on work on your desktop. Beyond coding, it helps you organize research, refine creative projects, and plan everyday activities. Tell it what you want to accomplish, and it keeps working toward that goal, making words the starting point for work, creativity, and everyday life.

This guide is for people using Lexora for the first time. You do not need to know how to code. Bring a small goal and start with [your first task](./quick-start).

## Choose where to begin

If you have not connected a model, follow the getting-started sequence first. If you already use Lexora, jump to the operation you need.

| What you want to do | Start here |
| --- | --- |
| Install Lexora and finish a small task | [Your first task](./quick-start) |
| Connect a provider or local model service | [Connect a model](./settings-and-models) |
| Add instructions, quote content, or try a branch | [Tasks and conversations](./ai-chat) |
| Organize local materials and split the workspace | [Files and spaces](./files-and-spaces) |
| Bring in other companions and recruit NPCs | [Companions and collaboration](./companions) |
| Install a plugin or make your own tool | [Using and creating plugins](./plugins) |
| Add methods, external tools, or recurring work | [Skills and MCP](./skills-and-mcp) · [Automations](./automations) |
| Choose permissions, back up data, or resolve a problem | [Execution permissions](./permissions) · [Data and backups](./data-and-backup) · [Troubleshooting](./troubleshooting) |

## Three concepts to know

A **task** is where work toward one goal continues. It can contain multiple conversation turns, tool operations, references, and files. For a weekend route, you might choose places today and return tomorrow to add transport details in the same task.

A **space** groups related tasks and connects them to working directories. A travel space might contain separate tasks for a route, packing list, and travel journal. The directory stores files; the space organizes the work around them.

A **companion** is an AI role that handles work. Lexora is the default companion. You can configure other companions with names, instructions, models, and capabilities. A model is the service a companion uses; changing it does not require starting your workspace over.

<GuideImage src="/landing/screenshots/workspace-en.webp" alt="Two task conversations next to a local file preview" caption="Keep tasks and materials together. Each task retains its own conversation and composer." :width="1504" :height="1018" />

## How work continues

Describe the goal, then provide the materials. Lexora responds or uses tools to read files, edit content, and perform operations. You can inspect progress, add requirements, quote a passage for revision, or stop execution.

Conversations and execution records remain in the task. Return to build on that progress. Save a useful method as a Skill, or turn a recurring need into a plugin.

::: tip Leave a useful handoff
Before finishing for the day, ask: “Summarize what is done, where the results are saved, and what remains.” It makes returning to the task easier.
:::

## What you need

Install Lexora and connect at least one usable model. No Lexora account is required. Model credits and charges come from your chosen provider.

Tasks, companions, and settings are stored locally. When you use an online model, the relevant conversation and file context goes to your configured service. See [data and backups](./data-and-backup) for details.

::: details Curious about what runs underneath?
Vue and Electron provide the desktop workspace, while an independent TypeScript runtime hosts the local agent. Pi provides the agent loop, and Rust handles native capabilities. Lexora organizes tasks, context, permissions, and outputs. Explore the [source on GitHub](https://github.com/useLexora/Lexora) for implementation details.
:::

Ready? [Complete your first task](./quick-start).
