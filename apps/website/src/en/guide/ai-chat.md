---
title: "Tasks and conversations: history, questions, quotes, and branches"
description: "Find earlier Lexora tasks, answer questions step by step, steer current work or queue messages, reference tasks and files, explore branches, and verify outputs."
---

# Tasks and conversations

A task holds work toward one ongoing goal. Add materials, inspect operations, and refine results in the same task. Start another when the topic or the context you need changes substantially.

## Find earlier tasks

Reopen work from task history and pin frequently used tasks. **Search tasks and spaces** matches:

- Tasks by title or their space's name.
- Spaces by name, primary working directory, or additional directory paths.
- Not the full text of every message. A phrase missing from results may still exist in the history.

Use a descriptive title such as “Weekend walking route.” Reopen it, check the existing conclusions and outputs, then say what should change.

## Make the first request actionable

Describe the goal, materials, and result. For example:

> Use the travel notes in this directory to make a two-day walking route. Keep sources for the places and list uncertain details separately. Save it as weekend-route.md without changing the original notes.

This gives the agent a goal, an input, a deliverable, and a boundary. You do not need every detail up front. Get something you can check, then refine it.

## Understand the current state

The conversation shows replies and execution progress. Expand tool records to inspect actions and results; open file outputs to preview them.

| State | What you can do |
| --- | --- |
| Running | Read progress, add instructions, or stop the run |
| Awaiting an answer | Expand the question card, fill in answers, and submit |
| Awaiting approval | Review the target, parameters, and requested scope |
| Message waiting to send | Inspect the queue, cancel it, or send immediately |
| Completed | Check the answer and files, then request revisions |
| Failed or cancelled | Read the last error and completed operations before continuing |

Stopping does not undo file writes or retract actions an external service already completed. Check changes and actual files before deciding how to recover.

## Add instructions during a run

Choose the default for messages sent during work under **Settings → Runtime → Execution behavior**:

| Mode | When it is handled | Example |
| --- | --- | --- |
| Steer current work (default) | At an execution boundary that can accept input | “Do not book anything; only compare routes” |
| Queue | After the target companion's current work ends | “After the route, make a packing list” |

A message waiting to send has not yet been handed to the companion. Cancel it if unnecessary, or, when available, use **Send now** to supplement its original target's current work. This neither undoes completed actions nor guarantees interruption of a running tool call. Changing the default does not alter existing queue entries.

If the target ended, settings changed, or a message is paused, read the displayed explanation. Accepted does not mean completed. Use the stop control when you need to stop, rather than relying only on a “stop” message.

## Answer questions one at a time

When a companion needs your input, an awaiting-answer entry appears near the task composer. This is different from a tool-permission approval.

1. Expand it and select one or several options, or enter text. Custom answers are available too.
2. For a group of questions, use the arrows to answer each one. Navigation neither submits nor clears answers.
3. Fill all required answers, then select **Submit answer**. Switch between separate requests and handle each individually.

A recommendation is only a suggestion, not a selected answer. **Decline** closes the entire request; it neither skips just one question nor implies consent. Collapsing preserves the current draft, but do not rely on drafts surviving an app exit.

Submitted answers appear in task history. If an answer was saved but not delivered, use the retry action instead of filling it in again. An ordinary message does not replace explicit answers to the request, and answering does not grant file, network, or tool permissions.

## Quote something specific

“Change this” works best when “this” is explicit. A quote brings selected text and its source into the composer:

1. Select text in a conversation, text file, or Markdown preview.
2. Use the context menu's quote action. File quotes can target a specific composer.
3. Check the quote card, add your request, and send.

<GuideImage src="/landing/screenshots/references-en.webp" alt="A passage from the city-walk notes quoted into a task composer" caption="Quote a passage, then explain what to preserve and what to change." :width="1176" :height="968" />

The [built-in browser](./web-browsing) also has an element picker for quoting webpage elements. Quotes preserve the content and source at that moment; locating the source later may differ if it has changed.

## Reference an existing task

Attach a task reference when you want to reuse another task's work. Explain which part matters: “Use the confirmed places from the route task to make a separate departure checklist.”

Choose the target through the composer's task-reference entry and check its name and relevant material before sending. The model can look up the referenced scope as needed. It has not necessarily read everything, and the reference does not automatically expose all past tasks or private NPC execution details.

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

Open delivered files from the reply's output entries and verify paths, content, and sources. Expand the corresponding execution records when you need errors or changes. If a reply says a file was saved, open the actual file rather than trusting a completed status. If there is no output card, ask for a verified save location.

For revisions, quote the problem area and explain what should stay. Office work also distinguishes the editing buffer, saving the original, and exporting a copy; see [Documents](./documents).

Read [Files and spaces](./files-and-spaces) to keep materials beside a task, or [Companions and collaboration](./companions) to bring in another role.
