---
title: "Tasks and conversations: quotes, queues, and branches"
description: "Create and continue Lexora tasks, quote files and web pages, queue follow-up messages, and explore conversation branches, slash commands, and execution records."
---

# Tasks and conversations

A task holds work toward one ongoing goal. Add materials, inspect operations, and refine results in the same task. Start another when the topic or the context you need changes substantially.

## Make the first request actionable

Describe the goal, materials, and result. For example:

> Use the travel notes in this directory to make a two-day walking route. Keep sources for the places and list uncertain details separately. Save it as weekend-route.md without changing the original notes.

This gives the agent a goal, an input, a deliverable, and a boundary. You do not need every detail up front. Get something you can check, then refine it.

## Understand the current state

The conversation shows replies and execution progress. Expand tool records to inspect actions and results; open file outputs to preview them.

| State | What you can do |
| --- | --- |
| Running | Read progress, add instructions, or stop the run |
| Awaiting approval | Review the target, parameters, and requested scope |
| Message waiting to send | Inspect the queue, cancel it, or send immediately |
| Completed | Check the answer and files, then request revisions |
| Failed or cancelled | Read the last error and completed operations before continuing |

Stopping does not undo file writes or retract actions an external service already completed. Check changes and actual files before deciding how to recover.

## Add instructions during a run

You can keep typing while the task works. A message marked as waiting to send has not yet executed. Cancel it if no longer needed, or use the immediate-send action to submit the new direction to the current run.

Queue a follow-up such as “After the route, make a packing list.” For a change of direction, be explicit: “Do not book anything yet; only compare routes.” Already completed actions still need separate attention.

## Quote something specific

“Change this” works best when “this” is explicit. A quote brings selected text and its source into the composer:

1. Select text in a conversation, text file, or Markdown preview.
2. Use the context menu's quote action. File quotes can target a specific composer.
3. Check the quote card, add your request, and send.

<GuideImage src="/landing/screenshots/references-en.webp" alt="A passage from the city-walk notes quoted into a task composer" caption="Quote a passage, then explain what to preserve and what to change." :width="1176" :height="968" />

The built-in browser also has an element picker for quoting webpage elements. Quotes preserve the content and source at that moment; locating the source later may differ if it has changed.

## Reference an existing task

Attach a task reference when you want to reuse another task's work. Explain which part matters: “Use the confirmed places from the route task to make a separate departure checklist.”

The model can look up the referenced context as needed. This does not mean it has already read everything, or that every past task becomes accessible.

## Try another direction with a branch

Create a branch from an existing conversation to keep one answer while exploring another. Use the branch canvas to inspect and continue different paths. This is useful for comparing article structures, design directions, or approaches.

::: info Conversation branches and disk files
Branches preserve conversation paths. Files on disk do not roll back with a branch. Ask for separate files when comparing versions, such as route-relaxed.md and route-compact.md.
:::

## Useful input commands

Type `/` in the composer to see available commands.

| Command | Purpose |
| --- | --- |
| `/skills` | Select a method from the current task's available Skills |
| `/mcp` | Check connections, enable or disable them, and reconnect |
| `/status` | Inspect the current conversation's status |
| `/compact` | Condense older context; optionally specify what to retain |
| `/review` | Review current work without modifying it and report risks |

Some commands require an existing conversation and cannot be combined with references, attachments, files, or a Skill. Follow the composer's availability hints.

## Check results, then continue

Verify paths, facts, and actual content. If the answer says a file was saved, open it. For revisions, quote the problem area and explain what should stay.

Read [Files and spaces](./files-and-spaces) to keep materials beside a task, or [Companions and collaboration](./companions) to bring in another role.
